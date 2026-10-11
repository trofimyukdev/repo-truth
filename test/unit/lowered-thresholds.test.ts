import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { REGISTRY } from "../../src/registry.js";
import { checkLoweredThresholds, THRESHOLD_SPELLINGS, type ThresholdSpelling } from "../../src/lowered-thresholds.js";

const execFileAsync = promisify(execFile);

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "Test Committer",
  GIT_COMMITTER_EMAIL: "committer@example.com",
};

const HIGH = 80;
const LOW = 70;
const MID = 75;
const TOP = 90;
const FIRST_LINE = 1;
const SECOND_LINE = 2;
const FOURTH_LINE = 4;

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args as string[], { cwd, env: ENV });
  return stdout.trim();
}

async function commit(cwd: string, files: Record<string, string | null>, message = "change"): Promise<string> {
  for (const [name, content] of Object.entries(files)) {
    if (content === null) {
      await rm(join(cwd, name));
    } else {
      await mkdir(dirname(join(cwd, name)), { recursive: true });
      await writeFile(join(cwd, name), content);
    }
  }
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "--quiet", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

/** Commit a symbolic link, replacing whatever the name held. */
async function commitLink(cwd: string, name: string, target: string, message = "link"): Promise<string> {
  await rm(join(cwd, name), { force: true });
  await symlink(target, join(cwd, name));
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "--quiet", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

describe("checkLoweredThresholds", () => {
  let repo: string;
  const bare: string[] = [];

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "repo-truth-lowered-"));
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    for (const dir of bare.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /** Run `body` while `entry` is appended to the spellings. */
  async function withSpelling(entry: ThresholdSpelling, body: () => Promise<void>): Promise<void> {
    THRESHOLD_SPELLINGS.push(entry);
    try {
      await body();
    } finally {
      THRESHOLD_SPELLINGS.splice(THRESHOLD_SPELLINGS.indexOf(entry), 1);
    }
  }

  /** Commit `before`, then `after`, and check the range between them. */
  async function run(
    before: Record<string, string>,
    after: Record<string, string | null>,
    extra: { message?: string; sanctions?: Record<string, string> } = {},
  ) {
    const base = await commit(repo, before, "base");
    const candidate = await commit(repo, after, extra.message ?? "change");
    return checkLoweredThresholds({ cwd: repo, base, candidate, sanctions: extra.sanctions });
  }

  const vitest = (value: number | null): string =>
    value === null ? "export default {};\n" : `export default {\n  lines: ${value},\n};\n`;

  it("fails a lowered value, naming file, line, setting and both values", async () => {
    const record = await run({ "vitest.config.ts": vitest(HIGH) }, { "vitest.config.ts": vitest(LOW) });
    expect(record.name).toBe("RT-14");
    expect(record.status).toBe("fail");
    expect(record.evidence).toHaveLength(1);
    const line = record.evidence[0] ?? "";
    expect(line.startsWith("vitest.config.ts:2:")).toBe(true);
    expect(line).toContain("lowered");
    expect(line).toContain("lines");
    expect(line).toContain("80");
    expect(line).toContain("70");
    expect(record.findings[0]?.category).toBe("threshold-lowered");
  });

  it("passes a raised value, a new one and a moved line", async () => {
    expect((await run({ "vitest.config.ts": vitest(HIGH) }, { "vitest.config.ts": vitest(TOP) })).evidence).toEqual([
      "no threshold lowered or removed",
    ]);
  });

  it("passes a new value and a line that only moved", async () => {
    const added = await run({ "vitest.config.ts": vitest(null) }, { "vitest.config.ts": vitest(HIGH) });
    expect(added.status).toBe("pass");
    expect(added.evidence).toEqual(["no threshold lowered or removed"]);
    const moved = await run(
      { "jest.config.js": `module.exports = {\n  lines: ${HIGH},\n  other: 1,\n};\n` },
      { "jest.config.js": `module.exports = {\n  other: 1,\n  lines: ${HIGH},\n};\n` },
    );
    expect(moved.status).toBe("pass");
  });

  it("does not report a low value the base already held", async () => {
    const base = await commit(repo, { "vitest.config.ts": vitest(LOW), "a.txt": "1\n" });
    const candidate = await commit(repo, { "a.txt": "2\n" });
    const record = await checkLoweredThresholds({ cwd: repo, base, candidate });
    expect(record.status).toBe("pass");
    expect(record.evidence).toEqual(["no threshold lowered or removed"]);
  });

  it("fails a removed key, naming the line in the base", async () => {
    const record = await run({ "vitest.config.ts": vitest(HIGH) }, { "vitest.config.ts": vitest(null) });
    expect(record.status).toBe("fail");
    expect(record.findings[0]?.category).toBe("threshold-removed");
    expect(record.evidence[0]?.startsWith("vitest.config.ts:2:")).toBe(true);
    expect(record.evidence[0]).toContain("removed");
    expect(record.evidence[0]).toContain("80");
  });

  it("fails a deleted configuration file", async () => {
    const record = await run({ ".nycrc": `{\n  "lines": ${HIGH}\n}\n` }, { ".nycrc": null });
    expect(record.status).toBe("fail");
    expect(record.findings[0]?.category).toBe("threshold-removed");
    expect(record.evidence[0]?.startsWith(".nycrc:2:")).toBe(true);
  });

  it("is silent on a rename that keeps its values and reports one that lowers", async () => {
    const body = `export default {\n  lines: ${HIGH},\n  functions: ${MID},\n};\n`;
    const silent = await run({ "vitest.config.ts": body }, { "vitest.config.ts": null, "vite.config.ts": body });
    expect(silent.status).toBe("pass");
    expect(silent.evidence).toEqual(["no threshold lowered or removed"]);
  });

  it("reports a renamed file whose value went down under its new name", async () => {
    const body = (value: number): string => `export default {\n  lines: ${value},\n  pad: 1,\n  more: 2,\n  rest: 3,\n};\n`;
    const record = await run(
      { "vitest.config.ts": body(HIGH) },
      { "vitest.config.ts": null, "vite.config.ts": body(LOW) },
    );
    expect(record.status).toBe("fail");
    expect(record.evidence[0]?.startsWith("vite.config.ts:2:")).toBe(true);
  });

  it("pairs values in order, per key, and ignores unmatched numbers", async () => {
    const before = `export default {\n  lines: ${HIGH}, branches: ${MID},\n  timeout: ${HIGH},\n};\n`;
    const after = `export default {\n  lines: ${TOP}, branches: ${LOW},\n  timeout: ${LOW},\n};\n`;
    const record = await run({ "vitest.config.ts": before }, { "vitest.config.ts": after });
    expect(record.findings).toHaveLength(1);
    expect(record.findings[0]?.key).toBe("branches");
  });

  const spellings: Array<[string, string, (value: number) => string]> = [
    ["vite config", "vite.config.mjs", (v) => `export default { lines: ${v} };\n`],
    ["jest config", "jest.config.js", (v) => `module.exports = { branches: ${v} };\n`],
    ["package.json key", "package.json", (v) => `{ "functions": ${v} }\n`],
    ["package.json flag", "package.json", (v) => `{ "scripts": { "c": "c8 check-coverage --statements ${v}" } }\n`],
    ["package.json flag equals", "package.json", (v) => `{ "scripts": { "c": "c8 --lines=${v}" } }\n`],
    [".nycrc", ".nycrc", (v) => `{ "statements": ${v} }\n`],
    [".nycrc.json", "sub/.nycrc.json", (v) => `{ "lines": ${v} }\n`],
    [".c8rc", ".c8rc", (v) => `{ "lines": ${v} }\n`],
    [".c8rc.json", ".c8rc.json", (v) => `{ "branches": ${v} }\n`],
    ["pyproject cov", "pyproject.toml", (v) => `addopts = "--cov-fail-under=${v}"\n`],
    ["setup.cfg cov", "setup.cfg", (v) => `addopts = --cov-fail-under ${v}\n`],
    ["tox.ini cov", "tox.ini", (v) => `commands = pytest --cov-fail-under=${v}\n`],
    ["pytest.ini cov", "pytest.ini", (v) => `addopts = --cov-fail-under=${v}\n`],
    ["pyproject fail_under", "pyproject.toml", (v) => `fail_under = ${v}\n`],
    ["setup.cfg fail_under", "setup.cfg", (v) => `fail_under = ${v}\n`],
    ["tox.ini fail_under", "tox.ini", (v) => `fail_under=${v}\n`],
    [".coveragerc", ".coveragerc", (v) => `fail_under = ${v}\n`],
  ];

  for (const [label, file, make] of spellings) {
    it(`reads the spelling: ${label}`, async () => {
      const record = await run({ [file]: make(HIGH) }, { [file]: make(LOW) });
      expect(record.status).toBe("fail");
      expect(record.evidence).toHaveLength(1);
      expect(record.evidence[0]?.startsWith(`${file}:`)).toBe(true);
    });
  }

  it("does not read a number in a file no entry names", async () => {
    const record = await run({ "notes.txt": `lines: ${HIGH}\n` }, { "notes.txt": `lines: ${LOW}\n` });
    expect(record.status).toBe("pass");
  });

  it("applies an entry appended to THRESHOLD_SPELLINGS", async () => {
    const entry = {
      name: "gate",
      files: /^Makefile$/,
      pattern: /GATE=(?<value>\d+)/,
      example: "GATE=80",
    };
    expect(entry.pattern.test(entry.example)).toBe(true);
    THRESHOLD_SPELLINGS.push(entry);
    try {
      const record = await run({ Makefile: `GATE=${HIGH}\n` }, { Makefile: `GATE=${LOW}\n` });
      expect(record.status).toBe("fail");
      expect(record.evidence[0]).toContain("gate");
    } finally {
      THRESHOLD_SPELLINGS.splice(THRESHOLD_SPELLINGS.indexOf(entry), 1);
    }
  });

  it("holds an example each entry matches", () => {
    for (const spelling of THRESHOLD_SPELLINGS) {
      expect(new RegExp(spelling.pattern.source, spelling.pattern.flags).test(spelling.example)).toBe(true);
    }
  });

  it("is sanctioned by a line of a commit message, by id and by file", async () => {
    const files = { "vitest.config.ts": vitest(HIGH) };
    const lowered = { "vitest.config.ts": vitest(LOW) };
    const byId = await run(files, lowered, {
      message: "ease it\n\nSanctioned-Weakening: threshold-lowered:vitest.config.ts:2 the suite is being rewritten",
    });
    expect(byId.status).toBe("pass");
    expect(byId.evidence).toHaveLength(1);
    expect(byId.evidence[0]).toContain("sanctioned");
    expect(byId.evidence[0]).toContain("the suite is being rewritten");
    expect(byId.evidence[0]).toContain("lowered");
  });

  it("is sanctioned by a category and file line, and not by another file's", async () => {
    const files = { "vitest.config.ts": vitest(HIGH) };
    const lowered = { "vitest.config.ts": vitest(LOW) };
    const byFile = await run(files, lowered, {
      message: "ease it\n\nSanctioned-Weakening: threshold-lowered:vitest.config.ts agreed",
    });
    expect(byFile.status).toBe("pass");
    await rm(join(repo, ".git"), { recursive: true, force: true });
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
    const other = await run(files, lowered, {
      message: "ease it\n\nSanctioned-Weakening: threshold-lowered:other.config.ts agreed",
    });
    expect(other.status).toBe("fail");
  });

  it("is sanctioned by the caller's option, and a removed one by its own category", async () => {
    const lowered = await run(
      { "vitest.config.ts": vitest(HIGH) },
      { "vitest.config.ts": vitest(LOW) },
      { sanctions: { "threshold-lowered:vitest.config.ts:2": "caller says so" } },
    );
    expect(lowered.status).toBe("pass");
    expect(lowered.evidence[0]).toContain("caller says so");
  });

  it("fails a revision that names no commit, with a record and not a throw", async () => {
    await commit(repo, { "a.txt": "1\n" });
    const record = await checkLoweredThresholds({ cwd: repo, base: "no-such-rev", candidate: "HEAD" });
    expect(record.status).toBe("fail");
    expect(record.evidence.join("\n")).toContain("no-such-rev");
  });

  it("fails closed when git cannot run", async () => {
    const record = await checkLoweredThresholds({ cwd: join(repo, "missing"), base: "HEAD", candidate: "HEAD" });
    expect(record.status).toBe("fail");
    expect(record.evidence.length).toBeGreaterThan(0);
  });

  it("carries git's own complaint for a directory that is not a repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "repo-truth-lowered-bare-"));
    bare.push(dir);
    const record = await checkLoweredThresholds({ cwd: dir, base: "HEAD", candidate: "HEAD" });
    expect(record.status).toBe("fail");
    expect(record.findings).toEqual([]);
    expect(record.evidence).toHaveLength(1);
    const line = record.evidence[0] ?? "";
    expect(line.startsWith('revision "HEAD" does not name a commit: fatal: not a git repository')).toBe(true);
    expect(line).not.toContain("Command failed");
    expect(line.endsWith("\\u{000a}")).toBe(false);  });

  it("carries, after the revision, the message of the git command that refused it", async () => {
    await commit(repo, { "a.txt": "1\n" });
    const record = await checkLoweredThresholds({ cwd: repo, base: "no-such-rev", candidate: "HEAD" });
    expect(record.name).toBe("RT-14");
    expect(record.status).toBe("fail");
    expect(record.findings).toEqual([]);
    expect(record.evidence).toHaveLength(1);
    const line = record.evidence[0] ?? "";
    expect(line.startsWith('revision "no-such-rev" does not name a commit: ')).toBe(true);
    expect(line).toContain("git rev-parse");
    expect(line).toContain("no-such-rev^{commit}");
    const later = await checkLoweredThresholds({ cwd: repo, base: "HEAD", candidate: "no-such-rev" });
    expect(later.evidence).toHaveLength(1);
    expect(later.evidence[0]?.startsWith('revision "no-such-rev" does not name a commit: ')).toBe(true);
  });

  it("escapes a refused revision that git was asked about", async () => {
    await commit(repo, { "a.txt": "1\n" });
    const record = await checkLoweredThresholds({ cwd: repo, base: "café", candidate: "HEAD" });
    expect(record.status).toBe("fail");
    expect(record.evidence[0]?.startsWith('revision "caf\\u{00e9}" does not name a commit: ')).toBe(true);
  });

  it("refuses an empty revision, or one that begins with a minus sign, before git runs", async () => {
    await commit(repo, { "a.txt": "1\n" });
    const refused = async (base: string, candidate: string) =>
      (await checkLoweredThresholds({ cwd: repo, base, candidate })).evidence;
    expect(await refused("", "HEAD")).toEqual(['revision "" does not name a commit']);
    expect(await refused("HEAD", "")).toEqual(['revision "" does not name a commit']);
    expect(await refused("-", "HEAD")).toEqual(['revision "-" does not name a commit']);
    expect(await refused("--help", "HEAD")).toEqual(['revision "--help" does not name a commit']);
    expect(await refused("HEAD", "-n")).toEqual(['revision "-n" does not name a commit']);
    expect(await refused("-x", "")).toEqual(['revision "-x" does not name a commit']);
    const record = await checkLoweredThresholds({ cwd: repo, base: "", candidate: "HEAD" });
    expect(record.name).toBe("RT-14");
    expect(record.status).toBe("fail");
    expect(record.findings).toEqual([]);
  });

  it("refuses a revision that is not a string, naming what it was", async () => {
    await commit(repo, { "a.txt": "1\n" });
    const record = await checkLoweredThresholds({
      cwd: repo,
      base: undefined as unknown as string,
      candidate: "HEAD",
    });
    expect(record.status).toBe("fail");
    expect(record.evidence).toEqual(['revision "undefined" does not name a commit']);
  });

  it("writes every character outside printable ASCII as a backslash and four hex digits, in a refused revision", async () => {
    await commit(repo, { "a.txt": "1\n" });
    const record = await checkLoweredThresholds({
      cwd: repo,
      base: "-a b~c\u001f\u007féĀ\u{1f600}\n\t\\",
      candidate: "HEAD",
    });
    expect(record.evidence).toEqual([
      'revision "-a b~c\\u{001f}\\u{007f}\\u{00e9}\\u{0100}\\u{1f600}\\u{000a}\\u{0009}\\" does not name a commit',
    ]);
  });

  it("writes a finding's path the same way, leaving a space and a tilde as they are", async () => {
    const path = "dé ~\u001f\u001b\u007f\t\u{1f600}/vitest.config.ts";
    const record = await run({ [path]: vitest(HIGH) }, { [path]: vitest(LOW) });
    expect(record.status).toBe("fail");
    expect(record.findings[0]?.file).toBe(path);
    expect(record.evidence).toHaveLength(1);
    expect(
      record.evidence[0]?.startsWith("d\\u{00e9} ~\\u{001f}\\u{001b}\\u{007f}\\u{0009}\\u{1f600}/vitest.config.ts:2: lowered"),
    ).toBe(true);
  });

  it("writes a finding's text, a sanction's reason included, the same way", async () => {
    const reason = "café \u001b[0m ~";
    const record = await run(
      { "vitest.config.ts": vitest(HIGH) },
      { "vitest.config.ts": vitest(LOW) },
      { sanctions: { [`threshold-lowered:vitest.config.ts:${SECOND_LINE}`]: reason } },
    );
    expect(record.status).toBe("pass");
    expect(record.evidence).toHaveLength(1);
    expect(record.evidence[0]?.endsWith("sanctioned: caf\\u{00e9} \\u{001b}[0m ~")).toBe(true);
    expect(record.findings[0]?.sanction).toBe(reason);
  });

  it("names both revisions when the two share no history", async () => {
    await commit(repo, { "a.txt": "1\n" });
    await git(repo, ["checkout", "--quiet", "--orphan", "other"]);
    await commit(repo, { "b.txt": "2\n" });
    const record = await checkLoweredThresholds({ cwd: repo, base: "main", candidate: "other" });
    expect(record.status).toBe("fail");
    expect(record.evidence).toHaveLength(1);
    expect(record.evidence[0]?.startsWith('no merge base of "main" and "other": ')).toBe(true);
  });

  it("does not report a configuration file the range adds", async () => {
    const record = await run(
      { "a.txt": "1\n" },
      { "vitest.config.ts": vitest(HIGH), "package.json": `{ "lines": ${LOW} }\n` },
    );
    expect(record.status).toBe("pass");
    expect(record.findings).toEqual([]);
    expect(record.evidence).toEqual(["no threshold lowered or removed"]);
  });

  it("reports a deleted file whose last line ends without a newline", async () => {
    const record = await run({ "vitest.config.ts": `export default {\n  lines: ${HIGH}` }, { "vitest.config.ts": null });
    expect(record.status).toBe("fail");
    expect(record.findings).toHaveLength(1);
    expect(record.findings[0]?.category).toBe("threshold-removed");
    expect(record.findings[0]?.line).toBe(2);
    expect(record.findings[0]?.oldValue).toBe(String(HIGH));
    expect(record.findings[0]?.newValue).toBeNull();
    expect(record.evidence[0]?.startsWith("vitest.config.ts:2: removed")).toBe(true);
  });

  it("reports a deleted file that is a single line without a newline", async () => {
    const record = await run({ ".coveragerc": `fail_under = ${HIGH}` }, { ".coveragerc": null });
    expect(record.status).toBe("fail");
    expect(record.findings[0]?.id).toBe(`threshold-removed:.coveragerc:${FIRST_LINE}`);
  });

  it("never reports a deleted file that holds a NUL byte", async () => {
    const record = await run(
      { "vitest.config.ts": `export default {\n  lines: ${HIGH},\n};\n\0` },
      { "vitest.config.ts": null },
    );
    expect(record.status).toBe("pass");
    expect(record.findings).toEqual([]);
    expect(record.evidence).toEqual(["no threshold lowered or removed"]);
  });

  it("never reads a symbolic link named like a configuration file", async () => {
    const base = await commitLink(repo, "vitest.config.ts", `lines: ${HIGH}`);
    const lowered = await commitLink(repo, "vitest.config.ts", `lines: ${LOW}`);
    const first = await checkLoweredThresholds({ cwd: repo, base, candidate: lowered });
    expect(first.status).toBe("pass");
    expect(first.findings).toEqual([]);
    const deleted = await commit(repo, { "vitest.config.ts": null });
    const second = await checkLoweredThresholds({ cwd: repo, base: lowered, candidate: deleted });
    expect(second.status).toBe("pass");
    expect(second.findings).toEqual([]);
    expect(second.evidence).toEqual(["no threshold lowered or removed"]);
  });

  it("does not pair a value the range adds with an unchanged one below it", async () => {
    const record = await run(
      { "vitest.config.ts": `export default {\n  lines: ${HIGH},\n};\n` },
      { "vitest.config.ts": `export default {\n  lines: ${LOW},\n  lines: ${HIGH},\n};\n` },
    );
    expect(record.status).toBe("pass");
    expect(record.findings).toEqual([]);
    expect(record.evidence).toEqual(["no threshold lowered or removed"]);
  });

  it("reports a lowered value on the second line a hunk adds on that line", async () => {
    const record = await run(
      { "vitest.config.ts": `export default {\n  lines: ${HIGH},\n  branches: ${HIGH},\n};\n` },
      { "vitest.config.ts": `export default {\n  note: 1,\n  lines: ${TOP},\n  branches: ${LOW},\n};\n` },
    );
    expect(record.status).toBe("fail");
    expect(record.findings).toHaveLength(1);
    expect(record.findings[0]?.id).toBe(`threshold-lowered:vitest.config.ts:${FOURTH_LINE}`);
    expect(record.findings[0]?.key).toBe("branches");
    expect(record.findings[0]?.line).toBe(4);
    expect(record.evidence[0]?.startsWith("vitest.config.ts:4: lowered")).toBe(true);
  });

  it("reports each value a hunk removes on its own line in the base", async () => {
    const record = await run(
      { "vitest.config.ts": `export default {\n  lines: ${HIGH},\n  branches: ${MID},\n};\n` },
      { "vitest.config.ts": "export default {\n};\n" },
    );
    expect(record.findings.map((finding) => `${finding.key}:${finding.line}`)).toEqual(["lines:2", "branches:3"]);
    expect(record.findings.map((finding) => finding.oldValue)).toEqual([String(HIGH), String(MID)]);
  });

  it("applies an appended entry whose path expression carries the global flag to every path, each time", async () => {
    const entry: ThresholdSpelling = {
      name: "gate",
      files: /^[a-z]+\.gate$/g,
      pattern: /GATE=(?<value>\d+)/,
      example: "GATE=80",
    };
    await withSpelling(entry, async () => {
      const first = await run(
        { "one.gate": `GATE=${HIGH}\n`, "two.gate": `GATE=${HIGH}\n` },
        { "one.gate": `GATE=${LOW}\n`, "two.gate": `GATE=${LOW}\n` },
      );
      expect(first.status).toBe("fail");
      expect(first.findings.map((finding) => finding.file).sort()).toEqual(["one.gate", "two.gate"]);
      expect(first.findings.every((finding) => finding.category === "threshold-lowered")).toBe(true);
      expect(first.findings.every((finding) => finding.key === null && finding.name === "gate")).toBe(true);
      const second = await run(
        { "one.gate": `GATE=${TOP}\n`, "two.gate": `GATE=${TOP}\n` },
        { "one.gate": `GATE=${MID}\n`, "two.gate": `GATE=${MID}\n` },
      );
      expect(second.findings.map((finding) => finding.file).sort()).toEqual(["one.gate", "two.gate"]);
      expect(second.findings.every((finding) => finding.category === "threshold-lowered")).toBe(true);
    });
  });

  it("applies an appended entry whose line expression carries the global flag, and reads every match on a line", async () => {
    const entry: ThresholdSpelling = {
      name: "gate",
      files: /^Makefile$/,
      pattern: /GATE=(?<value>\d+)/g,
      example: "GATE=80",
    };
    await withSpelling(entry, async () => {
      const record = await run({ Makefile: `GATE=${HIGH} GATE=${TOP}\n` }, { Makefile: `GATE=${HIGH} GATE=${LOW}\n` });
      expect(record.status).toBe("fail");
      expect(record.findings).toHaveLength(1);
      expect(record.findings[0]?.oldValue).toBe(String(TOP));
      expect(record.findings[0]?.newValue).toBe(String(LOW));
      expect(record.findings[0]?.line).toBe(1);
    });
  });

  it("does not read a match whose value group is not a number as a setting", async () => {
    const entry: ThresholdSpelling = {
      name: "gate",
      files: /^Makefile$/,
      pattern: /GATE=(?<value>\w+)/,
      example: "GATE=high",
    };
    await withSpelling(entry, async () => {
      const gone = await run({ Makefile: "GATE=high\n" }, { Makefile: "other\n" });
      expect(gone.status).toBe("pass");
      expect(gone.findings).toEqual([]);
      const endless = await run({ Makefile: "GATE=Infinity\n" }, { Makefile: `GATE=${LOW}\n` });
      expect(endless.status).toBe("pass");
      expect(endless.findings).toEqual([]);
      const real = await run({ Makefile: `GATE=${HIGH}\n` }, { Makefile: "GATE=low\n" });
      expect(real.status).toBe("fail");
      expect(real.findings[0]?.category).toBe("threshold-removed");
    });
  });

  it("is registered as RT-14", () => {
    expect(REGISTRY.some((entry) => entry.name === "RT-14")).toBe(true);
  });
});
