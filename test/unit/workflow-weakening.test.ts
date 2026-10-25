import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli.js";
import { WEAKENING_SHAPES, check, name } from "../../src/checks/workflow-weakening.js";
import { SANCTION_KEY } from "../../src/weakened-tests.js";

const execFileAsync = promisify(execFile);

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "Test Committer",
  GIT_COMMITTER_EMAIL: "committer@example.com",
};

type Files = Record<string, string | null>;

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args as string[], { cwd, env: ENV });
  return stdout.trim();
}

async function commit(cwd: string, files: Files, message = "change"): Promise<string> {
  for (const [file, content] of Object.entries(files)) {
    if (content === null) await rm(join(cwd, file));
    else {
      await mkdir(dirname(join(cwd, file)), { recursive: true });
      await writeFile(join(cwd, file), content);
    }
  }
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "--quiet", "--allow-empty", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

const W = ".github/workflows/ci.yml";
const body = (...extra: string[]): string =>
  ["name: ci", "on: push", "jobs:", "  test:", "    runs-on: ubuntu-latest", "    steps:", "      - run: npm test", ...extra, ""].join("\n");

describe("RT-56 weakened workflows", () => {
  let repo: string;
  const saved = [...WEAKENING_SHAPES];

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "repo-truth-workflow-weakening-"));
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
  });

  afterEach(async () => {
    WEAKENING_SHAPES.splice(0, WEAKENING_SHAPES.length, ...saved);
    await rm(repo, { recursive: true, force: true });
  });

  async function run(
    before: Files,
    after: Files,
    extra: { message?: string; sanctions?: Record<string, string> } = {},
  ) {
    const base = await commit(repo, { "keep.txt": "keep\n", ...before }, "base");
    const candidate = await commit(repo, after, extra.message ?? "change");
    return check({ cwd: repo, base, candidate, sanctions: extra.sanctions });
  }

  it("exports its name and the three shapes", () => {
    expect(name).toBe("RT-56");
    expect(WEAKENING_SHAPES.map((s) => s.category)).toEqual(["continue-on-error", "if-false", "or-true"]);
  });

  it("reports a workflow deleted", async () => {
    const record = await run({ [W]: body() }, { [W]: null });
    expect(record.name).toBe("RT-56");
    expect(record.status).toBe("fail");
    expect(record.evidence).toHaveLength(1);
    expect(record.evidence[0]).toMatch(/^\.github\/workflows\/ci\.yml:.*workflow-removed/);
  });

  it("reports a workflow renamed out of the directory but not one renamed within it", async () => {
    const out = await run({ [W]: body() }, { [W]: null, "ci.yml": body() });
    expect(out.status).toBe("fail");
    expect(out.evidence[0]).toMatch(/workflow-removed/);
  });

  it("passes a workflow renamed within the directory", async () => {
    const record = await run({ [W]: body() }, { [W]: null, ".github/workflows/build.yaml": body() });
    expect(record.status).toBe("pass");
    expect(record.evidence).toEqual(["no workflow weakened"]);
  });

  const cases: [string, string, string][] = [
    ["continue-on-error", "    continue-on-error: true", "continue-on-error"],
    ["continue-on-error", "      - continue-on-error: true # later", "continue-on-error"],
    ["continue-on-error", "    continue-on-error: ${{ true }}", "continue-on-error"],
    ["if-false", "    if: false", "if-false"],
    ["if-false", "      - if: false # off", "if-false"],
    ["if-false", "    if: ${{ false }}", "if-false"],
    ["or-true", "      - run: npm audit || true # advisories", "or-true"],
    ["or-true", "        npm run lint || :", "or-true"],
    ["or-true", "        npm run lint ||   exit 0", "or-true"],
  ];

  for (const [label, line, category] of cases) {
    it(`reports ${label} \`${line.trim()}\` in a changed file and an added one`, async () => {
      const changed = await run({ [W]: body() }, { [W]: body(line) });
      expect(changed.status).toBe("fail");
      expect(changed.evidence).toHaveLength(1);
      expect(changed.evidence[0]).toContain(category);
      expect(changed.evidence[0]).toContain(`"${line.trim()}"`);
      await rm(join(repo, ".git"), { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
      await mkdir(repo, { recursive: true });
      await git(repo, ["init", "--quiet", "--initial-branch=main"]);
      const added = await run({}, { ".github/workflows/new.yaml": body(line) });
      expect(added.status).toBe("fail");
      expect(added.evidence[0]).toMatch(/^\.github\/workflows\/new\.yaml:/);
    });
  }

  it("is quiet for a moved line, a re-indented line and a weakening line left as it was", async () => {
    const weak = "    continue-on-error: true";
    const moved = await run({ [W]: body(weak, "    if: false") }, { [W]: body("    if: false", weak) });
    expect(moved.status).toBe("pass");
    await commit(repo, { [W]: body("        continue-on-error: true", "    if: false") });
    const base = await git(repo, ["rev-parse", "HEAD~1"]);
    const reindented = await check({ cwd: repo, base, candidate: "HEAD" });
    expect(reindented.status).toBe("pass");
    const same = await check({ cwd: repo, base: "HEAD", candidate: "HEAD" });
    expect(same.status).toBe("pass");
  });

  it("reports a weakening line held more often than before", async () => {
    const weak = "    continue-on-error: true";
    const record = await run({ [W]: body(weak) }, { [W]: body(weak, weak) });
    expect(record.status).toBe("fail");
    expect(record.evidence).toHaveLength(1);
  });

  it("ignores continue-on-error false and an if with another condition", async () => {
    const record = await run({ [W]: body() }, { [W]: body("    continue-on-error: false", "    if: github.ref == 'x'", "      - run: a || b") });
    expect(record.status).toBe("pass");
  });

  it("ignores the same lines outside the directory, in a subdirectory and with another suffix", async () => {
    const weak = body("    continue-on-error: true", "    if: false", "      - run: x || true");
    const record = await run(
      {},
      { "ci.yml": weak, ".github/ci.yml": weak, ".github/workflows/sub/ci.yml": weak, ".github/workflows/ci.txt": weak },
    );
    expect(record.status).toBe("pass");
  });

  it("reads the candidate, not the working tree", async () => {
    const base = await commit(repo, { [W]: body() }, "base");
    const candidate = await commit(repo, { [W]: body() }, "same");
    await writeFile(join(repo, W), body("    continue-on-error: true"));
    expect((await check({ cwd: repo, base, candidate })).status).toBe("pass");
    await git(repo, ["checkout", "--quiet", "--", W]);
    await rm(join(repo, W));
    expect((await check({ cwd: repo, base, candidate })).status).toBe("pass");
  });

  it("applies an entry appended to WEAKENING_SHAPES", async () => {
    WEAKENING_SHAPES.push({ category: "skip-all", pattern: /^- run: exit 0$/ });
    const record = await run({ [W]: body() }, { [W]: body("- run: exit 0") });
    expect(record.status).toBe("fail");
    expect(record.evidence[0]).toContain("skip-all");
  });

  it("is sanctioned by a commit message line or by the caller", async () => {
    const line = "    continue-on-error: true";
    const byLine = await run({ [W]: body() }, { [W]: body(line) }, { message: `x\n\n${SANCTION_KEY}: continue-on-error:${W} flaky upstream` });
    expect(byLine.status).toBe("pass");
    expect(byLine.evidence[0]).toMatch(/sanctioned.*flaky upstream/);
  });

  it("is sanctioned by the caller's sanctions", async () => {
    const record = await run({ [W]: body() }, { [W]: null }, { sanctions: { [`workflow-removed:${W}`]: "retired" } });
    expect(record.status).toBe("pass");
    expect(record.evidence[0]).toMatch(/sanctioned.*retired/);
  });

  it("does not read a sanction from a file", async () => {
    const record = await run(
      { [W]: body() },
      { [W]: body("    if: false"), "NOTES.md": `${SANCTION_KEY}: if-false:${W} because\n` },
    );
    expect(record.status).toBe("fail");
  });

  it("escapes characters outside printable ASCII", async () => {
    const record = await run({ [W]: body() }, { [W]: body("      - run: echo é || true") });
    expect(record.evidence[0]).toContain("\\u{00e9}");
  });

  it("fails on a revision that names no commit", async () => {
    await commit(repo, { "keep.txt": "keep\n" }, "base");
    const record = await check({ cwd: repo, base: "no-such-revision", candidate: "HEAD" });
    expect(record.status).toBe("fail");
    expect(record.evidence[0]).toContain("no-such-revision");
  });

  it("fails rather than throws when git fails", async () => {
    const record = await check({ cwd: join(repo, "missing"), base: "HEAD", candidate: "HEAD" });
    expect(record.status).toBe("fail");
    expect(record.evidence.length).toBeGreaterThan(0);
  });

  it("is the only record `repo-truth check --check RT-56` prints", async () => {
    await commit(repo, { [W]: body() }, "base");
    await commit(repo, { [W]: null }, "change");
    let stdout = "";
    const code = await main(["check", "--check", "RT-56", "--no-fetch", "--base", "HEAD~1", "--candidate", "main", "--format", "json"], {
      cwd: repo,
      stdout: (t) => void (stdout += t),
      stderr: () => undefined,
    });
    expect(code).not.toBe(0);
    const parsed = JSON.parse(stdout) as unknown;
    const records = (Array.isArray(parsed) ? parsed : (parsed as { records: unknown[] }).records) as { name: string }[];
    expect(records.map((r) => r.name)).toEqual(["RT-56"]);
  });

  describe("suite strength", () => {
    const WEAK = "continue-on-error: true";
    const crlf = (text: string): string => text.replace(/\n/g, "\r\n");

    it("opens the evidence of an unresolved revision with a cause that is not empty", async () => {
      await commit(repo, { "keep.txt": "keep\n" }, "base");
      const prefix = 'revision "nope" does not name a commit: ';
      for (const options of [
        { base: "nope", candidate: "HEAD" },
        { base: "HEAD", candidate: "nope" },
      ]) {
        const record = await check({ cwd: repo, ...options });
        expect(record.status).toBe("fail");
        expect(record.evidence).toHaveLength(1);
        expect(record.evidence[0]?.startsWith(prefix)).toBe(true);
        expect(record.evidence[0]?.length).toBeGreaterThan(prefix.length);
      }
    });

    it("refuses an empty revision and one beginning with a dash before git is asked", async () => {
      await commit(repo, { "keep.txt": "keep\n" }, "base");
      expect(await check({ cwd: repo, base: "", candidate: "HEAD" })).toEqual({
        name,
        status: "fail",
        evidence: ['revision "" does not name a commit'],
      });
      expect((await check({ cwd: repo, base: "HEAD", candidate: "" })).evidence).toEqual(['revision "" does not name a commit']);
      expect((await check({ cwd: repo, base: "-x", candidate: "HEAD" })).evidence).toEqual(['revision "-x" does not name a commit']);
      expect((await check({ cwd: repo, base: "HEAD", candidate: "-x" })).evidence).toEqual(['revision "-x" does not name a commit']);
    });

    it("reads a revision one character long like any other", async () => {
      await commit(repo, { "keep.txt": "keep\n" }, "base");
      await git(repo, ["branch", "b"]);
      const record = await check({ cwd: repo, base: "b", candidate: "b" });
      expect(record).toEqual({ name, status: "pass", evidence: ["no workflow weakened"] });
      const missing = await check({ cwd: repo, base: "c", candidate: "b" });
      expect(missing.evidence[0]?.startsWith('revision "c" does not name a commit: ')).toBe(true);
    });

    it("escapes exactly the characters outside printable ASCII", async () => {
      const record = await run({ [W]: body() }, { [W]: body("      - run: a\u001f~ \u007f|| true") });
      expect(record.evidence).toEqual([`${W}: or-true "- run: a\\u{001f}~ \\u{007f}|| true"`]);
    });

    it("reads a line ending in a carriage return as the line without it", async () => {
      const record = await run({ [W]: crlf(body()) }, { [W]: crlf(body(WEAK)) });
      expect(record.status).toBe("fail");
      expect(record.evidence).toEqual([`${W}: continue-on-error "${WEAK}"`]);
    });

    it("counts a line with a carriage return and the same line without one as one line", async () => {
      await commit(repo, { [W]: crlf(body(WEAK)) }, "base");
      const base = await git(repo, ["rev-parse", "HEAD"]);
      await commit(repo, { [W]: body(WEAK) }, "lf");
      expect((await check({ cwd: repo, base, candidate: "HEAD" })).evidence).toEqual(["no workflow weakened"]);
    });

    it("compares a renamed workflow with its source and passes one that keeps its weakening line", async () => {
      const renamed = ".github/workflows/build.yaml";
      const record = await run({ [W]: body(`    ${WEAK}`) }, { [W]: null, [renamed]: body(`    ${WEAK}`) });
      expect(record.status).toBe("pass");
      expect(record.evidence).toEqual(["no workflow weakened"]);
    });

    it("compares a file moved into the directory from outside it with nothing", async () => {
      const record = await run({ "ci.yml": body(`    ${WEAK}`) }, { "ci.yml": null, [W]: body(`    ${WEAK}`) });
      expect(record.status).toBe("fail");
      expect(record.evidence).toEqual([`${W}: continue-on-error "${WEAK}"`]);
    });

    it("writes a workflow whose name holds a tilde as it is", async () => {
      const file = ".github/workflows/a~b.yml";
      const record = await run({}, { [file]: body(WEAK) });
      expect(record.evidence).toEqual([`${file}: continue-on-error "${WEAK}"`]);
    });

    it("lets a caller's reason one character long sanction its finding", async () => {
      const record = await run({ [W]: body() }, { [W]: body(WEAK) }, { sanctions: { [`continue-on-error:${W}`]: "x" } });
      expect(record.status).toBe("pass");
      expect(record.evidence).toEqual([`${W}: continue-on-error "${WEAK}" - sanctioned: x`]);
    });

    it("lets a caller's reason of white space alone sanction nothing", async () => {
      const record = await run({ [W]: body() }, { [W]: body(WEAK) }, { sanctions: { [`continue-on-error:${W}`]: " \t " } });
      expect(record.status).toBe("fail");
      expect(record.evidence).toEqual([`${W}: continue-on-error "${WEAK}"`]);
    });

    it("lets a commit message line with a reason one character long sanction its finding", async () => {
      const id = `continue-on-error:${W}`;
      const record = await run({ [W]: body() }, { [W]: body(WEAK) }, { message: `x\n\n${SANCTION_KEY}: ${id} x` });
      expect(record.status).toBe("pass");
      expect(record.evidence[0]?.endsWith(" - sanctioned: x")).toBe(true);
    });

    it("is not sanctioned by a line that names another workflow, even one with an id as long", async () => {
      const other = ".github/workflows/cj.yml";
      const start = await commit(repo, { "start.txt": "start\n" }, "start");
      const lines = [`continue-on-error:${other} reason`, `continue-on-error:${W}x reason`, `continue-on-error:${W}`, `if-false:${W} reason`];
      for (const line of lines) {
        const record = await run({ [W]: body() }, { [W]: body(WEAK) }, { message: `x\n\n${SANCTION_KEY}: ${line}` });
        expect(record.status).toBe("fail");
        expect(record.evidence).toEqual([`${W}: continue-on-error "${WEAK}"`]);
        await git(repo, ["reset", "--quiet", "--hard", start]);
      }
    });
  });
});
