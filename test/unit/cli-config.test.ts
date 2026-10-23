import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { EXIT_BAD_INVOCATION, EXIT_OK, main } from "../../src/cli.js";
import { REGISTRY, type RegistryEntry } from "../../src/registry.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(cwd: string, files: Record<string, string>, message: string): string {
  for (const [file, content] of Object.entries(files)) writeFileSync(join(cwd, file), content);
  git(cwd, "add", "-A");
  git(cwd, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

const config = (limit: unknown) =>
  JSON.stringify({ schema: "repo-truth.config/v1", checks: { REC: { limit } } });

async function run(argv: string[], cwd: string) {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, { cwd, stdout: (t) => void (stdout += t), stderr: (t) => void (stderr += t) });
  return { code, stdout, stderr };
}

const seen: unknown[][] = [];
const recorder: RegistryEntry = {
  name: "REC",
  options: { limit: "integer" },
  run: (...args) => {
    seen.push(args.slice(2));
    return { name: "REC", status: "pass", evidence: [] };
  },
};
const original = [...REGISTRY];

let root: string;
let withFile: string;
let without: string;
let baseWith: string;
let candWith: string;
let baseWithout: string;
let candWithout: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "repo-truth-cli-config-"));
  withFile = join(root, "with");
  git(root, "init", "-q", "-b", "main", withFile);
  baseWith = commit(withFile, { "repo-truth.json": config(5) }, "base");
  candWith = commit(withFile, { "repo-truth.json": config(99) }, "candidate");
  without = join(root, "without");
  git(root, "init", "-q", "-b", "main", without);
  baseWithout = commit(without, { "a.txt": "1\n" }, "base");
  candWithout = commit(without, { "a.txt": "2\n" }, "candidate");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

afterEach(() => {
  seen.length = 0;
  REGISTRY.splice(0, REGISTRY.length, ...original);
});

const argv = (base: string, candidate: string, ...more: string[]) => [
  "check", "--no-fetch", "--base", base, "--candidate", candidate, "--format", "json", ...more,
];

describe("the configuration the command reads", () => {
  it("hands the base's options, not the candidate's, and names the source", async () => {
    REGISTRY.splice(0, REGISTRY.length, recorder);
    const result = await run(argv(baseWith, candWith), withFile);
    expect(result.code).toBe(EXIT_OK);
    expect(seen).toEqual([[{ limit: 5 }]]);
    const doc = JSON.parse(result.stdout);
    expect(doc.config).toBe(`repo-truth.json at ${baseWith.slice(0, 12)}`);
    expect(Object.keys(doc)).toEqual(["schema", "base", "candidate", "config", "ok", "exitCode", "records"]);
  });

  it("reads a --config file in place of the base's, relative to the directory", async () => {
    REGISTRY.splice(0, REGISTRY.length, recorder);
    writeFileSync(join(withFile, "other.json"), config(7));
    const result = await run(argv(baseWith, candWith, "--config", "other.json"), withFile);
    expect(result.code).toBe(EXIT_OK);
    expect(seen).toEqual([[{ limit: 7 }]]);
    expect(JSON.parse(result.stdout).config).toBe("other.json");
    rmSync(join(withFile, "other.json"));
  });

  it("hands nothing when the base holds no file, and the document's config is null", async () => {
    REGISTRY.splice(0, REGISTRY.length, recorder);
    const result = await run(argv(baseWithout, candWithout), without);
    expect(result.code).toBe(EXIT_OK);
    expect(seen).toEqual([[]]);
    expect(JSON.parse(result.stdout).config).toBeNull();
  });
});

describe("a configuration the command refuses", () => {
  it("an option of the wrong kind is exit 2, with no check run and no usage text", async () => {
    REGISTRY.splice(0, REGISTRY.length, recorder);
    const bad = commit(withFile, { "repo-truth.json": config("many") }, "bad");
    const result = await run(argv(bad, bad), withFile);
    expect(result.code).toBe(EXIT_BAD_INVOCATION);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^repo-truth: /);
    expect(result.stderr).toContain("checks.REC.limit");
    expect(result.stderr).not.toContain("usage:");
    expect(seen).toEqual([]);
  });

  it("a --config path that does not exist is exit 2", async () => {
    REGISTRY.splice(0, REGISTRY.length, recorder);
    const result = await run(argv(baseWith, candWith, "--config", "missing.json"), withFile);
    expect(result.code).toBe(EXIT_BAD_INVOCATION);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("missing.json");
    expect(result.stderr).not.toContain("usage:");
    expect(seen).toEqual([]);
  });

  it("--config with no value is a usage error", async () => {
    REGISTRY.splice(0, REGISTRY.length, recorder);
    const result = await run(["check", "--no-fetch", "--base", baseWith, "--candidate", candWith, "--config"], withFile);
    expect(result.code).toBe(EXIT_BAD_INVOCATION);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--config needs a value");
    expect(result.stderr).toContain("usage: repo-truth check");
    expect(seen).toEqual([]);
  });
});
