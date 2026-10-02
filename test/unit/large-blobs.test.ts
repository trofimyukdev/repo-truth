import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkLargeBlobs, DEFAULT_MAX_BLOB_BYTES } from "../../src/large-blobs.js";

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

async function commit(cwd: string, files: Record<string, string | null>): Promise<string> {
  for (const [name, content] of Object.entries(files)) {
    if (content === null) {
      await rm(join(cwd, name));
    } else {
      await mkdir(dirname(join(cwd, name)), { recursive: true });
      await writeFile(join(cwd, name), content);
    }
  }
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "--quiet", "-m", "change"]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

const blob = (size: number, fill = "a"): string => fill.repeat(size);

describe("checkLargeBlobs", () => {
  let repo: string;
  let base: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "repo-truth-large-blobs-"));
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
    base = await commit(repo, { "README.md": "# Title\n" });
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("defaults the limit to one mebibyte", () => {
    expect(DEFAULT_MAX_BLOB_BYTES).toBe(1048576);
  });

  it("passes a blob exactly at the limit and fails one a byte over", async () => {
    const at = await commit(repo, { "at.bin": blob(DEFAULT_MAX_BLOB_BYTES) });
    const ok = await checkLargeBlobs({ cwd: repo, base, candidate: at });
    expect(ok.name).toBe("RT-12");
    expect(ok.status).toBe("pass");

    const over = await commit(repo, { "over.bin": blob(DEFAULT_MAX_BLOB_BYTES + 1, "b") });
    const record = await checkLargeBlobs({ cwd: repo, base, candidate: over });
    expect(record.status).toBe("fail");
    expect(record.evidence).toEqual([`"over.bin" is 1048577 bytes, over the limit of 1048576 bytes`]);
  });

  it("reports a blob added and deleted inside the range as only in history", async () => {
    await commit(repo, { "dump.bin": blob(2000) });
    const candidate = await commit(repo, { "dump.bin": null });
    const record = await checkLargeBlobs({ cwd: repo, base, candidate, maxBytes: 1000 });
    expect(record.status).toBe("fail");
    expect(record.evidence).toEqual([`"dump.bin" is 2000 bytes, over the limit of 1000 bytes (only in history)`]);
  });

  it("does not report a large base blob the range renames, copies or sits beside", async () => {
    const heavy = await commit(repo, { "big.bin": blob(2000) });
    const candidate = await commit(repo, {
      "big.bin": null,
      "moved/big.bin": blob(2000),
      "copy.bin": blob(2000),
      "small.txt": "x",
    });
    const record = await checkLargeBlobs({ cwd: repo, base: heavy, candidate, maxBytes: 1000 });
    expect(record.status).toBe("pass");
  });

  it("does not report a blob an older commit of the base held", async () => {
    await commit(repo, { "old.bin": blob(2000) });
    await commit(repo, { "old.bin": null });
    const tip = await commit(repo, { "keep.txt": "k" });
    const candidate = await commit(repo, { "again.bin": blob(2000) });
    const record = await checkLargeBlobs({ cwd: repo, base: tip, candidate, maxBytes: 1000 });
    expect(record.status).toBe("pass");
  });

  it("uses the limit the caller sets", async () => {
    const candidate = await commit(repo, { "mid.bin": blob(500) });
    expect((await checkLargeBlobs({ cwd: repo, base, candidate, maxBytes: 500 })).status).toBe("pass");
    const record = await checkLargeBlobs({ cwd: repo, base, candidate, maxBytes: 499 });
    expect(record.status).toBe("fail");
    expect(record.evidence).toEqual([`"mid.bin" is 500 bytes, over the limit of 499 bytes`]);
  });

  it("measures the object, not the working tree", async () => {
    const candidate = await commit(repo, { "big.bin": blob(2000) });
    await writeFile(join(repo, "big.bin"), "tiny");
    const record = await checkLargeBlobs({ cwd: repo, base, candidate, maxBytes: 1000 });
    expect(record.status).toBe("fail");
    expect(record.evidence[0]).toContain("2000 bytes");
  });

  it("fails closed on a revision that names no commit", async () => {
    const record = await checkLargeBlobs({ cwd: repo, base, candidate: "no-such-rev" });
    expect(record.status).toBe("fail");
    expect(record.evidence).toHaveLength(1);
    expect(record.evidence[0]).toContain("no-such-rev");
    const flag = await checkLargeBlobs({ cwd: repo, base: "--all", candidate: base });
    expect(flag.status).toBe("fail");
  });

  it("fails closed on a directory that is not a repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "repo-truth-not-a-repo-"));
    try {
      const record = await checkLargeBlobs({ cwd: dir, base: "a", candidate: "b" });
      expect(record.status).toBe("fail");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("fails closed on maxBytes %s", async (maxBytes) => {
    const record = await checkLargeBlobs({ cwd: repo, base, candidate: base, maxBytes });
    expect(record.status).toBe("fail");
    expect(record.evidence[0]).toContain("maxBytes");
  });
});
