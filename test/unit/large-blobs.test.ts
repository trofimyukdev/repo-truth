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

  describe("evidence", () => {
    const OVER_SIZE = 2000;
    const LIMIT_SIZE = 1000;
    const NAMES_NO_COMMIT = "large-blobs check could not run: revision";

    const findingFor = async (name: string | Buffer): Promise<string> => {
      const target = typeof name === "string" ? join(repo, name) : Buffer.concat([Buffer.from(`${repo}/`), name]);
      await writeFile(target, blob(OVER_SIZE));
      await git(repo, ["add", "-A"]);
      await git(repo, ["commit", "--quiet", "-m", "named"]);
      const candidate = await git(repo, ["rev-parse", "HEAD"]);
      const record = await checkLargeBlobs({ cwd: repo, base, candidate, maxBytes: LIMIT_SIZE });
      expect(record.status).toBe("fail");
      expect(record.evidence).toHaveLength(1);
      return record.evidence[0] as string;
    };

    it("carries git's own complaint for a directory that is not a repository", async () => {
      const dir = await mkdtemp(join(tmpdir(), "repo-truth-not-a-repo-"));
      try {
        const record = await checkLargeBlobs({ cwd: dir, base: "a", candidate: "b" });
        expect(record.status).toBe("fail");
        expect(record.evidence).toHaveLength(1);
        expect(record.evidence[0]).toContain(`${NAMES_NO_COMMIT} "a" names no commit: `);
        expect(record.evidence[0]).toContain("not a git repository");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("carries, after the revision, the message of the git command that refused it", async () => {
      const record = await checkLargeBlobs({ cwd: repo, base, candidate: "no-such-rev" });
      expect(record.status).toBe("fail");
      expect(record.evidence).toHaveLength(1);
      expect((record.evidence[0] as string).trimEnd()).toBe(
        `${NAMES_NO_COMMIT} "no-such-rev" names no commit: Command failed: git rev-parse --verify --quiet no-such-rev^{commit}`,
      );
      const first = await checkLargeBlobs({ cwd: repo, base: "no-such-base", candidate: base });
      expect(first.evidence[0]).toMatch(/^large-blobs check could not run: revision "no-such-base" names no commit: ./);
    });

    it.each(["", "-x", "--all", "-"])("refuses the revision %j before git runs", async (revision) => {
      const asBase = await checkLargeBlobs({ cwd: repo, base: revision, candidate: base });
      expect(asBase).toEqual({
        name: "RT-12",
        status: "fail",
        evidence: [`${NAMES_NO_COMMIT} "${revision}" names no commit`],
      });
      const asCandidate = await checkLargeBlobs({ cwd: repo, base, candidate: revision });
      expect(asCandidate.status).toBe("fail");
      expect(asCandidate.evidence).toEqual([`${NAMES_NO_COMMIT} "${revision}" names no commit`]);
    });

    it("refuses a bad revision before git runs even where there is no repository", async () => {
      const dir = await mkdtemp(join(tmpdir(), "repo-truth-not-a-repo-"));
      try {
        const record = await checkLargeBlobs({ cwd: dir, base: "-x", candidate: "b" });
        expect(record.evidence).toEqual([`${NAMES_NO_COMMIT} "-x" names no commit`]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("escapes every character below 0x20, 0x7f and 0x80 to 0x9f in a path", async () => {
      const cases: [string, string][] = [
        ["a\u0001b", "a\\u{0001}b"],
        ["a\tb", "a\\u{0009}b"],
        ["a\u001fb", "a\\u{001f}b"],
        ["a\u007fb", "a\\u{007f}b"],
        ["a\u0080b", "a\\u{0080}b"],
        ["a\u009fb", "a\\u{009f}b"],
        ["a\u001bb", "a\\u{001b}b"],
      ];
      for (const [name, shown] of cases) {
        const line = await findingFor(name);
        expect(line).toBe(`"${shown}" is ${OVER_SIZE} bytes, over the limit of ${LIMIT_SIZE} bytes`);
        await git(repo, ["reset", "--quiet", "--hard", base]);
      }
    });

    it("prints a space, a tilde and the character 0xa0 as they are", async () => {
      const name = "a b~c d";
      const line = await findingFor(name);
      expect(line).toBe(`"${name}" is ${OVER_SIZE} bytes, over the limit of ${LIMIT_SIZE} bytes`);
    });

    it("reports a blob whose path is not valid UTF-8 as a finding, its path read byte for byte", async () => {
      const name = Buffer.from([0x62, 0x61, 0x64, 0xe9, 0x80, 0xff, 0x2e, 0x62, 0x69, 0x6e]);
      const line = await findingFor(name);
      expect(line).toBe(`"badé\\u{0080}ÿ.bin" is ${OVER_SIZE} bytes, over the limit of ${LIMIT_SIZE} bytes`);
      expect(line).not.toContain("could not run");
    });
  });
});
