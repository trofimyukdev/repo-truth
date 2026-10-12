import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkSymlinks } from "../../src/symlinks.js";

const execFileAsync = promisify(execFile);

const SHORT_ID_LENGTH = 12;
const ASTRAL_CODE_POINT = 0x1f600;
const ETHIOPIC_CODE_POINT = 0xabcd;

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

async function commitAll(cwd: string): Promise<string> {
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "--quiet", "--allow-empty", "-m", "change"]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

async function file(cwd: string, name: string, text = "x\n"): Promise<void> {
  await mkdir(dirname(join(cwd, name)), { recursive: true });
  await writeFile(join(cwd, name), text);
}

async function link(cwd: string, name: string, target: string): Promise<void> {
  await mkdir(dirname(join(cwd, name)), { recursive: true });
  await rm(join(cwd, name), { force: true });
  await symlink(target, join(cwd, name));
}

describe("checkSymlinks", () => {
  let repo: string;
  let base: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "repo-truth-symlinks-"));
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
    await git(repo, ["config", "core.symlinks", "true"]);
    await file(repo, "README.md");
    await file(repo, "sub/inner.txt");
    base = await commitAll(repo);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function run(): Promise<{ status: string; evidence: readonly string[]; name: string }> {
    const candidate = await commitAll(repo);
    return checkSymlinks({ cwd: repo, base, candidate });
  }

  it("passes a range with no links", async () => {
    await file(repo, "a.txt");
    const record = await run();
    expect(record.name).toBe("RT-11");
    expect(record.status).toBe("pass");
  });

  it("passes links that stay inside, dangling or not, and resolves .. from the link's directory", async () => {
    await link(repo, "sub/up", "../README.md");
    await link(repo, "a/b/deep", "../../README.md");
    await link(repo, "dangling", "nothing/here");
    await link(repo, "dots", "a/b/../../README.md");
    await link(repo, "gitish", ".github/x");
    const record = await run();
    expect(record.evidence).toHaveLength(1);
    expect(record.status).toBe("pass");
  });

  it.each([
    ["/etc/passwd", "absolute"],
    ["\\\\host\\share", "absolute"],
    ["C:\\Windows", "absolute"],
    ["../outside", "outside"],
    ["../../x", "outside"],
    ["sub/../../x", "outside"],
    ["sub/../..", "outside"],
    [".git/config", ".git"],
    [".GIT/hooks", ".git"],
    ["sub/../.Git", ".git"],
  ])("reports %s by rule %s", async (target, rule) => {
    await link(repo, "bad", target);
    const record = await run();
    expect(record.status).toBe("fail");
    expect(record.evidence).toHaveLength(1);
    const line = record.evidence[0] ?? "";
    expect(line).toContain("bad");
    expect(line).toContain(target);
    expect(line).toContain(`[${rule}]`);
  });

  it("resolves from the link's directory: a/b/../../../x escapes, from a deep link it does not", async () => {
    await link(repo, "esc", "a/b/../../../x");
    await link(repo, "p/q/r/ok", "../../../README.md");
    await link(repo, "p/q/gitlink", "../../.git/HEAD");
    const record = await run();
    expect(record.status).toBe("fail");
    expect(record.evidence).toHaveLength(2);
    expect(record.evidence.some((l) => l.includes('"esc"') && l.includes("[outside]"))).toBe(true);
    expect(record.evidence.some((l) => l.includes("p/q/gitlink") && l.includes("[.git]"))).toBe(true);
  });

  it("reads a link the range retargets", async () => {
    await link(repo, "moving", "README.md");
    base = await commitAll(repo);
    await link(repo, "moving", "/etc/shadow");
    const record = await run();
    expect(record.status).toBe("fail");
    expect(record.evidence[0]).toContain("[absolute]");
  });

  it("reads a file the range turns into a link", async () => {
    await file(repo, "was-file.txt");
    base = await commitAll(repo);
    await unlink(join(repo, "was-file.txt"));
    await link(repo, "was-file.txt", "../elsewhere");
    const record = await run();
    expect(record.status).toBe("fail");
    expect(record.evidence[0]).toContain("[outside]");
  });

  it("never reads a bad link the base already holds", async () => {
    await link(repo, "old", "/etc/passwd");
    base = await commitAll(repo);
    await file(repo, "new.txt");
    const record = await run();
    expect(record.status).toBe("pass");
  });

  it("never reads a link the range deletes", async () => {
    await link(repo, "old", "/etc/passwd");
    base = await commitAll(repo);
    await unlink(join(repo, "old"));
    const record = await run();
    expect(record.status).toBe("pass");
  });

  it("reads the committed blob, not the working tree", async () => {
    await link(repo, "swap", "README.md");
    const candidate = await commitAll(repo);
    await link(repo, "swap", "/etc/passwd");
    const record = await checkSymlinks({ cwd: repo, base, candidate });
    expect(record.status).toBe("pass");
  });

  it("escapes characters outside printable ASCII", async () => {
    await link(repo, "bad\u001b[2J", "/tmp/\u00e9\u001b]0;x");
    const record = await run();
    expect(record.status).toBe("fail");
    for (const line of record.evidence) {
      expect(/^[\x20-\x7e]*$/.test(line)).toBe(true);
    }
  });

  it("fails closed on a revision that names no commit", async () => {
    const record = await checkSymlinks({ cwd: repo, base: "no-such-rev", candidate: "HEAD" });
    expect(record.status).toBe("fail");
    expect(record.evidence.join("\n")).toContain("no-such-rev");
    const other = await checkSymlinks({ cwd: repo, base, candidate: "--output=x" });
    expect(other.status).toBe("fail");
    expect(other.evidence.join("\n")).toContain("--output=x");
  });

  it("fails closed when git cannot run in the directory", async () => {
    const record = await checkSymlinks({ cwd: join(repo, "does-not-exist"), base, candidate: "HEAD" });
    expect(record.status).toBe("fail");
    expect(record.evidence.length).toBeGreaterThan(0);
  });

  describe("errors and reading", () => {
    const extra: string[] = [];

    afterEach(async () => {
      for (const dir of extra.splice(0)) {
        await rm(dir, { recursive: true, force: true });
      }
    });

    async function throwaway(): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), "repo-truth-symlinks-extra-"));
      extra.push(dir);
      return dir;
    }

    async function rawLink(name: Buffer, target: Buffer): Promise<void> {
      await symlink(target, Buffer.concat([Buffer.from(`${repo}/`), name]));
    }

    it("carries git's own complaint, not node's wording, outside a repository", async () => {
      const dir = await throwaway();
      const record = await checkSymlinks({ cwd: dir, base: "HEAD", candidate: "HEAD" });
      expect(record.status).toBe("fail");
      expect(record.evidence).toHaveLength(1);
      const line = record.evidence[0] ?? "";
      expect(line).toMatch(/^revision "HEAD" names no commit: fatal: not a git repository/);
      expect(line).not.toContain("Command failed");
      expect(line.endsWith("}")).toBe(false);    });

    it("names the git command that refused a revision naming no commit", async () => {
      const first = await checkSymlinks({ cwd: repo, base: "no-such-rev", candidate: "HEAD" });
      expect(first.status).toBe("fail");
      expect(first.evidence).toHaveLength(1);
      expect(first.evidence[0]).toMatch(/^revision "no-such-rev" names no commit: .*rev-parse/);
      const second = await checkSymlinks({ cwd: repo, base, candidate: "also-missing" });
      expect(second.status).toBe("fail");
      expect(second.evidence).toHaveLength(1);
      expect(second.evidence[0]).toMatch(/^revision "also-missing" names no commit: .*rev-parse/);
    });

    it.each([
      ["", "HEAD", 'revision "" names no commit'],
      ["HEAD", "", 'revision "" names no commit'],
      ["-", "HEAD", 'revision "-" names no commit'],
      ["HEAD", "--output=x", 'revision "--output=x" names no commit'],
      ["-x", "HEAD", 'revision "-x" names no commit'],
    ])("refuses base %j and candidate %j before git runs", async (baseRev, candidateRev, expected) => {
      const record = await checkSymlinks({ cwd: repo, base: baseRev, candidate: candidateRev });
      expect(record.status).toBe("fail");
      expect(record.evidence).toEqual([expected]);
    });

    it("names two commits that share no history by their short ids", async () => {
      await git(repo, ["checkout", "--quiet", "--orphan", "unrelated"]);
      await git(repo, ["rm", "-r", "-f", "--quiet", "."]);
      await file(repo, "other.txt");
      const candidate = await commitAll(repo);
      const record = await checkSymlinks({ cwd: repo, base: "main", candidate: "unrelated" });
      expect(record.status).toBe("fail");
      expect(record.evidence).toHaveLength(1);
      const line = record.evidence[0] ?? "";
      const prefix = `no merge base of ${base.slice(0, SHORT_ID_LENGTH)} and ${candidate.slice(0, SHORT_ID_LENGTH)}`;
      expect(line.startsWith(prefix)).toBe(true);
      expect(line.slice(prefix.length)).not.toMatch(/^[0-9a-f]/);
    });

    it("prints a link's path and target with everything outside printable ASCII escaped", async () => {
      const astral = String.fromCodePoint(ASTRAL_CODE_POINT);
      const ethiopic = String.fromCodePoint(ETHIOPIC_CODE_POINT);
      const name = `a b~é\u007f${astral}\u001f${ethiopic}\t`;
      const target = `/ ~{}\\ÿĀ\u007f${astral}\u001f${ethiopic}\n`;
      await link(repo, name, target);
      const record = await run();
      expect(record.status).toBe("fail");
      expect(record.evidence).toEqual([
        'link "a b~\\u{00e9}\\u{007f}\\u{1f600}\\u{001f}\\u{abcd}\\u{0009}" -> ' +
          '"/ ~{}\\\\u{00ff}\\u{0100}\\u{007f}\\u{1f600}\\u{001f}\\u{abcd}\\u{000a}" breaks rule [absolute]',
      ]);
    });

    it("prints the range of a passing check with its revisions quoted", async () => {
      await file(repo, "a.txt");
      const candidate = await commitAll(repo);
      const record = await checkSymlinks({ cwd: repo, base, candidate });
      expect(record.evidence).toEqual([`0 link(s) added or changed in "${base}".."${candidate}" stay inside the repository`]);
    });

    it("reads a link whose target is not valid UTF-8 and judges it by the rules", async () => {
      await rawLink(Buffer.from("fine"), Buffer.from([0x6f, 0x6b, 0x2f, 0xff, 0x2f, 0x2e, 0x2e, 0x2f, 0xe9]));
      const record = await run();
      expect(record.name).toBe("RT-11");
      expect(record.status).toBe("pass");
      expect(record.evidence[0]).toMatch(/^1 link\(s\) added or changed/);
    });

    it("names an outside target that is not valid UTF-8, escaped", async () => {
      await rawLink(Buffer.from("away"), Buffer.from([0x2e, 0x2e, 0x2f, 0xe9, 0xff, 0xfe]));
      await rawLink(Buffer.from("abs"), Buffer.from([0x2f, 0xc3, 0x28]));
      const record = await run();
      expect(record.status).toBe("fail");
      expect(record.evidence).toEqual([
        'link "abs" -> "/\\u{00c3}(" breaks rule [absolute]',
        'link "away" -> "../\\u{00e9}\\u{00ff}\\u{00fe}" breaks rule [outside]',
      ]);
    });

    it("reads a link whose path is not valid UTF-8", async () => {
      await rawLink(Buffer.from([0x62, 0xff, 0xe9]), Buffer.from("/etc/passwd"));
      const record = await run();
      expect(record.status).toBe("fail");
      expect(record.evidence).toEqual(['link "b\\u{00ff}\\u{00e9}" -> "/etc/passwd" breaks rule [absolute]']);
    });
  });
});
