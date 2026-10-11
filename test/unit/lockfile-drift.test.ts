import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkLockfileDrift } from "../../src/lockfile-drift.js";

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

function manifest(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: "x",
    description: "d",
    version: "1.0.0",
    scripts: { test: "vitest" },
    dependencies: { left: "^1.0.0" },
    ...over,
  });
}

async function commit(cwd: string, files: Record<string, string>): Promise<string> {
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(cwd, name), content);
  }
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "--quiet", "-m", "change"]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

async function freshRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "repo-truth-lockfile-drift-"));
  await git(dir, ["init", "--quiet", "--initial-branch=main"]);
  return dir;
}

describe("checkLockfileDrift", () => {
  let repo: string;
  let base: string;

  beforeEach(async () => {
    repo = await freshRepo();
    base = await commit(repo, { "package.json": manifest(), "package-lock.json": "lock v1\n" });
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("fails a manifest dependency edit without the lockfile as a stale pin", async () => {
    const candidate = await commit(repo, { "package.json": manifest({ dependencies: { left: "^2.0.0" } }) });
    const record = await checkLockfileDrift({ cwd: repo, base, candidate });
    expect(record.name).toBe("RT-06");
    expect(record.status).toBe("fail");
    const text = record.evidence.join("\n");
    expect(text).toContain("package.json");
    expect(text).toContain("package-lock.json");
    expect(text).toContain("stale pin");
  });

  it("fails a lockfile edit without the manifest as an unrequested change", async () => {
    const candidate = await commit(repo, { "package-lock.json": "lock v2\n" });
    const record = await checkLockfileDrift({ cwd: repo, base, candidate });
    expect(record.status).toBe("fail");
    const text = record.evidence.join("\n");
    expect(text).toContain("package.json");
    expect(text).toContain("package-lock.json");
    expect(text).toContain("unrequested");
    expect(text).not.toContain("stale pin");
  });

  it("passes both changed together", async () => {
    const candidate = await commit(repo, {
      "package.json": manifest({ devDependencies: { right: "1.0.0" } }),
      "package-lock.json": "lock v2\n",
    });
    expect((await checkLockfileDrift({ cwd: repo, base, candidate })).status).toBe("pass");
  });

  it("ignores a manifest edit confined to non-dependency fields", async () => {
    const candidate = await commit(repo, {
      "package.json": manifest({ description: "new", scripts: { test: "jest" }, version: "1.1.0" }),
    });
    expect((await checkLockfileDrift({ cwd: repo, base, candidate })).status).toBe("pass");
  });

  it("ignores reordered dependency keys", async () => {
    const b = await commit(repo, {
      "package.json": manifest({ dependencies: { a: "1", b: "2" } }),
      "package-lock.json": "l2\n",
    });
    const candidate = await commit(repo, { "package.json": manifest({ dependencies: { b: "2", a: "1" } }) });
    expect((await checkLockfileDrift({ cwd: repo, base: b, candidate })).status).toBe("pass");
  });

  it("recognises pnpm-lock.yaml", async () => {
    const r2 = await freshRepo();
    try {
      const b = await commit(r2, { "package.json": manifest(), "pnpm-lock.yaml": "a\n" });
      const candidate = await commit(r2, { "package.json": manifest({ dependencies: {} }) });
      const record = await checkLockfileDrift({ cwd: r2, base: b, candidate });
      expect(record.status).toBe("fail");
      expect(record.evidence.join("\n")).toContain("pnpm-lock.yaml");
    } finally {
      await rm(r2, { recursive: true, force: true });
    }
  });

  it("skips, naming what it looked for, when there is no lockfile", async () => {
    const r2 = await freshRepo();
    try {
      const b = await commit(r2, { "package.json": manifest() });
      const candidate = await commit(r2, { "package.json": manifest({ dependencies: {} }) });
      const record = await checkLockfileDrift({ cwd: r2, base: b, candidate });
      expect(record.status).toBe("skip");
      expect(record.evidence.join("\n")).toContain("yarn.lock");
    } finally {
      await rm(r2, { recursive: true, force: true });
    }
  });

  it("skips when there is no manifest", async () => {
    const r2 = await freshRepo();
    try {
      const b = await commit(r2, { "yarn.lock": "a\n" });
      const candidate = await commit(r2, { "yarn.lock": "b\n" });
      const record = await checkLockfileDrift({ cwd: r2, base: b, candidate });
      expect(record.status).toBe("skip");
      expect(record.evidence.join("\n")).toContain("package.json");
    } finally {
      await rm(r2, { recursive: true, force: true });
    }
  });

  it("fails closed on a revision that names no commit", async () => {
    const record = await checkLockfileDrift({ cwd: repo, base: "no-such-rev", candidate: "HEAD" });
    expect(record.status).toBe("fail");
    expect(record.evidence.join("\n")).toContain("no-such-rev");
  });

  it("fails closed when cwd is not a repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "repo-truth-lockfile-drift-"));
    try {
      const record = await checkLockfileDrift({ cwd: dir, base: "HEAD", candidate: "HEAD" });
      expect(record.status).toBe("fail");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

const SNOWMAN = "☃";
const BELL = "\u0007";
const UNIT_SEPARATOR = "\u001f";
const DELETE_CHAR = "\u007f";
const LATIN_SMALL_E_ACUTE = "é";
const LEFT_QUOTES = "«";
const GRINNING_FACE = "\u{1F600}";

describe("checkLockfileDrift, pinned behaviors", () => {
  const made: string[] = [];

  /** Commit files; a null content removes the path. */
  async function put(dir: string, files: Record<string, string | null>): Promise<string> {
    for (const [name, content] of Object.entries(files)) {
      const target = join(dir, name);
      if (content === null) {
        await rm(target, { recursive: true, force: true });
      } else {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);
      }
    }
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "--quiet", "--allow-empty", "-m", "change"]);
    return git(dir, ["rev-parse", "HEAD"]);
  }

  async function repoOf(files: Record<string, string>): Promise<{ dir: string; first: string }> {
    const dir = await freshRepo();
    made.push(dir);
    return { dir, first: await put(dir, files) };
  }

  afterAll(async () => {
    for (const dir of made) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  const run = (dir: string, base: string, candidate: string) => checkLockfileDrift({ cwd: dir, base, candidate });
  const PLAIN = { "package.json": manifest(), "yarn.lock": "a\n" };
  const TOGETHER = ["package.json dependency fields and package-lock.json changed together"];

  describe("errors", () => {
    it("carries git's own complaint for a directory that is not a repository", async () => {
      const dir = await mkdtemp(join(tmpdir(), "repo-truth-lockfile-drift-"));
      made.push(dir);
      const record = await run(dir, "HEAD", "HEAD");
      expect(record.status).toBe("fail");
      expect(record.evidence).toHaveLength(1);
      const text = record.evidence[0] ?? "";
      expect(text).toContain("not a git repository");
      expect(text).not.toContain("Command failed");
    });

    it("carries the refusing git command's message after the revision", async () => {
      const { dir, first } = await repoOf(PLAIN);
      for (const [base, candidate, named] of [
        ["no-such-rev", first, "no-such-rev"],
        [first, "gone-rev", "gone-rev"],
      ] as const) {
        const record = await run(dir, base, candidate);
        expect(record.status).toBe("fail");
        expect(record.evidence).toHaveLength(1);
        const text = record.evidence[0] ?? "";
        const lead = `revision "${named}" names no commit: `;
        expect(text.startsWith(lead)).toBe(true);
        const rest = text.slice(lead.length);
        expect(rest.length).toBeGreaterThan(0);
        expect(rest).toContain("rev-parse");
      }
    });

    it("refuses an empty revision before git runs", async () => {
      const { dir, first } = await repoOf(PLAIN);
      expect(await run(dir, "", first)).toEqual({
        name: "RT-06",
        status: "fail",
        evidence: ['revision "" names no commit'],
      });
      expect((await run(dir, first, "")).evidence).toEqual(['revision "" names no commit']);
    });

    it("refuses a revision that begins with a minus sign before git runs", async () => {
      const { dir, first } = await repoOf(PLAIN);
      expect((await run(dir, "-x", first)).evidence).toEqual(['revision "-x" names no commit']);
      expect((await run(dir, first, "--all")).evidence).toEqual(['revision "--all" names no commit']);
      expect((await run(dir, "-", first)).evidence).toEqual(['revision "-" names no commit']);
    });

    it("names the cause when two commits share no history", async () => {
      const { dir, first } = await repoOf(PLAIN);
      await git(dir, ["checkout", "--quiet", "--orphan", "other"]);
      await git(dir, ["rm", "-rf", "--quiet", "."]);
      const other = await put(dir, { "readme.txt": "r\n" });
      const record = await run(dir, first, other);
      expect(record.status).toBe("fail");
      expect(record.evidence).toHaveLength(1);
      expect((record.evidence[0] ?? "").startsWith(`no merge base of "${first}" and "${other}"`)).toBe(true);
    });
  });

  describe("escaping", () => {
    it("writes every character outside printable ASCII as a lowercase four-digit escape", async () => {
      const { dir, first } = await repoOf(PLAIN);
      const revision = `-${SNOWMAN} ~${BELL}${UNIT_SEPARATOR}${DELETE_CHAR}${LEFT_QUOTES}${GRINNING_FACE}z`;
      const expected = [
        'revision "-\\u{2603} ~\\u{0007}\\u{001f}\\u{007f}\\u{00ab}\\u{1f600}z" names no commit',
      ];
      expect((await run(dir, revision, first)).evidence).toEqual(expected);
      expect((await run(dir, first, revision)).evidence).toEqual(expected);
    });

    it("escapes a revision git refuses, and keeps a space and a tilde as they are", async () => {
      const { dir, first } = await repoOf(PLAIN);
      const record = await run(dir, `no ~${SNOWMAN}`, first);
      expect(record.evidence).toHaveLength(1);
      const text = record.evidence[0] ?? "";
      expect(text.startsWith('revision "no ~\\u{2603}" names no commit: ')).toBe(true);
      expect(text).not.toContain(SNOWMAN);
    });

    it("escapes the revisions printed in the range", async () => {
      const { dir, first } = await repoOf({ "readme.txt": "r\n" });
      const name = `caf${LATIN_SMALL_E_ACUTE}-b`;
      await git(dir, ["branch", name]);
      const record = await run(dir, name, first);
      expect(record.status).toBe("skip");
      expect(record.evidence[0]).toContain(`"caf\\u{00e9}-b".."${first}"`);
    });
  });

  describe("reading", () => {
    it("does not take a directory named like a lockfile for a lockfile", async () => {
      const { dir, first } = await repoOf({ "package.json": manifest(), "yarn.lock/inner.txt": "a\n" });
      const candidate = await put(dir, { "package.json": manifest({ dependencies: {} }) });
      const record = await run(dir, first, candidate);
      expect(record.status).toBe("skip");
      expect(record.evidence.join("\n")).toContain("no recognised lockfile");
    });

    it("does not take a directory named like the manifest for a manifest", async () => {
      const { dir, first } = await repoOf({ "package.json/inner.txt": "a\n", "yarn.lock": "a\n" });
      const candidate = await put(dir, { "yarn.lock": "b\n" });
      const record = await run(dir, first, candidate);
      expect(record.status).toBe("skip");
      expect(record.evidence.join("\n")).toContain("no package.json found");
    });

    it("ignores a lockfile and a manifest that are not at the root", async () => {
      const { dir, first } = await repoOf({ "readme.txt": "r\n" });
      const candidate = await put(dir, { "sub/package.json": manifest(), "sub/yarn.lock": "a\n" });
      const record = await run(dir, first, candidate);
      expect(record.status).toBe("skip");
      expect(record.evidence.join("\n")).toContain("no package.json found");
    });

    it("treats reordered members of an array in a dependency field as no change", async () => {
      const { dir, first } = await repoOf({
        "package.json": manifest({ bundleDependencies: ["a", "b", "c"] }),
        "package-lock.json": "l\n",
      });
      const candidate = await put(dir, { "package.json": manifest({ bundleDependencies: ["c", "a", "b"] }) });
      const record = await run(dir, first, candidate);
      expect(record.status).toBe("pass");
      expect(record.evidence.join("\n")).toContain("neither");
    });

    it("treats a member added to an array in a dependency field as a change", async () => {
      const { dir, first } = await repoOf({
        "package.json": manifest({ bundleDependencies: ["a", "b"] }),
        "package-lock.json": "l\n",
      });
      const candidate = await put(dir, { "package.json": manifest({ bundleDependencies: ["b", "a", "c"] }) });
      const record = await run(dir, first, candidate);
      expect(record.status).toBe("fail");
      expect(record.evidence.join("\n")).toContain("stale pin");
    });

    it("treats a member swapped in an array in a dependency field as a change", async () => {
      const { dir, first } = await repoOf({
        "package.json": manifest({ bundledDependencies: ["a", "b"] }),
        "package-lock.json": "l\n",
      });
      const candidate = await put(dir, { "package.json": manifest({ bundledDependencies: ["a", "z"] }) });
      expect((await run(dir, first, candidate)).evidence.join("\n")).toContain("stale pin");
    });

    it("fails a manifest whose JSON is not an object", async () => {
      for (const text of ["[]", '"text"', "null"]) {
        const { dir, first } = await repoOf({ "package.json": manifest(), "package-lock.json": "l\n" });
        const candidate = await put(dir, { "package.json": text, "package-lock.json": "m\n" });
        const forward = await run(dir, first, candidate);
        expect(forward.status).toBe("fail");
        expect(forward.evidence).toEqual([`package.json at "${candidate}" is not a JSON object`]);
        const child = await put(dir, { "package.json": manifest(), "package-lock.json": "n\n" });
        const onward = await run(dir, candidate, child);
        expect(onward.status).toBe("fail");
        expect(onward.evidence).toEqual([`package.json at "${candidate}" is not a JSON object`]);
      }
    });

    it("judges a range that adds the manifest and a lockfile together", async () => {
      const { dir, first } = await repoOf({ "readme.txt": "r\n" });
      const candidate = await put(dir, { "package.json": manifest(), "package-lock.json": "l\n" });
      const record = await run(dir, first, candidate);
      expect(record.status).toBe("pass");
      expect(record.evidence).toEqual(TOGETHER);
    });

    it("fails a range that adds only the manifest", async () => {
      const { dir, first } = await repoOf({ "readme.txt": "r\n", "yarn.lock": "a\n" });
      const candidate = await put(dir, { "package.json": manifest() });
      const record = await run(dir, first, candidate);
      expect(record.status).toBe("fail");
      expect(record.evidence.join("\n")).toContain("stale pin");
    });

    it("judges a range that removes the manifest and keeps the lockfile", async () => {
      const { dir, first } = await repoOf(PLAIN);
      const candidate = await put(dir, { "package.json": null });
      const record = await run(dir, first, candidate);
      expect(record.status).toBe("fail");
      expect(record.evidence.join("\n")).toContain("stale pin");
    });

    it("passes a range that adds a lockfile beside a changed dependency field", async () => {
      const { dir, first } = await repoOf({ "package.json": manifest() });
      const candidate = await put(dir, {
        "package.json": manifest({ dependencies: { left: "^2.0.0" } }),
        "package-lock.json": "l\n",
      });
      const record = await run(dir, first, candidate);
      expect(record.status).toBe("pass");
      expect(record.evidence).toEqual(TOGETHER);
    });

    it("passes a range that removes a lockfile beside a changed dependency field", async () => {
      const { dir, first } = await repoOf({ "package.json": manifest(), "package-lock.json": "l\n" });
      const candidate = await put(dir, {
        "package.json": manifest({ dependencies: { left: "^2.0.0" } }),
        "package-lock.json": null,
      });
      const record = await run(dir, first, candidate);
      expect(record.status).toBe("pass");
      expect(record.evidence).toEqual(TOGETHER);
    });

    it("names the lockfiles that did and did not change", async () => {
      const { dir, first } = await repoOf({
        "package.json": manifest(),
        "package-lock.json": "l\n",
        "yarn.lock": "y\n",
      });
      const candidate = await put(dir, { "yarn.lock": "z\n" });
      const record = await run(dir, first, candidate);
      expect(record.status).toBe("fail");
      expect(record.evidence.join("\n")).toContain("unrequested change: yarn.lock changed in");
      const same = await run(dir, candidate, candidate);
      expect(same.evidence).toEqual([
        "neither the dependency fields of package.json nor package-lock.json, yarn.lock changed",
      ]);
    });
  });
});
