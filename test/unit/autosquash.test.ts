import { execFile } from "node:child_process";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli.js";
import { AUTOSQUASH_PREFIXES, check, name } from "../../src/checks/autosquash.js";

const execFileAsync = promisify(execFile);

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "Test Committer",
  GIT_COMMITTER_EMAIL: "committer@example.com",
};

const ID_LENGTH = 12;
const FAN_OUT_LENGTH = 2;

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args as string[], { cwd, env: ENV });
  return stdout.trim();
}

let counter = 0;
async function commit(cwd: string, message: string, file = "f.txt"): Promise<string> {
  counter += 1;
  await writeFile(join(cwd, file), `${counter}\n`);
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "--quiet", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

const short = (id: string) => id.slice(0, ID_LENGTH);

describe("RT-29 autosquash leftovers", () => {
  let repo: string;
  let base: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "repo-truth-autosquash-"));
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
    base = await commit(repo, "base");
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const run = (candidate = "HEAD", from = base) => check({ cwd: repo, base: from, candidate });

  it("is named RT-29 and holds the three prefixes", () => {
    expect(name).toBe("RT-29");
    expect(AUTOSQUASH_PREFIXES).toEqual(expect.arrayContaining(["fixup! ", "squash! ", "amend! "]));
  });

  it("passes an ordinary range", async () => {
    await commit(repo, "ordinary");
    expect(await run()).toEqual({ name: "RT-29", status: "pass", evidence: ["no autosquash subject in the range"] });
  });

  for (const prefix of ["fixup! ", "squash! ", "amend! "]) {
    it(`reports ${prefix.trim()}`, async () => {
      const id = await commit(repo, `${prefix}something`);
      const record = await run();
      expect(record.status).toBe("fail");
      expect(record.evidence).toEqual([`${short(id)} ${prefix}something`]);
    });
  }

  it("reports a repeated prefix once", async () => {
    const id = await commit(repo, "fixup! fixup! thing");
    expect((await run()).evidence).toEqual([`${short(id)} fixup! fixup! thing`]);
  });

  it("reports a commit a merge brings in and the merge itself, a parent first", async () => {
    await git(repo, ["checkout", "--quiet", "-b", "side"]);
    const inner = await commit(repo, "squash! inner", "side.txt");
    await git(repo, ["checkout", "--quiet", "main"]);
    await commit(repo, "main work");
    await git(repo, ["merge", "--no-ff", "--quiet", "-m", "amend! merge subject", "side"]);
    const merge = await git(repo, ["rev-parse", "HEAD"]);
    const record = await run();
    expect(record.evidence).toEqual([`${short(inner)} squash! inner`, `${short(merge)} amend! merge subject`]);
  });

  it("ignores a prefix further on, in capitals, or without its space", async () => {
    await commit(repo, "tidy fixup! later");
    await commit(repo, "FIXUP! upper");
    await commit(repo, "Fixup! mixed");
    await commit(repo, "fixup!nospace");
    await commit(repo, "fixup!");
    expect((await run()).status).toBe("pass");
  });

  it("reads the first paragraph, so a second line does not begin the subject", async () => {
    await commit(repo, "ordinary first line\nfixup! second line");
    expect((await run()).status).toBe("pass");
  });

  it("joins the lines of the first paragraph", async () => {
    const id = await commit(repo, "fixup! first\ncontinues here");
    expect((await run()).evidence).toEqual([`${short(id)} fixup! first continues here`]);
  });

  it("ignores a body line that begins with a prefix", async () => {
    await commit(repo, "ordinary\n\nfixup! in the body");
    expect((await run()).status).toBe("pass");
  });

  it("ignores a commit the base already holds", async () => {
    const held = await commit(repo, "fixup! held");
    await commit(repo, "ordinary");
    expect((await run("HEAD", held)).status).toBe("pass");
  });

  it("escapes characters outside printable ASCII", async () => {
    const id = await commit(repo, "fixup! café \u{1F600}\ttab");
    expect((await run()).evidence).toEqual([`${short(id)} fixup! caf\\u{00e9} \\u{1f600}\\u{0009}tab`]);
  });

  it("applies an entry appended to AUTOSQUASH_PREFIXES", async () => {
    const id = await commit(repo, "wip! thing");
    expect((await run()).status).toBe("pass");
    AUTOSQUASH_PREFIXES.push("wip! ");
    try {
      expect((await run()).evidence).toEqual([`${short(id)} wip! thing`]);
    } finally {
      AUTOSQUASH_PREFIXES.pop();
    }
  });

  it("fails, naming the revision, when a revision names no commit", async () => {
    const record = await run("no-such-branch");
    expect(record.status).toBe("fail");
    expect(record.evidence.join("\n")).toContain("no-such-branch");
    const other = await run("HEAD", "missing-base");
    expect(other.status).toBe("fail");
    expect(other.evidence.join("\n")).toContain("missing-base");
  });

  it("fails rather than throws outside a repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "repo-truth-autosquash-none-"));
    try {
      const record = await check({ cwd: dir, base: "HEAD", candidate: "HEAD" });
      expect(record.status).toBe("fail");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes a tilde, the last printable ASCII character, as it is", async () => {
    const id = await commit(repo, "fixup! a~b");
    expect((await run()).evidence).toEqual([`${short(id)} fixup! a~b`]);
  });

  it("reports git's own complaint when a commit of the range cannot be read", async () => {
    const lost = await commit(repo, "lost");
    await commit(repo, "tip");
    const gitDir = await git(repo, ["rev-parse", "--absolute-git-dir"]);
    await unlink(join(gitDir, "objects", lost.slice(0, FAN_OUT_LENGTH), lost.slice(FAN_OUT_LENGTH)));
    const record = await run();
    expect(record.status).toBe("fail");
    expect(record.evidence).toHaveLength(1);
    const line = record.evidence[0] ?? "";
    expect(line.startsWith("git failed: ")).toBe(true);
    expect(line.startsWith("git failed: Command failed")).toBe(false);
    expect(line).toContain("fatal");
  });

  it("is the only record `repo-truth check --check RT-29` prints", async () => {
    await commit(repo, "fixup! leftover");
    let stdout = "";
    await main(["check", "--check", "RT-29", "--no-fetch", "--base", base, "--candidate", "main", "--format", "json"], {
      cwd: repo,
      stdout: (t) => void (stdout += t),
      stderr: () => undefined,
    });
    const parsed = JSON.parse(stdout) as unknown;
    const records = (Array.isArray(parsed) ? parsed : (parsed as { records: unknown[] }).records) as { name: string }[];
    expect(records.map((r) => r.name)).toEqual(["RT-29"]);
  });
});
