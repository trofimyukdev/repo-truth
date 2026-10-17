import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli.js";
import { check, name } from "../../src/checks/script-changes.js";
import { SANCTION_KEY } from "../../src/weakened-tests.js";

const execFileAsync = promisify(execFile);

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "Test Committer",
  GIT_COMMITTER_EMAIL: "committer@example.com",
};

const MANIFEST = "package.json";
const NESTED = "packages/app/package.json";
const INDENT = 4;

const manifest = (scripts: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}, indent = 2): string =>
  JSON.stringify({ name: "fixture", ...extra, ...(scripts === undefined ? {} : { scripts }) }, null, indent) + "\n";

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

describe("RT-33 ladder commands changed", () => {
  let repo: string;
  const strays: string[] = [];

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "repo-truth-script-changes-"));
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    for (const stray of strays.splice(0)) await rm(stray, { recursive: true, force: true });
  });

  async function run(
    before: Record<string, string | null>,
    after: Record<string, string | null>,
    extra: { message?: string; sanctions?: Record<string, string> } = {},
  ) {
    const base = await commit(repo, { "keep.txt": "keep\n", ...before }, "base");
    const candidate = await commit(repo, after, extra.message ?? "change");
    return check({ cwd: repo, base, candidate, sanctions: extra.sanctions });
  }

  it("is named RT-33", () => {
    expect(name).toBe("RT-33");
  });

  it("reports an entry added", async () => {
    const record = await run({ [MANIFEST]: manifest({ test: "vitest" }) }, { [MANIFEST]: manifest({ test: "vitest", lint: "eslint ." }) });
    expect(record.name).toBe("RT-33");
    expect(record.status).toBe("fail");
    expect(record.findings.map((f) => [f.category, f.id])).toEqual([["script-added", "script-added:package.json:lint"]]);
    expect(record.evidence).toHaveLength(1);
    expect(record.evidence[0]).toMatch(/^package\.json:.*added.*"lint".*"eslint \."/);
  });

  it("reports an entry removed", async () => {
    const record = await run({ [MANIFEST]: manifest({ test: "vitest", lint: "eslint ." }) }, { [MANIFEST]: manifest({ test: "vitest" }) });
    expect(record.status).toBe("fail");
    expect(record.findings.map((f) => f.category)).toEqual(["script-removed"]);
    expect(record.evidence[0]).toMatch(/^package\.json:.*removed.*"lint".*"eslint \."/);
  });

  it("reports an entry changed with both commands", async () => {
    const record = await run({ [MANIFEST]: manifest({ test: "vitest run" }) }, { [MANIFEST]: manifest({ test: "vitest run --passWithNoTests" }) });
    expect(record.status).toBe("fail");
    expect(record.findings.map((f) => f.category)).toEqual(["script-changed"]);
    expect(record.evidence[0]).toMatch(/^package\.json:.*changed.*"test".*"vitest run".*"vitest run --passWithNoTests"/);
  });

  it("reads a manifest below the root", async () => {
    const record = await run({ [NESTED]: manifest({ test: "a" }) }, { [NESTED]: manifest({ test: "b" }) });
    expect(record.status).toBe("fail");
    expect(record.findings[0]?.id).toBe(`script-changed:${NESTED}:test`);
    expect(record.evidence[0]?.startsWith(`${NESTED}:`)).toBe(true);
  });

  it("reports every entry of a manifest the range adds", async () => {
    const record = await run({}, { [MANIFEST]: manifest({ test: "vitest", build: "tsc" }) });
    expect(record.status).toBe("fail");
    expect(record.findings.map((f) => f.category)).toEqual(["script-added", "script-added"]);
  });

  it("reports every entry of a manifest the range deletes", async () => {
    const record = await run({ [MANIFEST]: manifest({ test: "vitest", build: "tsc" }) }, { [MANIFEST]: null });
    expect(record.status).toBe("fail");
    expect(record.findings.map((f) => f.category)).toEqual(["script-removed", "script-removed"]);
  });

  it("says nothing of a manifest renamed with its scripts as they were", async () => {
    const body = manifest({ test: "vitest" }, { description: "a fixture manifest long enough to be a rename" });
    const record = await run({ [NESTED]: body }, { [NESTED]: null, "packages/web/package.json": body });
    expect(record.status).toBe("pass");
    expect(record.evidence).toEqual(["no scripts entry added, removed or changed"]);
  });

  it("reads a renamed manifest at its old path at the merge base", async () => {
    const body = manifest({ test: "vitest" }, { description: "a fixture manifest long enough to be a rename" });
    const edited = manifest({ test: "true" }, { description: "a fixture manifest long enough to be a rename" });
    const record = await run({ [NESTED]: body }, { [NESTED]: null, "packages/web/package.json": edited });
    expect(record.findings.map((f) => f.id)).toEqual(["script-changed:packages/web/package.json:test"]);
  });

  it("says nothing of a change to another field", async () => {
    const record = await run({ [MANIFEST]: manifest({ test: "vitest" }) }, { [MANIFEST]: manifest({ test: "vitest" }, { version: "9.9.9" }) });
    expect(record.status).toBe("pass");
  });

  it("says nothing of a reordering of the keys or a change of white space", async () => {
    const record = await run(
      { [MANIFEST]: manifest({ test: "vitest", build: "tsc" }) },
      { [MANIFEST]: manifest({ build: "tsc", test: "vitest" }, {}, INDENT) },
    );
    expect(record.status).toBe("pass");
    expect(record.findings).toEqual([]);
  });

  it("says nothing of a manifest the range leaves alone", async () => {
    const record = await run({ [MANIFEST]: manifest({ test: "vitest" }) }, { "other.txt": "x\n" });
    expect(record.status).toBe("pass");
  });

  it("holds no scripts for a manifest without a scripts field", async () => {
    const record = await run({ [MANIFEST]: manifest(undefined) }, { [MANIFEST]: manifest(undefined, { version: "1.0.0" }) });
    expect(record.status).toBe("pass");
  });

  it("fails on a manifest that is not JSON at the candidate", async () => {
    const record = await run({ [MANIFEST]: manifest({ test: "vitest" }) }, { [MANIFEST]: "{ not json" });
    expect(record.status).toBe("fail");
    expect(record.evidence.join("\n")).toContain("package.json");
    expect(record.evidence.join("\n")).toContain("candidate");
  });

  it("fails on a manifest that is not JSON at the merge base", async () => {
    const record = await run({ [MANIFEST]: "[1]" }, { [MANIFEST]: manifest({ test: "vitest" }) });
    expect(record.status).toBe("fail");
    expect(record.evidence.join("\n")).toContain("merge base");
  });

  it.each([[["a"]], [{ test: 1 }], ["vitest"], [null]])("fails on a scripts field that is not an object of strings: %j", async (scripts) => {
    const bad = JSON.stringify({ name: "fixture", scripts });
    const record = await run({ [MANIFEST]: manifest({ test: "vitest" }) }, { [MANIFEST]: bad + "\n" });
    expect(record.status).toBe("fail");
    expect(record.evidence.join("\n")).toContain("package.json");
  });

  it("handles a key holding a colon and escapes what is not printable ASCII", async () => {
    const record = await run(
      { [MANIFEST]: manifest({ "test:unit": "a" }) },
      { [MANIFEST]: manifest({ "test:unit": "b\u001b[31mé" }) },
    );
    expect(record.findings[0]?.id).toBe("script-changed:package.json:test:unit");
    const text = record.evidence.join("\n");
    expect(text).toContain("\\u{001b}");
    expect(text).toContain("\\u{00e9}");
    expect(text).not.toContain("\u001b");
  });

  describe("sanctions", () => {
    const before = { [MANIFEST]: manifest({ test: "vitest", build: "tsc" }) };
    const after = { [MANIFEST]: manifest({ test: "true", build: "true" }) };

    it("accepts a line in a commit message", async () => {
      const message = `change\n\n${SANCTION_KEY}: script-changed:package.json:test the runner moved\n${SANCTION_KEY}: script-changed:package.json:build tsc moved`;
      const record = await run(before, after, { message });
      expect(record.status).toBe("pass");
      expect(record.evidence.join("\n")).toContain("sanctioned");
      expect(record.evidence.join("\n")).toContain("the runner moved");
    });

    it("fails while one finding is unsanctioned", async () => {
      const record = await run(before, after, { message: `change\n\n${SANCTION_KEY}: script-changed:package.json:test the runner moved` });
      expect(record.status).toBe("fail");
      expect(record.findings.filter((f) => f.sanction === null)).toHaveLength(1);
    });

    it("accepts a category and file", async () => {
      const record = await run(before, after, { message: `change\n\n${SANCTION_KEY}: script-changed:package.json both rewritten` });
      expect(record.status).toBe("pass");
    });

    it("accepts the caller's sanctions", async () => {
      const record = await run(before, after, { sanctions: { "script-changed:package.json": "reviewed by hand" } });
      expect(record.status).toBe("pass");
      expect(record.evidence.join("\n")).toContain("reviewed by hand");
    });

    it("does not read a sanction from a file", async () => {
      const record = await run(before, { ...after, "NOTES.md": `${SANCTION_KEY}: script-changed:package.json fine\n` });
      expect(record.status).toBe("fail");
    });
  });

  describe("errors", () => {
    it("carries git's own complaint for a directory that is not a repository", async () => {
      const plain = await mkdtemp(join(tmpdir(), "repo-truth-script-changes-plain-"));
      strays.push(plain);
      const record = await check({ cwd: plain, base: "HEAD", candidate: "HEAD" });
      expect(record.status).toBe("fail");
      expect(record.findings).toEqual([]);
      const text = record.evidence.join("\n");
      expect(text).toContain("not a git repository");
      expect(text).not.toContain("Command failed");
    });

    it.each([[""], ["-x"], ["--version"], ["-"]])("refuses the revision %j before git runs", async (revision) => {
      await commit(repo, { "a.txt": "a\n" }, "base");
      const asBase = await check({ cwd: repo, base: revision, candidate: "HEAD" });
      expect(asBase.status).toBe("fail");
      expect(asBase.evidence).toEqual([`revision "${revision}" does not name a commit`]);
      const asCandidate = await check({ cwd: repo, base: "HEAD", candidate: revision });
      expect(asCandidate.status).toBe("fail");
      expect(asCandidate.evidence).toEqual([`revision "${revision}" does not name a commit`]);
    });

    it("resolves a revision one character long that names a commit", async () => {
      const base = await commit(repo, { "keep.txt": "keep\n", [MANIFEST]: manifest({ test: "a" }) }, "base");
      await commit(repo, { [MANIFEST]: manifest({ test: "b" }) }, "change");
      const record = await check({ cwd: repo, base, candidate: "@" });
      expect(record.status).toBe("fail");
      expect(record.findings.map((f) => f.id)).toEqual(["script-changed:package.json:test"]);
      const same = await check({ cwd: repo, base: "@", candidate: "@" });
      expect(same.status).toBe("pass");
      expect(same.evidence).toEqual(["no scripts entry added, removed or changed"]);
    });
  });

  describe("manifests and text", () => {
    it.each([["5"], ["null"], ['"text"'], ["[1]"]])("names a manifest that is JSON but not an object at the candidate: %s", async (body) => {
      const record = await run({ [MANIFEST]: manifest({ test: "vitest" }) }, { [MANIFEST]: body + "\n" });
      expect(record.status).toBe("fail");
      expect(record.findings).toEqual([]);
      expect(record.evidence).toEqual(["package.json: at the candidate the manifest is not a JSON object"]);
    });

    it.each([["5"], ["null"]])("names a manifest that is JSON but not an object at the merge base: %s", async (body) => {
      const record = await run({ [MANIFEST]: body + "\n" }, { [MANIFEST]: manifest({ test: "vitest" }) });
      expect(record.status).toBe("fail");
      expect(record.evidence).toEqual(["package.json: at the merge base the manifest is not a JSON object"]);
    });

    it("names a manifest that is a symbolic link at the candidate", async () => {
      const base = await commit(repo, { "keep.txt": "keep\n", [MANIFEST]: manifest({ test: "vitest" }) }, "base");
      await rm(join(repo, MANIFEST));
      await symlink("keep.txt", join(repo, MANIFEST));
      await git(repo, ["add", "-A"]);
      await git(repo, ["commit", "--quiet", "-m", "link"]);
      const record = await check({ cwd: repo, base, candidate: "HEAD" });
      expect(record.status).toBe("fail");
      expect(record.evidence).toEqual(["package.json: at the candidate the manifest is not a regular file"]);
    });

    it("names a manifest that is a symbolic link at the merge base", async () => {
      await symlink("keep.txt", join(repo, MANIFEST));
      const base = await commit(repo, { "keep.txt": "keep\n" }, "base");
      await rm(join(repo, MANIFEST));
      const candidate = await commit(repo, { [MANIFEST]: manifest({ test: "vitest" }) }, "real");
      const record = await check({ cwd: repo, base, candidate });
      expect(record.status).toBe("fail");
      expect(record.evidence).toEqual(["package.json: at the merge base the manifest is not a regular file"]);
    });

    it("prints a tilde in a name or a command as it is", async () => {
      const record = await run({ [MANIFEST]: manifest({ "a~b": "x~y" }) }, { [MANIFEST]: manifest({ "a~b": "x~z", "c~d": "p~q" }) });
      expect(record.evidence).toEqual(['package.json: changed "a~b": "x~y" -> "x~z"', 'package.json: added "c~d": "p~q"']);
    });

    it("escapes a delete character and keeps the characters around it", async () => {
      const record = await run({ [MANIFEST]: manifest({}) }, { [MANIFEST]: manifest({ k: " }\u007f|" }) });
      expect(record.evidence).toEqual(['package.json: added "k": " }\\u{007f}|"']);
    });
  });

  describe("order", () => {
    const prefixes = (evidence: readonly string[]): string[] => evidence.map((line) => line.slice(0, line.indexOf(":", line.indexOf(":") + 1)));

    it("sorts the entries of one manifest by name whatever order it holds them in", async () => {
      const record = await run({ [MANIFEST]: manifest({}) }, { [MANIFEST]: manifest({ b: "1", c: "1", a: "1" }) });
      expect(record.findings.map((f) => f.key)).toEqual(["a", "b", "c"]);
      expect(prefixes(record.evidence)).toEqual(['package.json: added "a"', 'package.json: added "b"', 'package.json: added "c"']);
    });

    it("sorts added, changed and removed entries together by name", async () => {
      const record = await run({ [MANIFEST]: manifest({ c: "1", e: "1", b: "1" }) }, { [MANIFEST]: manifest({ d: "2", c: "2", a: "2" }) });
      expect(record.findings.map((f) => [f.key, f.category])).toEqual([
        ["a", "script-added"],
        ["b", "script-removed"],
        ["c", "script-changed"],
        ["d", "script-added"],
        ["e", "script-removed"],
      ]);
      expect(prefixes(record.evidence)).toEqual([
        'package.json: added "a"',
        'package.json: removed "b"',
        'package.json: changed "c"',
        'package.json: added "d"',
        'package.json: removed "e"',
      ]);
    });

    it("sorts by the manifest's path before the entry's name", async () => {
      const record = await run(
        { [MANIFEST]: manifest({}), [NESTED]: manifest({}) },
        { [MANIFEST]: manifest({ z: "1", y: "1" }), [NESTED]: manifest({ b: "1", a: "1" }) },
      );
      expect(record.findings.map((f) => [f.file, f.key])).toEqual([
        [MANIFEST, "y"],
        [MANIFEST, "z"],
        [NESTED, "a"],
        [NESTED, "b"],
      ]);
      expect(prefixes(record.evidence)).toEqual([
        'package.json: added "y"',
        'package.json: added "z"',
        `${NESTED}: added "a"`,
        `${NESTED}: added "b"`,
      ]);
    });
  });

  describe("sanction reasons", () => {
    const id = "script-changed:package.json:test";
    const before = { [MANIFEST]: manifest({ test: "vitest" }) };
    const after = { [MANIFEST]: manifest({ test: "true" }) };

    it.each([[""], ["   "], ["\t "]])("sanctions nothing with the caller's reason %j", async (reason) => {
      const record = await run(before, after, { sanctions: { [id]: reason, "script-changed:package.json": reason } });
      expect(record.status).toBe("fail");
      expect(record.findings.map((f) => f.sanction)).toEqual([null]);
      expect(record.evidence.join("\n")).not.toContain("sanctioned");
    });

    it("sanctions with a reason one character long", async () => {
      const record = await run(before, after, { sanctions: { [id]: "x" } });
      expect(record.status).toBe("pass");
      expect(record.findings.map((f) => f.sanction)).toEqual(["x"]);
      expect(record.evidence).toEqual(['package.json: changed "test": "vitest" -> "true" - sanctioned: x']);
    });

    it("trims the caller's reason", async () => {
      const record = await run(before, after, { sanctions: { [id]: "  why  " } });
      expect(record.findings.map((f) => f.sanction)).toEqual(["why"]);
    });

    it("falls back to the category and file when the entry's reason is blank", async () => {
      const record = await run(before, after, { sanctions: { [id]: " ", "script-changed:package.json": "by file" } });
      expect(record.status).toBe("pass");
      expect(record.findings.map((f) => f.sanction)).toEqual(["by file"]);
    });

    it("passes a range whose one finding a line in a commit message sanctions", async () => {
      const record = await run(before, after, { message: `change\n\n${SANCTION_KEY}: ${id} the runner moved\n` });
      expect(record.status).toBe("pass");
      expect(record.findings.map((f) => f.sanction)).toEqual(["the runner moved"]);
      expect(record.evidence).toEqual(['package.json: changed "test": "vitest" -> "true" - sanctioned: the runner moved']);
    });

    it("sanctions with a one character reason in a commit message", async () => {
      const record = await run(before, after, { message: `change\n\n${SANCTION_KEY}: ${id} x` });
      expect(record.status).toBe("pass");
      expect(record.findings.map((f) => f.sanction)).toEqual(["x"]);
    });

    it("does not sanction from a commit message line without a reason", async () => {
      const record = await run(before, after, { message: `change\n\n${SANCTION_KEY}: ${id}   ` });
      expect(record.status).toBe("fail");
    });

    it("does not sanction from a commit message line that only begins with the id", async () => {
      const record = await run(before, after, { message: `change\n\n${SANCTION_KEY}: ${id}2 reason` });
      expect(record.status).toBe("fail");
    });
  });

  it("fails closed on a revision that names no commit", async () => {
    await commit(repo, { "a.txt": "a\n" }, "base");
    const record = await check({ cwd: repo, base: "no-such-revision", candidate: "HEAD" });
    expect(record.status).toBe("fail");
    expect(record.evidence.join("\n")).toContain("no-such-revision");
  });

  it("fails closed when git itself fails", async () => {
    const record = await check({ cwd: join(repo, "does-not-exist"), base: "HEAD", candidate: "HEAD" });
    expect(record.status).toBe("fail");
    expect(record.evidence.length).toBeGreaterThan(0);
  });

  it("is the only record `repo-truth check --check RT-33` prints", async () => {
    await commit(repo, { [MANIFEST]: manifest({ test: "vitest" }) }, "base");
    await commit(repo, { [MANIFEST]: manifest({ test: "true" }) }, "change");
    let stdout = "";
    const code = await main(["check", "--check", "RT-33", "--no-fetch", "--base", "HEAD~1", "--candidate", "main", "--format", "json"], {
      cwd: repo,
      stdout: (t) => void (stdout += t),
      stderr: () => undefined,
    });
    expect(code).not.toBe(0);
    const parsed = JSON.parse(stdout) as unknown;
    const records = (Array.isArray(parsed) ? parsed : (parsed as { records: unknown[] }).records) as { name: string }[];
    expect(records.map((r) => r.name)).toEqual(["RT-33"]);
  });
});
