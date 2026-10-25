import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli.js";
import * as module from "../../src/checks/config-changes.js";
import { check, name } from "../../src/checks/config-changes.js";
import { SANCTION_KEY } from "../../src/weakened-tests.js";

const execFileAsync = promisify(execFile);

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "Test Committer",
  GIT_COMMITTER_EMAIL: "committer@example.com",
};

const CONFIG = "repo-truth.json";
const settings = (n: number): string => JSON.stringify({ schema: "repo-truth.config/v1", checks: { "RT-12": { maxBytes: n } } }, null, 2) + "\n";
const LONG = Array.from({ length: 30 }, (_, i) => `line ${i} of the settings`).join("\n") + "\n";

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
  await git(cwd, ["commit", "--quiet", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

describe("RT-66 configuration file changed", () => {
  let root: string;
  let repo: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "repo-truth-config-changes-")));
    repo = join(root, "repo");
    await mkdir(repo);
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function run(
    before: Record<string, string | null>,
    after: Record<string, string | null>,
    extra: { message?: string; sanctions?: Record<string, string>; config?: string; cwd?: string } = {},
  ) {
    const base = await commit(repo, { "keep.txt": "keep\n", ...before }, "base");
    const candidate = await commit(repo, after, extra.message ?? "change");
    return check({ cwd: extra.cwd ?? repo, base, candidate, config: extra.config, sanctions: extra.sanctions });
  }

  it("is named RT-66 and declares no options", () => {
    expect(name).toBe("RT-66");
    expect(Object.hasOwn(module, "optionKinds")).toBe(false);
  });

  it("passes a range that leaves the file alone", async () => {
    const record = await run({ [CONFIG]: settings(10) }, { "other.txt": "x\n" });
    expect(record).toEqual({ name, status: "pass", evidence: [`${CONFIG}: not added, changed, deleted or renamed`], findings: [] });
  });

  it("fails a range that adds the file", async () => {
    const record = await run({}, { [CONFIG]: settings(10) });
    expect(record.status).toBe("fail");
    expect(record.evidence).toEqual([`${CONFIG}: config-added`]);
    expect(record.findings).toEqual([{ id: `config-added:${CONFIG}`, category: "config-added", file: CONFIG, other: null, sanction: null }]);
  });

  it("fails a range that changes the file", async () => {
    const record = await run({ [CONFIG]: settings(10) }, { [CONFIG]: settings(99) });
    expect(record.status).toBe("fail");
    expect(record.evidence).toEqual([`${CONFIG}: config-changed`]);
  });

  it("fails a range that deletes the file", async () => {
    const record = await run({ [CONFIG]: settings(10) }, { [CONFIG]: null });
    expect(record.status).toBe("fail");
    expect(record.evidence).toEqual([`${CONFIG}: config-deleted`]);
  });

  it("fails a range that renames the file away, naming the other path", async () => {
    const record = await run({ [CONFIG]: LONG }, { [CONFIG]: null, "moved.json": LONG });
    expect(record.status).toBe("fail");
    expect(record.evidence).toEqual([`${CONFIG}: config-renamed (other path: moved.json)`]);
    expect(record.findings[0]?.other).toBe("moved.json");
  });

  it("fails a range that renames another file onto it", async () => {
    const record = await run({ "old.json": LONG }, { "old.json": null, [CONFIG]: LONG });
    expect(record.status).toBe("fail");
    expect(record.evidence).toEqual([`${CONFIG}: config-renamed (other path: old.json)`]);
  });

  it("watches repo-truth.json of the subdirectory the check is run in", async () => {
    const before = { "sub/repo-truth.json": settings(10), [CONFIG]: settings(10) };
    const sub = join(repo, "sub");
    const own = await run(before, { "sub/repo-truth.json": settings(99) }, { cwd: sub });
    expect(own.status).toBe("fail");
    expect(own.evidence).toEqual(["sub/repo-truth.json: config-changed"]);
    const top = await check({ cwd: sub, base: "HEAD~1", candidate: "HEAD" });
    expect(top.status).toBe("fail");
    const base = await commit(repo, { [CONFIG]: settings(50) }, "top");
    const topOnly = await commit(repo, { [CONFIG]: settings(60) }, "top again");
    expect((await check({ cwd: sub, base, candidate: topOnly })).status).toBe("pass");
  });

  describe("with a config path inside the repository", () => {
    const before = { "conf/a.json": settings(10), [CONFIG]: settings(10) };

    it("takes it relative to cwd", async () => {
      const record = await run(before, { "conf/a.json": settings(99) }, { config: "conf/a.json" });
      expect(record.status).toBe("fail");
      expect(record.evidence).toEqual(["conf/a.json: config-changed"]);
    });

    it("takes it absolute", async () => {
      const record = await run(before, { "conf/a.json": settings(99) }, { config: join(repo, "conf", "a.json") });
      expect(record.status).toBe("fail");
      expect(record.evidence).toEqual(["conf/a.json: config-changed"]);
    });

    it("takes it through a symbolic link to a directory of the repository", async () => {
      await symlink(join(repo, "conf"), join(root, "link"));
      const record = await run(before, { "conf/a.json": settings(99) }, { config: join(root, "link", "a.json") });
      expect(record.status).toBe("fail");
      expect(record.evidence).toEqual(["conf/a.json: config-changed"]);
    });

    it("passes a range that changes only repo-truth.json beside it", async () => {
      const record = await run(before, { [CONFIG]: settings(99) }, { config: "conf/a.json" });
      expect(record.status).toBe("pass");
    });

    it("fails when the directory cannot be read", async () => {
      const record = await run(before, { [CONFIG]: settings(99) }, { config: "missing/a.json" });
      expect(record.status).toBe("fail");
      expect(record.evidence[0]).toContain("missing/a.json");
    });
  });

  it("skips a config path outside the repository, naming it", async () => {
    const outside = join(root, "out.json");
    await writeFile(outside, settings(10));
    const record = await run({ [CONFIG]: settings(10) }, { [CONFIG]: settings(99) }, { config: outside });
    expect(record.status).toBe("skip");
    expect(record.evidence).toHaveLength(1);
    expect(record.evidence[0]).toContain(outside);
  });

  it("fails a revision that names no commit, outside config path included", async () => {
    await commit(repo, { "keep.txt": "keep\n" }, "base");
    const outside = join(root, "out.json");
    for (const config of [undefined, outside]) {
      const record = await check({ cwd: repo, base: "no-such-revision", candidate: "HEAD", config });
      expect(record.status).toBe("fail");
      expect(record.evidence[0]).toContain("no-such-revision");
    }
  });

  it("fails when git fails", async () => {
    const record = await check({ cwd: join(root, "nowhere"), base: "HEAD", candidate: "HEAD" });
    expect(record.status).toBe("fail");
  });

  describe("sanctions", () => {
    const before = { [CONFIG]: settings(10) };
    const after = { [CONFIG]: settings(99) };

    it("passes a finding a commit message line sanctions", async () => {
      const message = `loosen\n\n${SANCTION_KEY}: config-changed:${CONFIG} the limit was too small`;
      const record = await run(before, after, { message });
      expect(record.status).toBe("pass");
      expect(record.evidence).toEqual([`${CONFIG}: config-changed - sanctioned: the limit was too small`]);
    });

    it("passes a finding the caller's sanctions cover", async () => {
      const record = await run(before, after, { sanctions: { [`config-changed:${CONFIG}`]: "agreed" } });
      expect(record.status).toBe("pass");
      expect(record.evidence).toEqual([`${CONFIG}: config-changed - sanctioned: agreed`]);
    });

    it.each([
      ["another category", `config-deleted:${CONFIG} why`],
      ["another file", "config-changed:other.json why"],
      ["no reason", `config-changed:${CONFIG}`],
    ])("keeps failing on a line with %s", async (_label, line) => {
      const record = await run(before, after, { message: `loosen\n\n${SANCTION_KEY}: ${line}` });
      expect(record.status).toBe("fail");
    });
  });

  it("reads from the merge base: a change the other side made after it is a finding", async () => {
    await commit(repo, { [CONFIG]: settings(10) }, "base");
    const fork = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["checkout", "--quiet", "-b", "feature"]);
    const candidate = await commit(repo, { "feature.txt": "f\n" }, "feature");
    await git(repo, ["checkout", "--quiet", "main"]);
    const base = await commit(repo, { [CONFIG]: settings(99) }, "main moves on");
    expect(fork).not.toBe(base);
    // The other side's change to the file is not the candidate's.
    expect((await check({ cwd: repo, base, candidate })).status).toBe("pass");
    // The candidate side's change counts, and the working tree is never read.
    await git(repo, ["checkout", "--quiet", "feature"]);
    const loosened = await commit(repo, { [CONFIG]: settings(500) }, "feature loosens");
    await writeFile(join(repo, CONFIG), settings(10));
    const record = await check({ cwd: repo, base, candidate: loosened });
    expect(record.status).toBe("fail");
    expect(record.evidence).toEqual([`${CONFIG}: config-changed`]);
  });

  describe("how failures and odd inputs reach the evidence", () => {
    const FIRST_SIZE = 7;
    const LATER_SIZE = 8;
    const OUTSIDE = ": outside the repository, no range can change it";
    const PRINTABLE_COUNT = 95;
    const PRINTABLE_FIRST = 32;
    const PRINTABLE = Array.from({ length: PRINTABLE_COUNT }, (_, i) => String.fromCharCode(PRINTABLE_FIRST + i)).join("");

    it("reports git's own complaint when the directory is not a repository", async () => {
      const plain = join(root, "plain");
      await mkdir(plain);
      const record = await check({ cwd: plain, base: "HEAD", candidate: "HEAD" });
      expect(record.status).toBe("fail");
      expect(record.evidence).toHaveLength(1);
      const line = record.evidence[0] ?? "";
      const prefix = 'revision "HEAD" does not name a commit: ';
      expect(line.startsWith(prefix)).toBe(true);
      expect(line.length).toBeGreaterThan(prefix.length);
      expect(line).not.toContain("Command failed");
      expect(line).toMatch(/not a git repository/i);
    });

    it("fails with the two revisions named when they share no history", async () => {
      const base = await commit(repo, { "keep.txt": "keep\n" }, "base");
      await git(repo, ["checkout", "--quiet", "--orphan", "unrelated"]);
      const candidate = await commit(repo, { "other.txt": "other\n" }, "unrelated root");
      const record = await check({ cwd: repo, base, candidate });
      expect(record.status).toBe("fail");
      expect(record.evidence).toHaveLength(1);
      const prefix = `no merge base of "${base}" and "${candidate}": `;
      expect((record.evidence[0] ?? "").startsWith(prefix)).toBe(true);
      expect(record.findings).toEqual([]);
    });

    it("keeps every printable ASCII character of a revision and escapes the rest", async () => {
      await commit(repo, { "keep.txt": "keep\n" }, "base");
      const revision = `${PRINTABLE}\u0001\u001f\u007fé\u{1f600}`;
      const record = await check({ cwd: repo, base: revision, candidate: "HEAD" });
      expect(record.status).toBe("fail");
      expect(record.evidence).toHaveLength(1);
      const expected = `revision "${PRINTABLE}\\u{0001}\\u{001f}\\u{007f}\\u{00e9}\\u{1f600}" does not name a commit: `;
      expect((record.evidence[0] ?? "").startsWith(expected)).toBe(true);
    });

    it("writes a configuration path outside the repository with its odd characters escaped", async () => {
      const outside = join(root, "a b~é\u0001\u001f\u007f\u{1f600}.json");
      const record = await run({ [CONFIG]: settings(FIRST_SIZE) }, { [CONFIG]: settings(LATER_SIZE) }, { config: outside });
      expect(record.status).toBe("skip");
      expect(record.findings).toEqual([]);
      expect(record.evidence).toEqual([`${join(root, "a b~")}\\u{00e9}\\u{0001}\\u{001f}\\u{007f}\\u{1f600}.json${OUTSIDE}`]);
    });

    it.each([
      ["empty", ""],
      ["a dash", "-"],
      ["a dashed option", "--version"],
    ])("refuses %s before git runs, as base and as candidate", async (_label, revision) => {
      await commit(repo, { "keep.txt": "keep\n" }, "base");
      const asBase = await check({ cwd: repo, base: revision, candidate: "HEAD" });
      expect(asBase.status).toBe("fail");
      expect(asBase.evidence).toEqual([`revision "${revision}" does not name a commit`]);
      const asCandidate = await check({ cwd: repo, base: "HEAD", candidate: revision });
      expect(asCandidate.status).toBe("fail");
      expect(asCandidate.evidence).toEqual([`revision "${revision}" does not name a commit`]);
    });

    it("resolves a revision one character long that names a commit", async () => {
      await commit(repo, { "keep.txt": "keep\n" }, "base");
      const record = await check({ cwd: repo, base: "@", candidate: "@" });
      expect(record).toEqual({ name, status: "pass", evidence: [`${CONFIG}: not added, changed, deleted or renamed`], findings: [] });
    });

    it.each([
      ["the top directory by its absolute path", () => repo],
      ["the top directory as a dot", () => "."],
      ["the directory above it by its absolute path", () => root],
      ["the directory above it as two dots", () => ".."],
    ])("skips a configuration path naming %s", async (_label, pick) => {
      const config = pick();
      const record = await run({ [CONFIG]: settings(FIRST_SIZE) }, { [CONFIG]: settings(LATER_SIZE) }, { config });
      expect(record.status).toBe("skip");
      expect(record.findings).toEqual([]);
      expect(record.evidence).toEqual([`${config}${OUTSIDE}`]);
    });

    it("does not take a file whose name begins with two dots for outside the repository", async () => {
      const record = await run({ "..odd.json": settings(FIRST_SIZE) }, { "..odd.json": settings(LATER_SIZE) }, { config: "..odd.json" });
      expect(record.status).toBe("fail");
      expect(record.evidence).toEqual(["..odd.json: config-changed"]);
    });

    describe("the caller's sanctions", () => {
      const id = `config-changed:${CONFIG}`;
      const before = { [CONFIG]: settings(FIRST_SIZE) };
      const after = { [CONFIG]: settings(LATER_SIZE) };

      it.each([
        ["empty", ""],
        ["white space alone", " \t "],
      ])("sanction nothing with a reason that is %s", async (_label, reason) => {
        const record = await run(before, after, { sanctions: { [id]: reason } });
        expect(record.status).toBe("fail");
        expect(record.evidence).toEqual([`${CONFIG}: config-changed`]);
        expect(record.findings[0]?.sanction).toBeNull();
      });

      it("sanction a finding with a reason one character long", async () => {
        const record = await run(before, after, { sanctions: { [id]: "x" } });
        expect(record.status).toBe("pass");
        expect(record.evidence).toEqual([`${CONFIG}: config-changed - sanctioned: x`]);
        expect(record.findings[0]?.sanction).toBe("x");
      });
    });
  });

  it("main runs it with --check RT-66 and --config over such a range", async () => {
    await commit(repo, { "conf/a.json": settings(10) }, "base");
    await commit(repo, { "conf/a.json": settings(99) }, "loosen");
    const out: string[] = [];
    const code = await main(
      ["check", "--no-fetch", "--check", "RT-66", "--config", "conf/a.json", "--base", "HEAD~1", "--candidate", "HEAD", "--format", "json"],
      { cwd: repo, stdout: (text: string) => void out.push(text), stderr: () => {} },
    );
    expect(code).toBe(1);
    const record = (JSON.parse(out.join("")) as { records: { name: string; status: string; evidence: string[] }[] }).records[0];
    expect(record).toMatchObject({ name: "RT-66", status: "fail", evidence: ["conf/a.json: config-changed"] });
  });
});
