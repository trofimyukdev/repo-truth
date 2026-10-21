import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkCommitRange } from "../../src/commit-range.js";

const execFileAsync = promisify(execFile);

const ID_PREFIX_LENGTH = 12;
const LABEL_SUFFIX = " contains a character outside printable ASCII/tab: ";

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "Test Committer",
  GIT_COMMITTER_EMAIL: "committer@example.com",
};

async function git(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = ENV): Promise<string> {
  const { stdout } = await execFileAsync("git", args as string[], { cwd, env });
  return stdout.trim();
}

async function initRepo(cwd: string): Promise<void> {
  await git(cwd, ["init", "--quiet", "--initial-branch=main"]);
  await writeFile(join(cwd, "README.md"), "hello\n");
  await git(cwd, ["add", "README.md"]);
  await git(cwd, ["commit", "--quiet", "-m", "initial commit"]);
}

async function commitFile(
  cwd: string,
  name: string,
  contents: string,
  message: string,
  env: NodeJS.ProcessEnv = ENV,
): Promise<string> {
  await writeFile(join(cwd, name), contents);
  await git(cwd, ["add", name]);
  await git(cwd, ["commit", "--quiet", "-m", message], env);
  return git(cwd, ["rev-parse", "HEAD"]);
}

describe("checkCommitRange", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "repo-truth-commit-range-"));
    await initRepo(repo);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("passes a clean range with a normal ASCII history", async () => {
    const base = await git(repo, ["rev-parse", "HEAD"]);
    await commitFile(repo, "a.txt", "a\n", "add a");
    await commitFile(repo, "b.txt", "b\n", "add b");
    const candidate = await git(repo, ["rev-parse", "HEAD"]);

    const record = await checkCommitRange({ cwd: repo, base, candidate });

    expect(record.status).toBe("pass");
    expect(record.name).toBe("RT-01");
  });

  it("rejects a non-ASCII commit message introduced by cherry-pick, a path a commit-msg hook never sees", async () => {
    const base = await git(repo, ["rev-parse", "HEAD"]);

    // Build the bad commit on a side branch, where a commit-msg hook (if one
    // were installed) would in fact see it and could reject it directly.
    await git(repo, ["checkout", "--quiet", "-b", "side"]);
    await commitFile(repo, "bad.txt", "bad\n", "add bad café file");
    const badCommit = await git(repo, ["rev-parse", "HEAD"]);

    // Now bring it onto main via cherry-pick, which never invokes
    // commit-msg - the message crosses onto the branch a range check reads
    // without ever having been examined by a hook.
    await git(repo, ["checkout", "--quiet", "main"]);
    await commitFile(repo, "clean.txt", "clean\n", "add clean file");
    await git(repo, ["cherry-pick", "--quiet", badCommit]);
    const candidate = await git(repo, ["rev-parse", "HEAD"]);

    const record = await checkCommitRange({ cwd: repo, base, candidate });

    expect(record.status).toBe("fail");
    expect(record.evidence.some((line) => line.includes("commit message"))).toBe(true);
    expect(record.evidence.join("\n")).not.toContain("é");
  });

  it("rejects a non-ASCII author identity introduced by a rebase replay, a path a commit-msg hook never sees", async () => {
    const base = await git(repo, ["rev-parse", "HEAD"]);

    await git(repo, ["checkout", "--quiet", "-b", "feature"]);
    const badEnv = {
      ...ENV,
      GIT_AUTHOR_NAME: "Zoë Doe",
    };
    await commitFile(repo, "feature.txt", "feature\n", "add feature", badEnv);

    // Rebasing onto main replays the commit; `commit-msg` never fires
    // for a replayed commit, only (optionally) `applypatch-msg`/`pre-applypatch`.
    await git(repo, ["checkout", "--quiet", "main"]);
    await commitFile(repo, "main-only.txt", "main\n", "add main-only file");
    await git(repo, ["checkout", "--quiet", "feature"]);
    await git(repo, ["rebase", "--quiet", "main"]);
    const candidate = await git(repo, ["rev-parse", "HEAD"]);

    const record = await checkCommitRange({ cwd: repo, base, candidate });

    expect(record.status).toBe("fail");
    expect(record.evidence.some((line) => line.includes("author name"))).toBe(true);
    expect(record.evidence.join("\n")).not.toContain("ë");
  });

  it("checks every commit in the range, not only the tip", async () => {
    const base = await git(repo, ["rev-parse", "HEAD"]);
    await commitFile(repo, "one.txt", "one\n", "commit one with a bad näme", {
      ...ENV,
      GIT_AUTHOR_NAME: "Bad Näme",
    });
    await commitFile(repo, "two.txt", "two\n", "clean second commit");
    await commitFile(repo, "three.txt", "three\n", "clean third commit");
    const candidate = await git(repo, ["rev-parse", "HEAD"]);

    const record = await checkCommitRange({ cwd: repo, base, candidate });

    expect(record.status).toBe("fail");
    expect(record.evidence.some((line) => line.includes("author name"))).toBe(true);
  });

  it("fails closed on an unreachable base instead of throwing or passing", async () => {
    const base = "0000000000000000000000000000000000000000";
    const candidate = await git(repo, ["rev-parse", "HEAD"]);

    const record = await checkCommitRange({ cwd: repo, base, candidate });

    expect(record.status).toBe("fail");
    expect(record.evidence.length).toBeGreaterThan(0);
  });

  it("fails closed on an unknown candidate revision instead of throwing or passing", async () => {
    const base = await git(repo, ["rev-parse", "HEAD"]);

    const record = await checkCommitRange({ cwd: repo, base, candidate: "does-not-exist" });

    expect(record.status).toBe("fail");
    expect(record.evidence.length).toBeGreaterThan(0);
  });

  async function headId(): Promise<string> {
    return git(repo, ["rev-parse", "HEAD"]);
  }

  function line(id: string, label: string, escaped: string): string {
    return `${id.slice(0, ID_PREFIX_LENGTH)}: ${label}${LABEL_SUFFIX}"${escaped}"`;
  }

  it("carries git's own complaint for a directory that is not a git repository", async () => {
    const plain = await mkdtemp(join(tmpdir(), "repo-truth-commit-range-plain-"));
    try {
      const record = await checkCommitRange({ cwd: plain, base: "HEAD", candidate: "HEAD" });

      expect(record.status).toBe("fail");
      const text = record.evidence.join("\n");
      expect(text).toContain("not a git repository");
      expect(text).not.toContain("Command failed");
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it("passes an empty range with the revisions as the caller gave them", async () => {
    const record = await checkCommitRange({ cwd: repo, base: "HEAD", candidate: "main" });

    expect(record.status).toBe("pass");
    expect(record.name).toBe("RT-01");
    expect(record.evidence).toEqual(["range HEAD..main is empty"]);
  });

  it("reads a range of exactly one commit", async () => {
    const base = await headId();
    const id = await commitFile(repo, "one.txt", "one\n", "café");

    const record = await checkCommitRange({ cwd: repo, base, candidate: id });

    expect(record.status).toBe("fail");
    expect(record.evidence).toEqual([line(id, "commit message", "caf\\u{00e9}")]);
  });

  it("passes a one-commit range that is clean, counting the commit", async () => {
    const base = await headId();
    const id = await commitFile(repo, "one.txt", "one\n", "plain");

    const record = await checkCommitRange({ cwd: repo, base, candidate: id });

    expect(record.status).toBe("pass");
    expect(record.evidence[0]).toContain("1 commit(s)");
  });

  it("passes a message holding a tilde and a tab, the edges of the allowed set", async () => {
    const base = await headId();
    const id = await commitFile(repo, "edge.txt", "e\n", "tilde ~ and\ttab ~");

    const record = await checkCommitRange({ cwd: repo, base, candidate: id });

    expect(record.status).toBe("pass");
  });

  it("names every field with the commit id prefix and escapes each offending character", async () => {
    const base = await headId();
    const id = await commitFile(repo, "all.txt", "a\n", "méssage", {
      ...ENV,
      GIT_AUTHOR_NAME: "Ané",
      GIT_AUTHOR_EMAIL: "aé@example.com",
      GIT_COMMITTER_NAME: "Cné",
      GIT_COMMITTER_EMAIL: "cé@example.com",
    });

    const record = await checkCommitRange({ cwd: repo, base, candidate: id });

    expect(record.status).toBe("fail");
    expect(record.evidence).toEqual([
      line(id, "commit message", "m\\u{00e9}ssage"),
      line(id, "author name", "An\\u{00e9}"),
      line(id, "author e-mail", "a\\u{00e9}@example.com"),
      line(id, "committer name", "Cn\\u{00e9}"),
      line(id, "committer e-mail", "c\\u{00e9}@example.com"),
    ]);
  });

  it("yields one evidence line per offending line and keeps printable characters as written", async () => {
    const base = await headId();
    const id = await commitFile(repo, "lines.txt", "l\n", "ok ~ line\n\nbad é ~ x\tz\n\nworse \u{1F600}!");

    const record = await checkCommitRange({ cwd: repo, base, candidate: id });

    expect(record.evidence).toEqual([
      line(id, "commit message", "bad \\u{00e9} ~ x\tz"),
      line(id, "commit message", "worse \\u{1f600}!"),
    ]);
  });

  it("escapes control characters on both sides of the printable range", async () => {
    const base = await headId();
    const id = await commitFile(repo, "ctl.txt", "c\n", "lo\u001fhi\u007fend");

    const record = await checkCommitRange({ cwd: repo, base, candidate: id });

    expect(record.evidence).toEqual([line(id, "commit message", "lo\\u{001f}hi\\u{007f}end")]);
  });
});
