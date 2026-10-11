import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli.js";
import { check, name, TIMEOUT_SPELLINGS } from "../../src/checks/raised-timeouts.js";

const execFileAsync = promisify(execFile);

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "Test Committer",
  GIT_COMMITTER_EMAIL: "committer@example.com",
};

const SHORT = 5000;
const LONG = 30000;
const LONGER = 60000;

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args as string[], { cwd, env: ENV });
  return stdout.trim();
}

async function commit(cwd: string, files: Record<string, string | null>, message = "change"): Promise<string> {
  for (const [file, content] of Object.entries(files)) {
    if (content === null) {
      await rm(join(cwd, file));
    } else {
      await mkdir(dirname(join(cwd, file)), { recursive: true });
      await writeFile(join(cwd, file), content);
    }
  }
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "--quiet", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

describe("RT-24 raised timeouts", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "repo-truth-timeouts-"));
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function run(
    before: Record<string, string>,
    after: Record<string, string | null>,
    extra: { message?: string; sanctions?: Record<string, string> } = {},
  ) {
    const base = await commit(repo, before, "base");
    const candidate = await commit(repo, after, extra.message ?? "change");
    return check({ cwd: repo, base, candidate, sanctions: extra.sanctions });
  }

  it("is named RT-24 and ships examples its patterns match", () => {
    expect(name).toBe("RT-24");
    for (const spelling of TIMEOUT_SPELLINGS) {
      expect(spelling.pattern.exec(spelling.example)?.groups?.["value"], spelling.name).toBeDefined();
    }
  });

  const cases: [string, string, (n: number) => string][] = [
    ["vitest.config.ts", "testTimeout", (n) => `export default {\n  test: { testTimeout: ${n} },\n};\n`],
    ["vite.config.mjs", "hookTimeout", (n) => `export default {\n  test: { "hookTimeout": ${n} },\n};\n`],
    ["jest.config.js", "teardownTimeout", (n) => `module.exports = {\n  teardownTimeout: ${n},\n};\n`],
    ["package.json", "testTimeout", (n) => `{\n  "jest": {\n    "testTimeout": ${n}\n  }\n}\n`],
    ["test/a.ts", "jest.setTimeout", (n) => `jest.setTimeout(${n});\n`],
    ["src/a.spec.ts", "timeout", (n) => `it("x", { timeout: ${n} }, () => {});\n`],
    ["src/b.test.js", "this.timeout", (n) => `it("x", function () {\n  this.timeout(${n});\n});\n`],
    ["tests/c.ts", "test timeout argument", (n) => `it("x", async () => {\n  await go();\n}, ${n});\n`.replace("}, ", "}, ")],
  ];

  for (const [file, label, make] of cases) {
    it(`reports a raised ${label} in ${file}`, async () => {
      const record = await run({ [file]: make(SHORT) }, { [file]: make(LONG) });
      expect(record.name).toBe("RT-24");
      expect(record.status).toBe("fail");
      expect(record.findings.map((f) => f.category)).toEqual(["timeout-raised"]);
      expect(record.evidence).toHaveLength(1);
      expect(record.evidence[0]).toMatch(new RegExp(`^${file.replace(".", "\\.")}:\\d+: raised `));
      expect(record.evidence[0]).toContain(String(SHORT));
      expect(record.evidence[0]).toContain(String(LONG));
    });
  }

  it("reads the closing-brace spelling `}, 30000);`", async () => {
    const record = await run({ "t.test.ts": `it("x", () => {\n}, ${SHORT});\n` }, { "t.test.ts": `it("x", () => {\n}, ${LONG});\n` });
    expect(record.findings.map((f) => f.category)).toEqual(["timeout-raised"]);
    expect(record.findings[0]?.line).toBe(2);
  });

  it("passes a lowered, an equal and a moved timeout", async () => {
    const lowered = await run({ "a.test.ts": `jest.setTimeout(${LONG});\n` }, { "a.test.ts": `jest.setTimeout(${SHORT});\n` });
    expect(lowered.status).toBe("pass");
    expect(lowered.evidence).toEqual([expect.stringContaining("no timeout raised or added")]);
    const equal = await run({ "b.test.ts": `jest.setTimeout(${LONG});\n// x\n` }, { "b.test.ts": `jest.setTimeout(${LONG});\n// y\n` });
    expect(equal.status).toBe("pass");
    const moved = await run(
      { "c.test.ts": `// one\n// two\njest.setTimeout(${LONG});\n` },
      { "c.test.ts": `jest.setTimeout(${LONG});\n// one\n// two\n` },
    );
    expect(moved.status).toBe("pass");
    expect(moved.findings).toEqual([]);
  });

  it("does not read a long timeout the base already holds", async () => {
    const file = "d.test.ts";
    const record = await run({ [file]: `jest.setTimeout(${LONGER});\n// a\n` }, { [file]: `jest.setTimeout(${LONGER});\n// b\n` });
    expect(record.status).toBe("pass");
  });

  it("reports a timeout added to an existing file but not to a new one", async () => {
    const added = await run({ "e.test.ts": "it('x', () => {});\n" }, { "e.test.ts": `jest.setTimeout(${LONG});\nit('x', () => {});\n` });
    expect(added.status).toBe("fail");
    expect(added.findings.map((f) => f.category)).toEqual(["timeout-added"]);
    expect(added.evidence[0]).toMatch(/^e\.test\.ts:1: added jest\.setTimeout/);
    const created = await run({ "f.txt": "x\n" }, { "g.test.ts": `jest.setTimeout(${LONG});\n` });
    expect(created.status).toBe("pass");
  });

  it("treats a renamed file as one file", async () => {
    const body = (n: number): string => `// padding one\n// padding two\n// padding three\njest.setTimeout(${n});\n`;
    const same = await run({ "old.test.ts": body(LONG) }, { "old.test.ts": null, "new.test.ts": body(LONG) });
    expect(same.status).toBe("pass");
    await rm(repo, { recursive: true, force: true });
    await mkdir(repo, { recursive: true });
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
    const raised = await run({ "old.test.ts": body(SHORT) }, { "old.test.ts": null, "new.test.ts": body(LONG) });
    expect(raised.findings.map((f) => [f.category, f.file])).toEqual([["timeout-raised", "new.test.ts"]]);
  });

  it("ignores files and lines no entry matches", async () => {
    const record = await run(
      { "src/app.ts": `const timeout = ${SHORT};\n`, "test/data.txt": `timeout: ${SHORT}\n`, "a.test.ts": "const retries = 1;\n" },
      { "src/app.ts": `const timeout = ${LONG};\n`, "test/data.txt": `timeout: ${LONG}\n`, "a.test.ts": "const retries = 9;\n" },
    );
    expect(record.status).toBe("pass");
  });

  it("applies an entry a consumer appends", async () => {
    const entry = {
      name: "custom",
      files: /\.cfg$/,
      pattern: /(?<key>wait)=(?<value>\d+)/,
      example: "wait=5",
    };
    TIMEOUT_SPELLINGS.push(entry);
    try {
      const record = await run({ "x.cfg": `wait=${SHORT}\n` }, { "x.cfg": `wait=${LONG}\n` });
      expect(record.status).toBe("fail");
      expect(record.evidence[0]).toContain("custom wait");
    } finally {
      TIMEOUT_SPELLINGS.pop();
    }
  });

  it("is sanctioned by a commit message line, by id or by file", async () => {
    const before = { "s.test.ts": `jest.setTimeout(${SHORT});\n` };
    const after = { "s.test.ts": `jest.setTimeout(${LONG});\n` };
    const byLine = await run(before, after, { message: "slow\n\nSanctioned-Weakening: timeout-raised:s.test.ts:1 the fixture is big" });
    expect(byLine.status).toBe("pass");
    expect(byLine.evidence[0]).toContain("sanctioned");
    expect(byLine.evidence[0]).toContain("the fixture is big");
    await rm(join(repo, ".git"), { recursive: true, force: true });
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
    const byFile = await run(before, after, { message: "slow\n\nSanctioned-Weakening: timeout-raised:s.test.ts because" });
    expect(byFile.status).toBe("pass");
  });

  it("is sanctioned by the caller, and not by a stray message line", async () => {
    const before = { "s.test.ts": `jest.setTimeout(${SHORT});\n` };
    const after = { "s.test.ts": `jest.setTimeout(${LONG});\n` };
    const byOption = await run(before, after, { sanctions: { "timeout-raised:s.test.ts:1": "agreed" } });
    expect(byOption.status).toBe("pass");
    expect(byOption.evidence[0]).toContain("agreed");
    await rm(join(repo, ".git"), { recursive: true, force: true });
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
    const stray = await run(before, after, { message: "slow\n\nNote: timeout-raised:s.test.ts:1 ok" });
    expect(stray.status).toBe("fail");
  });

  it("escapes characters outside printable ASCII in the evidence", async () => {
    const file = "café.test.ts";
    const record = await run({ [file]: `jest.setTimeout(${SHORT});\n` }, { [file]: `jest.setTimeout(${LONG});\n` });
    expect(record.status).toBe("fail");
    expect(/^[\x20-\x7e]*$/.test(record.evidence[0] ?? "")).toBe(true);
    expect(record.evidence[0]).toContain("\\u{00e9}");
  });

  it("fails closed on a revision that names no commit", async () => {
    const good = await commit(repo, { "a.txt": "x\n" });
    const missing = await check({ cwd: repo, base: "no-such-revision", candidate: good });
    expect(missing.status).toBe("fail");
    expect(missing.evidence.join("\n")).toContain("no-such-revision");
    const dashed = await check({ cwd: repo, base: good, candidate: "--output=x" });
    expect(dashed.status).toBe("fail");
  });

  it("fails closed when git itself fails", async () => {
    const record = await check({ cwd: join(repo, "does-not-exist"), base: "HEAD", candidate: "HEAD" });
    expect(record.status).toBe("fail");
    expect(record.evidence.length).toBeGreaterThan(0);
  });

  it("is the only record `repo-truth check --check RT-24` prints", async () => {
    await commit(repo, { "m.test.ts": `jest.setTimeout(${SHORT});\n` }, "base");
    await commit(repo, { "m.test.ts": `jest.setTimeout(${LONG});\n` }, "change");
    let stdout = "";
    const code = await main(["check", "--check", "RT-24", "--no-fetch", "--base", "HEAD~1", "--candidate", "main", "--format", "json"], {
      cwd: repo,
      stdout: (t) => void (stdout += t),
      stderr: () => undefined,
    });
    expect(code).not.toBe(0);
    const parsed = JSON.parse(stdout) as unknown;
    const records = (Array.isArray(parsed) ? parsed : (parsed as { records: unknown[] }).records) as { name: string }[];
    expect(records.map((r) => r.name)).toEqual(["RT-24"]);
  });
});
