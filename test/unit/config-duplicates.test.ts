import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ConfigError, parseConfig, readConfig, type OptionKinds } from "../../src/config.js";

const kinds: OptionKinds = { "RT-12": { maxBytes: "integer" }, "RT-18": { registries: "strings" } };
const head = '"schema":"repo-truth.config/v1"';

function issues(text: string): string[] | null {
  try {
    parseConfig(text, kinds);
    return null;
  } catch (error) {
    return error instanceof ConfigError ? error.issues : ["not a ConfigError"];
  }
}

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("repeated member names", () => {
  it("refuses a repeated top-level member", () => {
    expect(issues(`{${head},"checks":{},"checks":{}}`)).toEqual(["checks: given more than once"]);
  });
  it("refuses a repeated check", () => {
    expect(issues(`{${head},"checks":{"RT-12":{},"RT-12":{}}}`)).toEqual(["checks.RT-12: given more than once"]);
  });
  it("refuses a repeated option and a name given three times", () => {
    expect(issues(`{${head},"checks":{"RT-12":{"maxBytes":1,"maxBytes":2,"maxBytes":3}}}`)).toEqual([
      "checks.RT-12.maxBytes: given more than once",
      "checks.RT-12.maxBytes: given more than once",
    ]);
  });
  it("compares names once their escapes are decoded", () => {
    expect(issues(`{${head},"checks":{"RT-12":{"maxBytes":1,"max\\u0042ytes":2}}}`)).toEqual(["checks.RT-12.maxBytes: given more than once"]);
  });
  it("names an element of an array by its index", () => {
    expect(issues(`{${head},"checks":{"RT-18":{"registries":["a",{"x":1,"x":2}]}}}`)).toEqual([
      "checks.RT-18.registries[1].x: given more than once",
      'checks.RT-18.registries: expected an array of strings, found ["a",{"x":2}]',
    ]);
  });
  it("puts repeats first, in text order, ahead of other issues", () => {
    expect(issues(`{"x":1,${head},"checks":{"RT-99":{},"RT-12":{"maxBytes":1,"maxBytes":-1}},"x":2}`)).toEqual([
      "checks.RT-12.maxBytes: given more than once",
      "x: given more than once",
      "x: unknown key, only schema and checks are allowed",
      "checks.RT-99: unknown check",
      "checks.RT-12.maxBytes: expected a non-negative safe integer, found -1",
    ]);
  });
  it("reads equal names in different objects and name-like text in strings", () => {
    expect(issues(`{${head},"checks":{"RT-12":{"maxBytes":1},"RT-18":{"registries":["\\"maxBytes\\":2"]}}}`)).toBeNull();
  });
  it("leaves invalid JSON and non-objects to the usual issue", () => {
    expect(issues('{"a":1,"a":2')?.[0]).toMatch(/^the document: not valid JSON/);
    expect(issues('[{"a":1,"a":2}]')).toEqual(["the document: expected a JSON object, found an array"]);
  });
});

describe("readConfig", () => {
  const root = mkdtempSync(join(tmpdir(), "rt-dup-"));
  roots.push(root);
  const text = `{${head},"checks":{"RT-12":{"maxBytes":1,"maxBytes":2}}}`;
  const run = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });

  it("refuses a repo-truth.json at the base with its source", async () => {
    run("init", "-q");
    writeFileSync(join(root, "repo-truth.json"), text);
    run("add", ".");
    run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "c");
    const sha = run("rev-parse", "HEAD").toString().trim();
    await expect(readConfig({ cwd: root, base: "HEAD" }, kinds)).rejects.toThrow(
      `repo-truth.json at ${sha.slice(0, 12)}: 1 configuration issue\n  checks.RT-12.maxBytes: given more than once`,
    );
  });
  it("refuses a --config file with its source", async () => {
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "c.json"), text);
    await expect(readConfig({ cwd: root, base: "HEAD", path: "sub/c.json" }, kinds)).rejects.toThrow(
      "sub/c.json: 1 configuration issue\n  checks.RT-12.maxBytes: given more than once",
    );
  });
});
