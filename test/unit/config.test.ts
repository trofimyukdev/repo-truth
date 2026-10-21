import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CONFIG_FILE,
  CONFIG_SCHEMA,
  ConfigError,
  OPTION_KINDS,
  parseConfig,
  readConfig,
  type OptionKinds,
} from "../../src/config.js";

const kinds: OptionKinds = {
  alpha: { count: "integer", flag: "boolean", name: "string", names: "strings" },
  beta: { limit: "integer" },
};

const doc = (value: unknown): string => JSON.stringify(value);
const withSchema = (rest: object): string => doc({ schema: CONFIG_SCHEMA, ...rest });

function issuesOf(text: string): string[] {
  try {
    parseConfig(text, kinds);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).issues;
  }
  throw new Error("expected a refusal");
}

describe("constants", () => {
  it("states the file, schema and kinds", () => {
    expect(CONFIG_FILE).toBe("repo-truth.json");
    expect(CONFIG_SCHEMA).toBe("repo-truth.config/v1");
    expect([...OPTION_KINDS]).toEqual(["integer", "boolean", "string", "strings"]);
  });
});

describe("parseConfig", () => {
  it("accepts an option of each kind", () => {
    const checks = { alpha: { count: 3, flag: false, name: "x", names: ["a", "b"] }, beta: {} };
    expect(parseConfig(withSchema({ checks }), kinds)).toEqual(checks);
  });

  it("accepts zero and an empty list", () => {
    const checks = { alpha: { count: 0, names: [] } };
    expect(parseConfig(withSchema({ checks }), kinds)).toEqual(checks);
  });

  it("answers no options when checks is absent", () => {
    expect(parseConfig(withSchema({}), kinds)).toEqual({});
  });

  it("refuses text that is not JSON with one issue", () => {
    const issues = issuesOf("{ // no\n}");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/not valid JSON/);
    expect(issuesOf('{"schema": "x",}')).toHaveLength(1);
  });

  it("refuses documents that are not objects", () => {
    for (const text of ["[]", "null", "3", '"s"', "true"]) {
      const issues = issuesOf(text);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatch(/^the document:/);
    }
  });

  it("refuses a missing and a wrong schema", () => {
    expect(issuesOf("{}")).toEqual([`schema: required, must be "${CONFIG_SCHEMA}"`]);
    expect(issuesOf(doc({ schema: "repo-truth.config/v2" }))[0]).toMatch(/^schema: expected/);
    expect(issuesOf(doc({ schema: 1 }))[0]).toMatch(/^schema: expected/);
  });

  it("refuses an unknown top-level key", () => {
    expect(issuesOf(withSchema({ extra: 1 }))).toEqual(["extra: unknown key, only schema and checks are allowed"]);
  });

  it("refuses checks that is not an object", () => {
    for (const checks of [[], null, 4, "s"]) {
      const issues = issuesOf(withSchema({ checks }));
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatch(/^checks: expected an object/);
    }
  });

  it("refuses an unknown check and a check that is not an object", () => {
    expect(issuesOf(withSchema({ checks: { gamma: {} } }))).toEqual(["checks.gamma: unknown check"]);
    expect(issuesOf(withSchema({ checks: { toString: {} } }))).toEqual(["checks.toString: unknown check"]);
    for (const value of [[], null, 1]) {
      expect(issuesOf(withSchema({ checks: { alpha: value } }))[0]).toMatch(/^checks\.alpha: expected an object/);
    }
  });

  it("refuses an unknown option", () => {
    expect(issuesOf(withSchema({ checks: { alpha: { nope: 1 } } }))).toEqual(["checks.alpha.nope: unknown option of alpha"]);
    expect(issuesOf(withSchema({ checks: { alpha: { constructor: 1 } } }))).toHaveLength(1);
  });

  it("refuses a value of each wrong kind", () => {
    const wrong: Array<[string, unknown]> = [
      ["count", 1.5],
      ["count", -1],
      ["count", "3"],
      ["count", 2 ** 53],
      ["count", null],
      ["flag", "true"],
      ["flag", 1],
      ["name", 4],
      ["name", ["a"]],
      ["names", "a"],
      ["names", ["a", 1]],
      ["names", [["a"]]],
    ];
    for (const [option, value] of wrong) {
      const issues = issuesOf(withSchema({ checks: { alpha: { [option]: value } } }));
      expect(issues, option).toHaveLength(1);
      expect(issues[0]).toMatch(new RegExp(`^checks\\.alpha\\.${option}: expected `));
    }
  });

  it("names every problem, in the order of the document", () => {
    const text = '{"checks":{"gamma":{},"alpha":{"count":-1,"bogus":true}},"schema":"nope","extra":0}';
    expect(issuesOf(text)).toEqual([
      "checks.gamma: unknown check",
      "checks.alpha.count: expected a non-negative safe integer, found -1",
      "checks.alpha.bogus: unknown option of alpha",
      `schema: expected "${CONFIG_SCHEMA}", found "nope"`,
      "extra: unknown key, only schema and checks are allowed",
    ]);
  });

  it("escapes characters outside printable ASCII, in issues and in the message", () => {
    let error: ConfigError | undefined;
    try {
      parseConfig(withSchema({ checks: { "a\u0007bé\u{1f600}": {} } }), kinds);
    } catch (caught) {
      error = caught as ConfigError;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect(error?.issues).toEqual(["checks.a\\u{0007}b\\u{00e9}\\u{1f600}: unknown check"]);
    expect(error?.message).toContain("1 configuration issue");
    expect(error?.message).toContain("checks.a\\u{0007}b\\u{00e9}\\u{1f600}: unknown check");
    expect(error?.message).not.toMatch(/[^\x20-\x7e\n]/);
  });

  it("counts the issues in the message", () => {
    try {
      parseConfig(withSchema({ a: 1, b: 2, c: 3 }), kinds);
    } catch (error) {
      expect((error as ConfigError).message).toContain("3 configuration issues");
    }
  });
});

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  }).trim();
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "repo-truth-config-"));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "commit.gpgsign", "false");
  return root;
}

function commit(root: string, message: string): string {
  git(root, "add", "-A");
  git(root, "commit", "-q", "--allow-empty", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

const good = withSchema({ checks: { beta: { limit: 7 } } });

async function refusal(promise: Promise<unknown>): Promise<ConfigError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error("expected a refusal");
}

describe("readConfig from the base commit", () => {
  it("answers no options when the base has no file", async () => {
    const root = repo();
    writeFileSync(join(root, "other"), "x");
    const base = commit(root, "base");
    expect(await readConfig({ cwd: root, base }, kinds)).toEqual({ source: null, options: {} });
  });

  it("reads the file of the base and names it with twelve characters of the id", async () => {
    const root = repo();
    writeFileSync(join(root, CONFIG_FILE), good);
    const base = commit(root, "base");
    const result = await readConfig({ cwd: root, base }, kinds);
    expect(result.options).toEqual({ beta: { limit: 7 } });
    expect(result.source).toContain(CONFIG_FILE);
    expect(result.source).toContain(base.slice(0, 12));
    expect(result.source).not.toContain(base.slice(0, 13));
  });

  it("reads an executable file", async () => {
    const root = repo();
    writeFileSync(join(root, CONFIG_FILE), good, { mode: 0o755 });
    const base = commit(root, "base");
    expect((await readConfig({ cwd: root, base }, kinds)).options).toEqual({ beta: { limit: 7 } });
  });

  it("reads neither the working tree nor the candidate", async () => {
    const root = repo();
    writeFileSync(join(root, CONFIG_FILE), good);
    const base = commit(root, "base");
    writeFileSync(join(root, CONFIG_FILE), withSchema({ checks: { beta: { limit: 99 } } }));
    const candidate = commit(root, "candidate");
    writeFileSync(join(root, CONFIG_FILE), withSchema({ checks: { beta: { limit: 1000 } } }));
    expect(candidate).not.toBe(base);
    expect((await readConfig({ cwd: root, base }, kinds)).options).toEqual({ beta: { limit: 7 } });
    expect((await readConfig({ cwd: root, base: candidate }, kinds)).options).toEqual({ beta: { limit: 99 } });
  });

  it("ignores a working-tree file the base does not have", async () => {
    const root = repo();
    writeFileSync(join(root, "other"), "x");
    const base = commit(root, "base");
    writeFileSync(join(root, CONFIG_FILE), good);
    expect(await readConfig({ cwd: root, base }, kinds)).toEqual({ source: null, options: {} });
  });

  it("refuses a symbolic link", async () => {
    const root = repo();
    writeFileSync(join(root, "real.json"), good);
    symlinkSync("real.json", join(root, CONFIG_FILE));
    const base = commit(root, "base");
    const error = await refusal(readConfig({ cwd: root, base }, kinds));
    expect(error.issues[0]).toMatch(/regular file.*symlink|regular file.*blob.*120000/);
  });

  it("refuses a directory", async () => {
    const root = repo();
    mkdirSync(join(root, CONFIG_FILE));
    writeFileSync(join(root, CONFIG_FILE, "inner"), "x");
    const base = commit(root, "base");
    const error = await refusal(readConfig({ cwd: root, base }, kinds));
    expect(error.issues[0]).toMatch(/regular file.*tree/);
  });

  it("names the source before the issues of a bad document", async () => {
    const root = repo();
    writeFileSync(join(root, CONFIG_FILE), withSchema({ checks: { nope: {} } }));
    const base = commit(root, "base");
    const error = await refusal(readConfig({ cwd: root, base }, kinds));
    expect(error.issues).toEqual(["checks.nope: unknown check"]);
    expect(error.message.indexOf(base.slice(0, 12))).toBeGreaterThanOrEqual(0);
    expect(error.message.indexOf(base.slice(0, 12))).toBeLessThan(error.message.indexOf("checks.nope"));
  });

  it("refuses a revision that names no commit, naming it", async () => {
    const root = repo();
    commit(root, "base");
    const error = await refusal(readConfig({ cwd: root, base: "no-such-revision" }, kinds));
    expect(error.message).toContain("no-such-revision");
    const dashed = await refusal(readConfig({ cwd: root, base: "--no-such" }, kinds));
    expect(dashed.message).toContain("--no-such");
  });

  it("refuses when git fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "repo-truth-config-"));
    roots.push(root);
    await refusal(readConfig({ cwd: root, base: "HEAD" }, kinds));
    await refusal(readConfig({ cwd: join(root, "missing"), base: "HEAD" }, kinds));
  });
});

describe("readConfig from a named file", () => {
  it("reads a relative and an absolute path without running git", async () => {
    const root = mkdtempSync(join(tmpdir(), "repo-truth-config-"));
    roots.push(root);
    writeFileSync(join(root, "mine.json"), good);
    const relative = await readConfig({ cwd: root, base: "no-such-revision", path: "mine.json" }, kinds);
    expect(relative).toEqual({ source: "mine.json", options: { beta: { limit: 7 } } });
    const absolute = join(root, "mine.json");
    expect(await readConfig({ cwd: root, base: "no-such-revision", path: absolute }, kinds)).toEqual({
      source: absolute,
      options: { beta: { limit: 7 } },
    });
  });

  it("refuses a missing file, naming it", async () => {
    const root = mkdtempSync(join(tmpdir(), "repo-truth-config-"));
    roots.push(root);
    const error = await refusal(readConfig({ cwd: root, base: "HEAD", path: "absent.json" }, kinds));
    expect(error.message).toContain("absent.json");
  });

  it("refuses a directory in place of the file", async () => {
    const root = mkdtempSync(join(tmpdir(), "repo-truth-config-"));
    roots.push(root);
    mkdirSync(join(root, "dir.json"));
    const error = await refusal(readConfig({ cwd: root, base: "HEAD", path: "dir.json" }, kinds));
    expect(error.message).toContain("dir.json");
  });

  it("names the file when its document is bad", async () => {
    const root = mkdtempSync(join(tmpdir(), "repo-truth-config-"));
    roots.push(root);
    writeFileSync(join(root, "bad.json"), "not json");
    const error = await refusal(readConfig({ cwd: root, base: "HEAD", path: "bad.json" }, kinds));
    expect(error.message).toContain("bad.json");
    expect(error.issues).toHaveLength(1);
  });
});
