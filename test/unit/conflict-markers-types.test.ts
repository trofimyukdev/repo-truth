import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkConflictMarkers } from "../../src/conflict-markers.js";

const execFileAsync = promisify(execFile);

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "Test Committer",
  GIT_COMMITTER_EMAIL: "committer@example.com",
};

// Built, not spelled out, so this file holds no marker of its own.
const OPEN = "<".repeat(7);
const SEP = "=".repeat(7);
const CLOSE = ">".repeat(7);

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args as string[], { cwd, env: ENV });
  return stdout.trim();
}

async function commitAll(cwd: string, message: string): Promise<string> {
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-q", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

describe("checkConflictMarkers over a path whose type changes", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rt09-types-"));
    await git(dir, ["init", "-q"]);
    await git(dir, ["config", "core.symlinks", "true"]);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function linkThenFile(content: string, others: boolean): Promise<[string, string]> {
    await writeFile(join(dir, "a.txt"), "a\n");
    await writeFile(join(dir, "z.txt"), "z\n");
    await symlink("a.txt", join(dir, "m.txt"));
    const base = await commitAll(dir, "base");
    await unlink(join(dir, "m.txt"));
    await writeFile(join(dir, "m.txt"), content);
    if (others) {
      await writeFile(join(dir, "a.txt"), "a\n" + OPEN + " x\n");
      await writeFile(join(dir, "z.txt"), "z\n" + CLOSE + " y\n");
    }
    return [base, await commitAll(dir, "change")];
  }

  it("passes a link replaced by a file with no marker", async () => {
    const [base, candidate] = await linkThenFile("plain\n", false);
    const record = await checkConflictMarkers({ cwd: dir, base, candidate });
    expect(record.status).toBe("pass");
  });

  it("fails a link replaced by a file holding markers, naming each line", async () => {
    const content = OPEN + " a\n" + SEP + "\n" + CLOSE + " b\n";
    const [base, candidate] = await linkThenFile(content, false);
    const record = await checkConflictMarkers({ cwd: dir, base, candidate });
    expect(record.status).toBe("fail");
    expect(record.evidence).toEqual([
      "m.txt:1: opening marker",
      "m.txt:2: separator marker",
      "m.txt:3: closing marker",
    ]);
  });

  it("passes a file replaced by a link", async () => {
    await writeFile(join(dir, "m.txt"), "plain\n");
    const base = await commitAll(dir, "base");
    await unlink(join(dir, "m.txt"));
    await symlink("elsewhere", join(dir, "m.txt"));
    const candidate = await commitAll(dir, "change");
    const record = await checkConflictMarkers({ cwd: dir, base, candidate });
    expect(record.status).toBe("pass");
  });

  it("keeps the findings of paths on each side of the changed one", async () => {
    const [base, candidate] = await linkThenFile("plain\n", true);
    const record = await checkConflictMarkers({ cwd: dir, base, candidate });
    expect(record.status).toBe("fail");
    expect(record.evidence).toEqual(["a.txt:2: opening marker", "z.txt:2: closing marker"]);
  });
});
