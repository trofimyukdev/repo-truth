import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../../src/cli.js";
import { REGISTRY, loadCheckDirectory } from "../../src/registry.js";
import type { RegistryEntry, Repository } from "../../src/registry.js";

const range = { base: "a", candidate: "b" };

let dir: string;
let entries: RegistryEntry[];
let repoDir: string;

function find(name: string): RegistryEntry {
  const found = entries.find((e) => e.name === name);
  if (found === undefined) throw new Error("no entry " + name);
  return found;
}

function git(...args: string[]): void {
  execFileSync("git", ["-C", repoDir, "-c", "user.name=T", "-c", "user.email=t@example.com", ...args]);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "repo-truth-handoff-"));
  await writeFile(
    join(dir, "a-plain.mjs"),
    'export const name = "H-01";\n' +
      'export const optionKinds = { limit: "integer" };\n' +
      'export const check = (o) => ({ name: "H-01", status: "pass", evidence: [JSON.stringify(o)] });\n',
  );
  await writeFile(
    join(dir, "b-config.mjs"),
    'export const name = "H-02";\n' +
      'export const optionKinds = { config: "string" };\n' +
      'export const check = (o) => ({ name: "H-02", status: "pass", evidence: [JSON.stringify(o)] });\n',
  );
  entries = await loadCheckDirectory(pathToFileURL(dir + "/"), ".mjs");

  repoDir = await mkdtemp(join(tmpdir(), "repo-truth-handoff-repo-"));
  git("init", "-q");
  await writeFile(join(repoDir, "x.json"), '{"schema":"repo-truth.config/v1"}');
  git("commit", "-q", "--allow-empty", "-m", "a");
  git("commit", "-q", "--allow-empty", "-m", "b");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(repoDir, { recursive: true, force: true });
});

describe("entry hands the check the config of the repository", () => {
  it("hands the whole object with a repository that carries config", async () => {
    const record = await find("H-01").run({ cwd: "/r", config: "c j.json" }, range, { limit: 3 });
    expect(JSON.parse(record.evidence[0] as string)).toEqual({
      limit: 3,
      config: "c j.json",
      cwd: "/r",
      base: "a",
      candidate: "b",
    });
  });

  it("hands no config key with a repository that carries none", async () => {
    const record = await find("H-01").run({ cwd: "/r" }, range);
    const handed = JSON.parse(record.evidence[0] as string);
    expect(handed).toEqual({ cwd: "/r", base: "a", candidate: "b" });
    expect(Object.keys(handed)).not.toContain("config");
  });

  it("never takes config from the options given", async () => {
    const without = await find("H-01").run({ cwd: "/r" }, range, { config: "evil" });
    expect(Object.keys(JSON.parse(without.evidence[0] as string))).not.toContain("config");
    const withOne = await find("H-01").run({ cwd: "/r", config: "real.json" }, range, { config: "evil" });
    expect(JSON.parse(withOne.evidence[0] as string).config).toBe("real.json");
  });

  it("fails a module that declares an option named config", async () => {
    const failing = entries.find((e) => e.name === "checks/b-config");
    expect(failing?.options).toEqual({});
    const record = await failing?.run({ cwd: "/r" }, range);
    expect(record?.status).toBe("fail");
    expect(record?.evidence[0]).toContain("b-config.mjs");
    expect(record?.evidence[0]).toContain("config");
  });
});

describe("main hands every check the path --config named", () => {
  const argv = ["check", "--no-fetch", "--base", "HEAD~1", "--candidate", "HEAD"];

  async function seen(extra: string[]): Promise<Repository[]> {
    const saved = REGISTRY.splice(0, REGISTRY.length);
    const repos: Repository[] = [];
    const recorder = (name: string): RegistryEntry => ({
      name,
      run: (r) => {
        repos.push(r);
        return { name, status: "pass", evidence: [] };
      },
    });
    REGISTRY.push(recorder("REC-1"), recorder("REC-2"));
    try {
      const code = await main([...argv, ...extra], { cwd: repoDir, stdout: () => {}, stderr: () => {} });
      expect(code).toBe(0);
    } finally {
      REGISTRY.splice(0, REGISTRY.length, ...saved);
    }
    return repos;
  }

  it("hands a relative path as given", async () => {
    const repos = await seen(["--config", "x.json"]);
    expect(repos).toEqual([
      { cwd: repoDir, config: "x.json" },
      { cwd: repoDir, config: "x.json" },
    ]);
  });

  it("hands an absolute path as given", async () => {
    const path = join(repoDir, "x.json");
    const repos = await seen(["--config", path]);
    expect(repos).toEqual([
      { cwd: repoDir, config: path },
      { cwd: repoDir, config: path },
    ]);
  });

  it("hands the path of --config=<path>", async () => {
    const repos = await seen(["--config=x.json"]);
    expect(repos.map((r) => r.config)).toEqual(["x.json", "x.json"]);
  });

  it("hands no config without --config", async () => {
    const repos = await seen([]);
    expect(repos).toEqual([{ cwd: repoDir }, { cwd: repoDir }]);
    for (const r of repos) expect(Object.hasOwn(r, "config")).toBe(false);
  });
});
