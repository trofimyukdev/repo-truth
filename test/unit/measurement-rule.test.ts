import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkMeasurementRule } from "../../src/measurement-rule.js";

const execFileAsync = promisify(execFile);

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "Test Committer",
  GIT_COMMITTER_EMAIL: "committer@example.com",
};

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args as string[], { cwd, env: ENV });
  return stdout.trim();
}

async function commit(cwd: string, message: string, files: Record<string, string> = {}): Promise<string> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, name)), { recursive: true });
    await writeFile(join(cwd, name), content);
    await git(cwd, ["add", "--", name]);
  }
  await git(cwd, ["commit", "--quiet", "--allow-empty", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

describe("checkMeasurementRule", () => {
  let repo: string;
  let base: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "repo-truth-measurement-"));
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
    base = await commit(repo, "initial", { "README.md": "# Title\n\nSome prose written long ago, 99 files.\n" });
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const run = (candidate: string) => checkMeasurementRule({ cwd: repo, base, candidate });

  it("separates a violating body from a compliant one of the same shape", async () => {
    const bad = await commit(repo, "perf: faster\n\nThe parser now takes 12 ms per file.");
    const badResult = await run(bad);
    expect(badResult.name).toBe("RT-02");
    expect(badResult.status).toBe("fail");
    expect(badResult.evidence).toHaveLength(1);
    expect(badResult.evidence[0]).toContain(bad.slice(0, 7));
    expect(badResult.evidence[0]).toMatch(/command/);
    expect(badResult.evidence[0]).toMatch(/date/);

    const good = await commit(
      repo,
      "perf: faster\n\nThe parser now takes 12 ms per file.\nMeasured with `npm run bench` on 2026-10-02.",
    );
    const goodResult = await checkMeasurementRule({ cwd: repo, base: bad, candidate: good });
    expect(goodResult.status).toBe("pass");
  });

  it("names only the missing half", async () => {
    const noDate = await commit(repo, "perf\n\nIt takes 12 ms. Run `npm run bench`.");
    const r1 = await checkMeasurementRule({ cwd: repo, base, candidate: noDate });
    expect(r1.status).toBe("fail");
    expect(r1.evidence.join("\n")).toMatch(/\bdate\b/);
    expect(r1.evidence.join("\n")).not.toMatch(/\bcommand\b/);

    const noCommand = await commit(repo, "perf\n\nIt takes 12 ms, taken 2026-10-02.");
    const r2 = await checkMeasurementRule({ cwd: repo, base: noDate, candidate: noCommand });
    expect(r2.status).toBe("fail");
    expect(r2.evidence.join("\n")).toMatch(/\bcommand\b/);
    expect(r2.evidence.join("\n")).not.toMatch(/\bdate\b/);
  });

  it("accepts a fenced block as the command", async () => {
    const sha = await commit(repo, "perf\n\nIt takes 12 ms on 2026-10-02.\n\n```\nnpm run bench\n```");
    // blank line inside the body does not split a commit body: the block is the whole body
    expect((await run(sha)).status).toBe("pass");
  });

  it.each([
    ["a version", "Bumps the parser to v1.2.3 and node 20.11.1."],
    ["a SHA", "Reverts 3ffcbf9 and cdd3066ab12."],
    ["an ISO date", "Decided on 2026-09-30."],
    ["a section number", "See section 4.2 and Figure 3 and step 2."],
    ["a line reference", "See src/index.ts:42 and line 17."],
    ["a path containing digits", "Edit docs/v2/step3.md and test/fixtures/100.txt."],
    ["a task id", "Follows RT-10 and #123."],
  ])("stays silent about %s", async (_label, body) => {
    const sha = await commit(repo, `chore\n\n${body}`);
    const result = await run(sha);
    expect(result.evidence).toEqual(expect.any(Array));
    expect(result.status).toBe("pass");
  });

  it("stays silent about lines inside a fenced block, quotes and code spans", async () => {
    const body = [
      "chore",
      "",
      "```",
      "ran 40 tests in 12 ms",
      "```",
      "> upstream says 30% faster",
      "Use `--max 50 files` carefully.",
    ].join("\n");
    const sha = await commit(repo, body);
    expect((await run(sha)).status).toBe("pass");
  });

  it("reads the subject line as not part of the body", async () => {
    const sha = await commit(repo, "perf: cut 12 ms from the parser");
    expect((await run(sha)).status).toBe("pass");
  });

  it("reads added documentation lines, by path and line", async () => {
    const sha = await commit(repo, "docs", {
      "docs/perf.md": "# Perf\n\nIntro text.\n\nStartup takes 300 ms now.\n",
    });
    const result = await run(sha);
    expect(result.status).toBe("fail");
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toContain("docs/perf.md:5");
    expect(result.evidence[0]).toMatch(/command/);
    expect(result.evidence[0]).toMatch(/date/);
  });

  it("accepts a documentation paragraph holding its command and date", async () => {
    const sha = await commit(repo, "docs", {
      "docs/perf.md": "# Perf\n\nStartup takes 300 ms now.\nMeasured by `npm run bench` on 2026-10-02.\n",
    });
    expect((await run(sha)).status).toBe("pass");
  });

  it("reads only the changed lines, not the whole file", async () => {
    const sha = await commit(repo, "docs", {
      "README.md": "# Title\n\nSome prose written long ago, 99 files.\n\nAdded paragraph without figures.\n",
    });
    expect((await run(sha)).status).toBe("pass");
  });

  it("does not report an untouched line of a paragraph the range edited", async () => {
    const sha = await commit(repo, "docs", {
      "README.md": "# Title\n\nSome prose written long ago, 99 files.\nA new sentence.\n",
    });
    expect((await run(sha)).status).toBe("pass");
  });

  it("ignores figures in fenced blocks and quotes of documents", async () => {
    const sha = await commit(repo, "docs", {
      "docs/q.md": "# Q\n\n```\n40 tests passed in 12 ms\n```\n\n> they claim 30% faster\n",
    });
    expect((await run(sha)).status).toBe("pass");
  });

  it("passes an empty range", async () => {
    expect((await run(base)).status).toBe("pass");
  });

  it("fails closed on a revision that names no commit", async () => {
    const result = await checkMeasurementRule({ cwd: repo, base, candidate: "no-such-rev" });
    expect(result.status).toBe("fail");
    expect(result.evidence.join("\n")).toContain("no-such-rev");
    const other = await checkMeasurementRule({ cwd: repo, base: "ghost-base", candidate: "HEAD" });
    expect(other.status).toBe("fail");
    expect(other.evidence.join("\n")).toContain("ghost-base");
  });

  it("fails closed, without throwing, when git cannot run", async () => {
    const result = await checkMeasurementRule({ cwd: join(repo, "missing-dir"), base: "a", candidate: "b" });
    expect(result.status).toBe("fail");
    expect(result.evidence.length).toBeGreaterThan(0);
  });

  describe("pinned behaviors", () => {
    const FIGURE = "12 ms";
    const HIDDEN = "40 tests";
    const SECOND = "7 errors";
    const TICKS = "```";

    const fenced = (...lines: string[]) => `perf\n\n${lines.join("\n")}`;

    it("words a revision that names no commit exactly", async () => {
      const result = await run("no-such-branch");
      expect(result.status).toBe("fail");
      expect(result.evidence).toEqual(["revision no-such-branch names no commit"]);
    });

    it("resolves a one character revision like any other", async () => {
      await commit(repo, `perf\n\nThe parser takes ${FIGURE}.`);
      const result = await run("@");
      expect(result.status).toBe("fail");
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence[0]).toContain(`figure "${FIGURE}"`);
    });

    it("reports git's own complaint when the histories share nothing", async () => {
      await git(repo, ["checkout", "--quiet", "--orphan", "unrelated"]);
      const orphan = await commit(repo, "unrelated root");
      const result = await run(orphan);
      expect(result.status).toBe("fail");
      expect(result.evidence).toHaveLength(1);
      const line = result.evidence[0] ?? "";
      expect(line.startsWith(`git failed while reading ${base}..${orphan}: `)).toBe(true);
      expect(line).toMatch(/no merge base/i);
      expect(line).not.toContain("Command failed");
    });

    it("reads the prose after a plain fence again", async () => {
      const sha = await commit(repo, fenced(TICKS, "npm run bench", TICKS, `It takes ${FIGURE}.`));
      const result = await run(sha);
      expect(result.status).toBe("fail");
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence[0]).toContain(`figure "${FIGURE}"`);
    });

    it("keeps every line of a multi-line fence out of the prose", async () => {
      const sha = await commit(repo, fenced(TICKS, "first", `ran ${HIDDEN}`, `ran ${SECOND}`, `took ${FIGURE}`, TICKS));
      expect((await run(sha)).status).toBe("pass");
    });

    it.each([1, 2, 3])("closes a fence with a closing run indented by %i spaces", async (indent) => {
      const sha = await commit(repo, fenced(TICKS, `ran ${HIDDEN}`, " ".repeat(indent) + TICKS, `It takes ${FIGURE}.`));
      const result = await run(sha);
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence[0]).toContain(`figure "${FIGURE}"`);
    });

    it.each([1, 2, 3])("opens a fence with an opening run indented by %i spaces", async (indent) => {
      const sha = await commit(repo, fenced(" ".repeat(indent) + TICKS, `ran ${HIDDEN}`, TICKS, `It takes ${FIGURE}.`));
      const result = await run(sha);
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence[0]).toContain(`figure "${FIGURE}"`);
    });

    it("does not close a four backtick fence with a shorter indented run", async () => {
      const long = TICKS + "`";
      const inside = await commit(repo, fenced(long, " " + TICKS, `ran ${HIDDEN}`, long));
      expect((await run(inside)).status).toBe("pass");
      const after = await commit(repo, fenced(long, " " + TICKS, `ran ${HIDDEN}`, long, `It takes ${FIGURE}.`));
      const result = await checkMeasurementRule({ cwd: repo, base: inside, candidate: after });
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence[0]).toContain(`figure "${FIGURE}"`);
    });

    it("reads a later paragraph of an added document on its own", async () => {
      const sha = await commit(repo, "docs", {
        "docs/x.md": `# T\n\nIt takes ${HIDDEN}. Run \`npm run bench\` on 2026-10-02.\n\nLater it takes ${FIGURE}.\n`,
      });
      const result = await run(sha);
      expect(result.status).toBe("fail");
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence[0]).toContain("docs/x.md:5");
      expect(result.evidence[0]).toContain(`figure "${FIGURE}"`);
    });

    it("reads a one line last paragraph that has no trailing newline", async () => {
      const sha = await commit(repo, "docs", { "docs/x.md": `# T\n\nIntro.\n\nIt takes ${FIGURE}.` });
      const result = await run(sha);
      expect(result.status).toBe("fail");
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence[0]).toContain("docs/x.md:5");
      expect(result.evidence[0]).toContain(`figure "${FIGURE}"`);
    });

    it("reads a single added line of an existing document", async () => {
      const sha = await commit(repo, "docs", {
        "README.md": `# Title\n\nSome prose written long ago, 99 files.\nIt takes ${FIGURE}.\n`,
      });
      const result = await run(sha);
      expect(result.status).toBe("fail");
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence[0]).toContain("README.md:4");
      expect(result.evidence[0]).toContain(`figure "${FIGURE}"`);
    });

    it("reads the first and the last line of a run of added lines", async () => {
      const sha = await commit(repo, "docs", {
        "README.md": `# Title\n\nSome prose written long ago, 99 files.\nIt takes ${FIGURE}.\nThere are ${SECOND}.\n`,
      });
      const result = await run(sha);
      expect(result.status).toBe("fail");
      expect(result.evidence).toHaveLength(2);
      expect(result.evidence[0]).toContain("README.md:4");
      expect(result.evidence[0]).toContain(`figure "${FIGURE}"`);
      expect(result.evidence[1]).toContain("README.md:5");
      expect(result.evidence[1]).toContain(`figure "${SECOND}"`);
    });

    it("leaves an old line unreported when the range adds a line directly before it", async () => {
      const sha = await commit(repo, "docs", {
        "README.md": "# Title\n\nAn added line.\nSome prose written long ago, 99 files.\n",
      });
      const result = await run(sha);
      expect(result.evidence).toEqual(expect.any(Array));
      expect(result.status).toBe("pass");
    });
  });
});
