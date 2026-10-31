import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { check, name, optionKinds } from "../../src/checks/action-pins.js";

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

async function commit(cwd: string, files: Record<string, string | null>, message = "change"): Promise<string> {
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
const SHA = "0123456789abcdef0123456789ABCDEF01234567";
const DIGEST = "a".repeat(64);
const body = (...steps: string[]): string =>
  ["on: push", "jobs:", "  a:", "    runs-on: x", "    steps:", "      - run: echo", ...steps, ""].join("\n");

const pass = { name, status: "pass", evidence: ["no unpinned action reference added"] };

describe("RT-88 unpinned actions", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "repo-truth-action-pins-"));
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const run = async (
    before: Record<string, string | null>,
    after: Record<string, string | null>,
    extra: Partial<Parameters<typeof check>[0]> = {},
    message = "change",
  ) => {
    const base = await commit(repo, before, "base");
    const candidate = await commit(repo, after, message);
    return check({ cwd: repo, base, candidate, ...extra });
  };

  it("declares its name and option", () => {
    expect(name).toBe("RT-88");
    expect(optionKinds).toEqual({ allowedOwners: "strings" });
  });

  const unpinned: [string, string][] = [
    ["tag", "o/r@v4"],
    ["branch", "o/r@main"],
    ["no @", "o/r"],
    ["short commit", "o/r@0123456"],
    ["docker tag", "docker://alpine:3"],
  ];
  const forms: [string, (v: string) => string][] = [
    ["dash", (v) => `      - uses: ${v}`],
    ["plain", (v) => `        uses: ${v}`],
    ["quoted", (v) => `      - uses: "${v}"`],
    ["single quoted", (v) => `        uses: '${v}'`],
    ["comment", (v) => `      - uses: ${v}   # note`],
    ["quoted comment", (v) => `        uses: "${v}" # note`],
  ];
  for (const [kind, value] of unpinned) {
    for (const [form, line] of forms) {
      it(`fails ${kind} as ${form}`, async () => {
        const record = await run({ [W]: body() }, { [W]: body(line(value)) });
        expect(record).toEqual({ name, status: "fail", evidence: [`${W}: unpinned-action ${value}`] });
      });
    }
  }

  it("passes pinned, local and digest references", async () => {
    const record = await run(
      { [W]: body() },
      { [W]: body(`      - uses: o/r@${SHA}`, `      - uses: o/r/sub/path@${SHA}`, "      - uses: ./local", `      - uses: docker://alpine@sha256:${DIGEST}`) },
    );
    expect(record).toEqual(pass);
  });

  it("reads action.yml at any depth and ignores other files", async () => {
    const record = await run(
      { README: "x" },
      { "sub/dir/action.yml": "runs:\n  steps:\n    - uses: o/r@v1\n", "other/tool.yml": "- uses: o/r@v2\n", ".github/workflows/sub/x.yml": "- uses: o/r@v3\n" },
    );
    expect(record).toEqual({ name, status: "fail", evidence: ["sub/dir/action.yml: unpinned-action o/r@v1"] });
    const yaml = await run({ a: "x" }, { "action.yaml": "- uses: o/r@v1\n" });
    expect(yaml.evidence).toEqual(["action.yaml: unpinned-action o/r@v1"]);
  });

  it("ignores a line the base already holds, moved or re-indented, but not an extra copy", async () => {
    const held = body("      - uses: o/r@v1");
    expect(await run({ [W]: held }, { [W]: ["# top", "on: push", "jobs:", "  a:", "    steps:", "        - uses: o/r@v1", ""].join("\n") })).toEqual(pass);
    const twice = await run({ [W]: held }, { [W]: body("      - uses: o/r@v1", "      - uses: o/r@v1", "      - uses: o/r@v1") });
    expect(twice).toEqual({ name, status: "fail", evidence: [`${W}: unpinned-action o/r@v1`] });
  });

  it("reads a workflow added whole and one renamed onto a workflow path", async () => {
    expect((await run({ a: "x" }, { [W]: body("      - uses: o/r@v1") })).status).toBe("fail");
    const old = ".github/workflows/old.yml";
    const text = body("      - uses: o/r@v1", "      - run: a", "      - run: b", "      - run: c");
    const same = await run({ [old]: text }, { [old]: null, [W]: text });
    expect(same).toEqual(pass);
    const more = await run({ [old]: text }, { [old]: null, [W]: text + "      - uses: p/q@v2\n" });
    expect(more.evidence).toEqual([`${W}: unpinned-action p/q@v2`]);
  });

  it("reads the source of a rename from a path outside the governed set", async () => {
    const text = body("      - uses: o/r@v1", "      - run: a", "      - run: b", "      - run: c");
    expect(await run({ "notes.txt": text }, { "notes.txt": null, [W]: text })).toEqual(pass);
  });

  describe("allowedOwners", () => {
    const after = { [W]: body("      - uses: someone/tool@v1", "      - uses: docker://someone/img:1", "      - uses: other/tool@v1") };
    it("quiets exactly the named owner", async () => {
      const record = await run({ [W]: body() }, after, { allowedOwners: ["someone"] });
      expect(record).toEqual({
        name,
        status: "fail",
        evidence: [`${W}: unpinned-action docker://someone/img:1`, `${W}: unpinned-action other/tool@v1`],
      });
    });
    it("does not quiet by prefix or another owner", async () => {
      const record = await run({ [W]: body() }, { [W]: body("      - uses: someone/tool@v1") }, { allowedOwners: ["some", "other"] });
      expect(record.status).toBe("fail");
    });
    it("passes when every owner is allowed", async () => {
      expect(await run({ [W]: body() }, { [W]: body("      - uses: someone/tool@v1") }, { allowedOwners: ["someone"] })).toEqual(pass);
    });
  });

  describe("sanctions", () => {
    const before = { [W]: body() };
    const after = { [W]: body("      - uses: o/r@v1") };
    it("accepts a commit message line", async () => {
      const record = await run(before, after, {}, `msg\n\nSanctioned-Weakening: unpinned-action:${W} vendor ships tags`);
      expect(record).toEqual({ name, status: "pass", evidence: [`${W}: unpinned-action o/r@v1 - sanctioned: vendor ships tags`] });
    });
    it("accepts the caller's sanctions", async () => {
      const record = await run(before, after, { sanctions: { [`unpinned-action:${W}`]: "approved" } });
      expect(record).toEqual({ name, status: "pass", evidence: [`${W}: unpinned-action o/r@v1 - sanctioned: approved`] });
    });
    it("rejects another file or a missing reason", async () => {
      const other = await run(before, { [W]: body("      - uses: o/r@v2") }, {}, "m\n\nSanctioned-Weakening: unpinned-action:.github/workflows/x.yml why");
      expect(other.status).toBe("fail");
      const bare = await run(before, { [W]: body("      - uses: o/r@v3") }, {}, `m\n\nSanctioned-Weakening: unpinned-action:${W}`);
      expect(bare.status).toBe("fail");
    });
  });

  it("reads from the merge base, not the other side's additions", async () => {
    const root = await commit(repo, { [W]: body() }, "root");
    await git(repo, ["checkout", "--quiet", "-b", "side"]);
    const base = await commit(repo, { [W]: body("      - uses: side/x@v1") }, "side");
    await git(repo, ["checkout", "--quiet", "main"]);
    const candidate = await commit(repo, { other: "1" }, "main");
    expect(await check({ cwd: repo, base, candidate })).toEqual(pass);
    expect(root).not.toBe(base);
  });

  it("does not read the working tree", async () => {
    const base = await commit(repo, { [W]: body() }, "base");
    const candidate = await commit(repo, { other: "1" }, "next");
    await writeFile(join(repo, W), body("      - uses: o/r@v1"));
    expect(await check({ cwd: repo, base, candidate })).toEqual(pass);
  });

  it("fails, naming the cause, for a revision that names no commit", async () => {
    await commit(repo, { a: "1" });
    const record = await check({ cwd: repo, base: "nope", candidate: "HEAD" });
    expect(record.name).toBe(name);
    expect(record.status).toBe("fail");
    expect(record.evidence).toHaveLength(1);
    expect(record.evidence[0]).toContain('revision "nope" does not name a commit');
  });
});
