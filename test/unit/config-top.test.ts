import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { check } from "../../src/checks/config-changes.js";
import { readConfig } from "../../src/config.js";

const execFileAsync = promisify(execFile);

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "Test Committer",
  GIT_COMMITTER_EMAIL: "committer@example.com",
};

const CONFIG = "repo-truth.json";
const KINDS = { "RT-12": { maxBytes: "integer" as const } };
const settings = (n: number): string => JSON.stringify({ schema: "repo-truth.config/v1", checks: { "RT-12": { maxBytes: n } } }, null, 2) + "\n";

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args as string[], { cwd, env: ENV });
  return stdout.trim();
}

async function commit(cwd: string, files: Record<string, string>, message = "change"): Promise<string> {
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, file)), { recursive: true });
    await writeFile(join(cwd, file), content);
  }
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "--quiet", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

describe("the settings are read from repo-truth.json at the top directory", () => {
  let root: string;
  let repo: string;
  let sub: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "repo-truth-config-top-")));
    repo = join(root, "repo");
    sub = join(repo, "sub");
    await mkdir(repo);
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("readConfig", () => {
    it("reads the top directory's file from a subdirectory", async () => {
      const base = await commit(repo, { [CONFIG]: settings(10), [`sub/${CONFIG}`]: settings(99) });
      const read = await readConfig({ cwd: sub, base }, KINDS);
      expect(read.options).toEqual({ "RT-12": { maxBytes: 10 } });
      expect(read.source).toBe(`${CONFIG} at ${base.slice(0, 12)}`);
    });

    it("reads no file when only the subdirectory holds one", async () => {
      const base = await commit(repo, { [`sub/${CONFIG}`]: settings(99) });
      expect(await readConfig({ cwd: sub, base }, KINDS)).toEqual({ source: null, options: {} });
    });

    it("reads the top directory's file at the top directory", async () => {
      const base = await commit(repo, { [CONFIG]: settings(10), [`sub/${CONFIG}`]: settings(99) });
      const read = await readConfig({ cwd: repo, base }, KINDS);
      expect(read.options).toEqual({ "RT-12": { maxBytes: 10 } });
      expect(read.source).toBe(`${CONFIG} at ${base.slice(0, 12)}`);
    });

    it("reads a path given against the directory it runs in", async () => {
      const base = await commit(repo, { [CONFIG]: settings(10), [`sub/${CONFIG}`]: settings(99) });
      const read = await readConfig({ cwd: sub, base, path: CONFIG }, KINDS);
      expect(read).toEqual({ source: CONFIG, options: { "RT-12": { maxBytes: 99 } } });
    });
  });

  describe("RT-66 with no config option", () => {
    it("fails a range that changes the top directory's file, run in a subdirectory", async () => {
      await commit(repo, { [CONFIG]: settings(10), [`sub/${CONFIG}`]: settings(10) });
      await commit(repo, { [CONFIG]: settings(99) });
      const record = await check({ cwd: sub, base: "HEAD~1", candidate: "HEAD" });
      expect(record.status).toBe("fail");
      expect(record.evidence).toEqual([`${CONFIG}: config-changed`]);
    });

    it("passes a range that changes only the subdirectory's file", async () => {
      const base = await commit(repo, { [CONFIG]: settings(10), [`sub/${CONFIG}`]: settings(10) });
      const candidate = await commit(repo, { [`sub/${CONFIG}`]: settings(99) });
      const record = await check({ cwd: sub, base, candidate });
      expect(record.status).toBe("pass");
    });
  });
});
