import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
