import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli.js";
import { BINARY_PROBE_BYTES, check, name, optionKinds } from "../../src/checks/binary-files.js";
import { SANCTION_KEY } from "../../src/weakened-tests.js";

const execFileAsync = promisify(execFile);

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "Test Committer",
  GIT_COMMITTER_EMAIL: "committer@example.com",
};

const PROBE = 8000;
const SMALL = 64;
const LARGE = 9000;
const EXECUTABLE = 0o755;

type Content = string | Buffer | null;

/** Bytes of the given length with a NUL byte at the given offset (none when `at` is null). */
const bytes = (length: number, at: number | null, fill = 0x61): Buffer => {
  const buffer = Buffer.alloc(length, fill);
  if (at !== null) buffer[at] = 0;
  return buffer;
};
const binary = (fill = 0x61): Buffer => bytes(SMALL, 3, fill);
const text = (fill = "a"): string => `${fill}\n`.repeat(SMALL);

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args as string[], { cwd, env: ENV });
  return stdout.trim();
}

async function commit(cwd: string, files: Record<string, Content>, message = "change"): Promise<string> {
  for (const [file, content] of Object.entries(files)) {
    if (content === null) await rm(join(cwd, file));
    else {
      await mkdir(dirname(join(cwd, file)), { recursive: true });
      await writeFile(join(cwd, file), content);
    }
  }
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "--quiet", "--allow-empty", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

describe("RT-55 binary files", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "repo-truth-binary-files-"));
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function run(
    before: Record<string, Content>,
    after: Record<string, Content>,
    extra: { message?: string; sanctions?: Record<string, string>; allowedSuffixes?: string[] } = {},
  ) {
    const base = await commit(repo, { "keep.txt": "keep\n", ...before }, "base");
    const candidate = await commit(repo, after, extra.message ?? "change");
    return check({ cwd: repo, base, candidate, sanctions: extra.sanctions, allowedSuffixes: extra.allowedSuffixes });
  }

  it("exports its name, probe size and option kinds", () => {
    expect(name).toBe("RT-55");
    expect(BINARY_PROBE_BYTES).toBe(PROBE);
    expect(optionKinds).toEqual({ allowedSuffixes: "strings" });
  });

  it("reports a binary file added", async () => {
    const record = await run({}, { "a.bin": binary() });
    expect(record.name).toBe("RT-55");
    expect(record.status).toBe("fail");
    expect(record.findings.map((f) => f.id)).toEqual(["binary-added:a.bin"]);
    expect(record.evidence).toHaveLength(1);
    expect(record.evidence[0]).toMatch(/^a\.bin:.*binary-added.*64 bytes/);
  });

  it("reports a text file turned binary as added", async () => {
    const record = await run({ "a.dat": text() }, { "a.dat": binary() });
    expect(record.status).toBe("fail");
    expect(record.findings.map((f) => f.category)).toEqual(["binary-added"]);
  });

  it("reports a binary file changed", async () => {
    const record = await run({ "a.dat": binary(0x61) }, { "a.dat": binary(0x62) });
    expect(record.status).toBe("fail");
    expect(record.findings.map((f) => f.category)).toEqual(["binary-changed"]);
  });

  it("passes a binary file renamed as it was", async () => {
    const record = await run({ "a.bin": binary() }, { "a.bin": null, "b.bin": binary() });
    expect(record.status).toBe("pass");
    expect(record.evidence).toEqual(["no binary file added or changed"]);
  });

  it("reports a binary file renamed with its content changed", async () => {
    const record = await run({ "a.bin": bytes(LARGE, 3, 0x61) }, { "a.bin": null, "b.bin": bytes(LARGE, 3, 0x62) });
    expect(record.status).toBe("fail");
    expect(record.findings.map((f) => f.id)).toEqual(["binary-changed:b.bin"]);
    expect(record.evidence[0]).toContain(`${LARGE} bytes`);
  });

  it("passes a binary file deleted and one left alone", async () => {
    const record = await run({ "gone.bin": binary(), "stay.bin": binary(0x62) }, { "gone.bin": null, "other.txt": text() });
    expect(record.status).toBe("pass");
    expect(record.findings).toEqual([]);
  });

  it("probes the first eight thousand bytes and no more", async () => {
    const inside = await run({}, { "in.dat": bytes(LARGE, PROBE - 1) });
    expect(inside.findings.map((f) => f.path)).toEqual(["in.dat"]);
    const outside = await run({}, { "out.dat": bytes(LARGE, PROBE) });
    expect(outside.status).toBe("pass");
  });

  it("decides nothing by .gitattributes or by name", async () => {
    const record = await run({}, { ".gitattributes": "*.txt binary\n", "a.txt": text(), "b.png": text("b") });
    expect(record.status).toBe("pass");
  });

  it("reads the candidate's blob, not the working tree", async () => {
    const base = await commit(repo, { "a.dat": text() }, "base");
    const candidate = await commit(repo, { "a.dat": binary() }, "change");
    await writeFile(join(repo, "a.dat"), text("z"));
    const record = await check({ cwd: repo, base, candidate });
    expect(record.status).toBe("fail");
    const clean = await commit(repo, { "c.dat": text() }, "later");
    await writeFile(join(repo, "c.dat"), binary());
    expect((await check({ cwd: repo, base: candidate, candidate: clean })).status).toBe("pass");
  });

  it("passes a symbolic link", async () => {
    await commit(repo, { "keep.txt": "keep\n" }, "base");
    const base = await git(repo, ["rev-parse", "HEAD"]);
    await symlink("target\0name", join(repo, "link")).catch(() => symlink("target", join(repo, "link")));
    const candidate = await commit(repo, {}, "link");
    const record = await check({ cwd: repo, base, candidate });
    expect(record.status).toBe("pass");
  });

  it("lets an allowed suffix through, matched only at the end of the path", async () => {
    const allowed = await run({}, { "img/a.png": binary() }, { allowedSuffixes: [".png"] });
    expect(allowed.status).toBe("pass");
    const inside = await run({}, { "b.png.bin": binary() }, { allowedSuffixes: [".png"] });
    expect(inside.findings.map((f) => f.path)).toEqual(["b.png.bin"]);
  });

  it("is sanctioned by a line in a commit message", async () => {
    const record = await run({}, { "a.bin": binary() }, { message: `add\n\n${SANCTION_KEY}: binary-added:a.bin fixture image` });
    expect(record.status).toBe("pass");
    expect(record.evidence[0]).toMatch(/^a\.bin:.*sanctioned.*fixture image/);
  });

  it("is sanctioned by the caller", async () => {
    const record = await run({}, { "a.bin": binary() }, { sanctions: { "binary-added:a.bin": "needed" } });
    expect(record.status).toBe("pass");
    expect(record.evidence[0]).toMatch(/sanctioned.*needed/);
  });

  it("is not sanctioned by a line written in a file", async () => {
    const record = await run({}, { "a.bin": binary(), "NOTES.md": `${SANCTION_KEY}: binary-added:a.bin because\n` });
    expect(record.status).toBe("fail");
  });

  it("escapes characters outside printable ASCII in the path", async () => {
    const record = await run({}, { "café.bin": binary() });
    expect(record.evidence[0]).toMatch(/^caf\\u\{00e9\}\.bin:/);
  });

  it("fails closed on a revision that names no commit", async () => {
    await commit(repo, { "a.txt": text() }, "base");
    const record = await check({ cwd: repo, base: "no-such-branch", candidate: "HEAD" });
    expect(record.status).toBe("fail");
    expect(record.evidence.join(" ")).toContain("no-such-branch");
  });

  it("fails closed when git itself fails", async () => {
    const record = await check({ cwd: join(repo, "does-not-exist"), base: "HEAD", candidate: "HEAD" });
    expect(record.status).toBe("fail");
    expect(record.evidence.length).toBeGreaterThan(0);
  });

  it("is the only record `repo-truth check --check RT-55` prints", async () => {
    await commit(repo, { "keep.txt": "keep\n" }, "base");
    await commit(repo, { "a.bin": binary() }, "change");
    let stdout = "";
    const code = await main(["check", "--check", "RT-55", "--no-fetch", "--base", "HEAD~1", "--candidate", "main", "--format", "json"], {
      cwd: repo,
      stdout: (t) => void (stdout += t),
      stderr: () => undefined,
    });
    expect(code).not.toBe(0);
    const parsed = JSON.parse(stdout) as unknown;
    const records = (Array.isArray(parsed) ? parsed : (parsed as { records: unknown[] }).records) as { name: string }[];
    expect(records.map((r) => r.name)).toEqual(["RT-55"]);
  });

  describe("revisions", () => {
    it("names git's own complaint for a revision git does not resolve", async () => {
      const head = await commit(repo, { "a.txt": text() }, "base");
      const base = await check({ cwd: repo, base: "no-such-branch", candidate: head });
      expect(base.status).toBe("fail");
      const prefix = 'revision "no-such-branch" does not name a commit: ';
      expect(base.evidence).toHaveLength(1);
      expect(base.evidence[0]?.startsWith(prefix)).toBe(true);
      expect(base.evidence[0]?.length).toBeGreaterThan(prefix.length);
      const candidate = await check({ cwd: repo, base: head, candidate: "gone-branch" });
      expect(candidate.status).toBe("fail");
      const other = 'revision "gone-branch" does not name a commit: ';
      expect(candidate.evidence[0]?.startsWith(other)).toBe(true);
      expect(candidate.evidence[0]?.length).toBeGreaterThan(other.length);
    });

    it("refuses an empty revision and one that begins with a dash before git is asked", async () => {
      const head = await commit(repo, { "a.txt": text() }, "base");
      const empty = ['revision "" does not name a commit'];
      const dash = ['revision "-x" does not name a commit'];
      expect((await check({ cwd: repo, base: "", candidate: head })).evidence).toEqual(empty);
      expect((await check({ cwd: repo, base: head, candidate: "" })).evidence).toEqual(empty);
      expect((await check({ cwd: repo, base: "-x", candidate: head })).evidence).toEqual(dash);
      expect((await check({ cwd: repo, base: head, candidate: "-x" })).evidence).toEqual(dash);
      expect((await check({ cwd: repo, base: "", candidate: head })).status).toBe("fail");
    });

    it("reads a revision one character long like any other", async () => {
      const base = await commit(repo, { "a.txt": text() }, "base");
      await git(repo, ["branch", "b", base]);
      await commit(repo, { "a.bin": binary() }, "change");
      const record = await check({ cwd: repo, base: "b", candidate: "main" });
      expect(record.status).toBe("fail");
      expect(record.evidence).toEqual(["a.bin: binary-added, 64 bytes"]);
      const same = await check({ cwd: repo, base: "main", candidate: "b" });
      expect(same.evidence[0]?.startsWith("revision")).toBe(false);
    });
  });

  describe("content and entries", () => {
    it("reads a file whose only NUL byte is its first byte as binary", async () => {
      const record = await run({}, { "a.bin": bytes(SMALL, 0) });
      expect(record.status).toBe("fail");
      expect(record.evidence).toEqual(["a.bin: binary-added, 64 bytes"]);
    });

    it("reports a binary file added with the executable mode", async () => {
      const base = await commit(repo, { "keep.txt": "keep\n" }, "base");
      await writeFile(join(repo, "run.bin"), binary());
      await chmod(join(repo, "run.bin"), EXECUTABLE);
      const candidate = await commit(repo, {}, "change");
      expect(await git(repo, ["ls-tree", candidate, "run.bin"])).toMatch(/^100755 /);
      const record = await check({ cwd: repo, base, candidate });
      expect(record.status).toBe("fail");
      expect(record.evidence).toEqual(["run.bin: binary-added, 64 bytes"]);
    });

    it("takes a submodule entry for no file", async () => {
      const base = await commit(repo, { "keep.txt": "keep\n" }, "base");
      await git(repo, ["update-index", "--add", "--cacheinfo", `160000,${base},sub`]);
      await git(repo, ["commit", "--quiet", "-m", "submodule"]);
      const candidate = await git(repo, ["rev-parse", "HEAD"]);
      expect(await git(repo, ["ls-tree", candidate, "sub"])).toMatch(/^160000 /);
      const record = await check({ cwd: repo, base, candidate });
      expect(record.status).toBe("pass");
      expect(record.evidence).toEqual(["no binary file added or changed"]);
    });

    it("writes a path that holds a tilde as it is", async () => {
      const record = await run({}, { "a~b.bin": binary() });
      expect(record.evidence).toEqual(["a~b.bin: binary-added, 64 bytes"]);
    });

    it("writes a space as it is and escapes the characters either side of the printable range", async () => {
      const record = await run({}, { "a b.bin": binary(), "c\x1fd.bin": binary(), "e\x7ff.bin": binary() });
      expect(record.evidence).toEqual([
        "a b.bin: binary-added, 64 bytes",
        "c\\u{001f}d.bin: binary-added, 64 bytes",
        "e\\u{007f}f.bin: binary-added, 64 bytes",
      ]);
    });

    it("lists findings in the order of their paths", async () => {
      const added = await run({}, { "b.bin": binary(), "a.bin": binary() });
      expect(added.findings.map((f) => f.id)).toEqual(["binary-added:a.bin", "binary-added:b.bin"]);
      expect(added.evidence.map((e) => e.slice(0, 5))).toEqual(["a.bin", "b.bin"]);
    });

    it("lists a changed file before an added one when its path comes first", async () => {
      const record = await run({ "a.bin": binary(0x61) }, { "a.bin": binary(0x62), "b.bin": binary() });
      expect(record.findings.map((f) => f.id)).toEqual(["binary-changed:a.bin", "binary-added:b.bin"]);
      expect(record.evidence.map((e) => e.slice(0, 5))).toEqual(["a.bin", "b.bin"]);
    });
  });

  describe("options and sanctions", () => {
    it("lets nothing through on an empty allowed suffix", async () => {
      const record = await run({}, { "a.bin": binary() }, { allowedSuffixes: [""] });
      expect(record.status).toBe("fail");
      expect(record.findings.map((f) => f.id)).toEqual(["binary-added:a.bin"]);
    });

    it("lets through a path that ends with a suffix one character long", async () => {
      const record = await run({}, { "a.bin": binary() }, { allowedSuffixes: ["n"] });
      expect(record.status).toBe("pass");
      expect(record.evidence).toEqual(["no binary file added or changed"]);
    });

    it("sanctions a finding with a caller's reason one character long", async () => {
      const record = await run({}, { "a.bin": binary() }, { sanctions: { "binary-added:a.bin": "x" } });
      expect(record.status).toBe("pass");
      expect(record.evidence).toEqual(["a.bin: binary-added, 64 bytes - sanctioned: x"]);
      expect(record.findings[0]?.sanction).toBe("x");
    });

    it("sanctions a finding with a commit line's reason one character long", async () => {
      const record = await run({}, { "a.bin": binary() }, { message: `add\n\n${SANCTION_KEY}: binary-added:a.bin x` });
      expect(record.status).toBe("pass");
      expect(record.evidence).toEqual(["a.bin: binary-added, 64 bytes - sanctioned: x"]);
    });

    it("sanctions nothing on a reason of white space alone", async () => {
      const given = await run({}, { "a.bin": binary() }, { sanctions: { "binary-added:a.bin": "  \t " } });
      expect(given.status).toBe("fail");
      expect(given.findings[0]?.sanction).toBeNull();
      const line = await run({}, { "b.bin": binary() }, { message: `add\n\n${SANCTION_KEY}: binary-added:b.bin   ` });
      expect(line.status).toBe("fail");
    });

    it("is not sanctioned by a line that names another file", async () => {
      const record = await run({}, { "a.bin": binary() }, { message: `add\n\n${SANCTION_KEY}: binary-added:b.bin because` });
      expect(record.status).toBe("fail");
      expect(record.findings[0]?.sanction).toBeNull();
      expect(record.evidence).toEqual(["a.bin: binary-added, 64 bytes"]);
    });
  });
});
