import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as mod from "../../src/checks/install-scripts.js";
import { check, name } from "../../src/checks/install-scripts.js";

const execFileAsync = promisify(execFile);

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "Test Committer",
  GIT_COMMITTER_EMAIL: "committer@example.com",
};

const LOCK = "package-lock.json";
const SHRINK = "sub/npm-shrinkwrap.json";
const NOTE = "no install script added";

type Pk = Record<string, unknown>;
const lock = (pk: Pk, version = 3): string =>
  JSON.stringify({ name: "x", lockfileVersion: version, packages: { "": { name: "x" }, ...pk } }, null, 2) + "\n";
const v = (version: string, extra: Pk = {}): Pk => ({ version, ...extra });
const FLAG = { hasInstallScript: true };

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

describe("RT-94 install scripts added", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "repo-truth-install-scripts-"));
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
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

  const sorted = (lines: readonly string[]): string[] => [...lines].sort();

  it("is named RT-94 and exports no optionKinds", () => {
    expect(name).toBe("RT-94");
    expect("optionKinds" in mod).toBe(false);
  });

  it("reports flagged direct and nested packages in both file names", async () => {
    const pk = { "node_modules/a": v("1.0.0", FLAG), "node_modules/a/node_modules/b": v("2.0.0", FLAG), "node_modules/c": v("3.0.0") };
    const record = await run({}, { [LOCK]: lock(pk), [SHRINK]: lock(pk) });
    expect(record.name).toBe("RT-94");
    expect(record.status).toBe("fail");
    expect(sorted(record.evidence)).toEqual(
      sorted([
        "package-lock.json: install-script node_modules/a@1.0.0",
        "package-lock.json: install-script node_modules/a/node_modules/b@2.0.0",
        "sub/npm-shrinkwrap.json: install-script node_modules/a@1.0.0",
        "sub/npm-shrinkwrap.json: install-script node_modules/a/node_modules/b@2.0.0",
      ]),
    );
  });

  it("omits the version when the entry has no string version", async () => {
    const record = await run({}, { [LOCK]: lock({ "node_modules/a": FLAG, "node_modules/b": { version: 2, ...FLAG } }) });
    expect(record.status).toBe("fail");
    expect(sorted(record.evidence)).toEqual(["package-lock.json: install-script node_modules/a", "package-lock.json: install-script node_modules/b"]);
  });

  it("reports a present package that gains the flag", async () => {
    const record = await run({ [LOCK]: lock({ "node_modules/a": v("1.0.0") }) }, { [LOCK]: lock({ "node_modules/a": v("1.0.0", FLAG) }) });
    expect(record).toEqual({ name: "RT-94", status: "fail", evidence: ["package-lock.json: install-script node_modules/a@1.0.0"] });
  });

  it("ignores an entry already flagged, whatever its version, and a removed one", async () => {
    const record = await run(
      { [LOCK]: lock({ "node_modules/a": v("1.0.0", FLAG), "node_modules/b": v("1.0.0", FLAG) }) },
      { [LOCK]: lock({ "node_modules/a": v("2.0.0", FLAG) }) },
    );
    expect(record).toEqual({ name: "RT-94", status: "pass", evidence: [NOTE] });
  });

  it("ignores hasInstallScript that is not true", async () => {
    const record = await run({}, { [LOCK]: lock({ "node_modules/a": v("1.0.0", { hasInstallScript: false }), "node_modules/b": v("1.0.0", { hasInstallScript: "true" }) }) });
    expect(record).toEqual({ name: "RT-94", status: "pass", evidence: [NOTE] });
  });

  it("does not read other file names", async () => {
    const body = lock({ "node_modules/a": v("1.0.0", FLAG) });
    const record = await run({}, { "yarn.lock": body, "pnpm-lock.yaml": body, "my-package-lock.json": body, "package-lock.json.bak": body });
    expect(record).toEqual({ name: "RT-94", status: "pass", evidence: [NOTE] });
  });

  it("reads a rename against its source", async () => {
    const pk = { "node_modules/a": v("1.0.0", FLAG), "node_modules/b": v("1.0.0") };
    const record = await run({ "old/lock.json": lock(pk) }, { "old/lock.json": null, [LOCK]: lock({ ...pk, "node_modules/b": v("1.0.0", FLAG) }) });
    expect(record.evidence).toEqual(["package-lock.json: install-script node_modules/b@1.0.0"]);
    expect(record.status).toBe("fail");
  });

  it("reads a lockfile added whole", async () => {
    const record = await run({}, { [LOCK]: lock({ "node_modules/a": v("1.0.0", FLAG) }) });
    expect(record.status).toBe("fail");
  });

  it("yields nothing for a version 1 lockfile", async () => {
    const v1 = JSON.stringify({ name: "x", lockfileVersion: 1, dependencies: { a: { version: "1.0.0", hasInstallScript: true } } });
    expect(await run({}, { [LOCK]: v1 })).toEqual({ name: "RT-94", status: "pass", evidence: [NOTE] });
  });

  it("fails for a candidate lockfile that is not JSON", async () => {
    const record = await run({}, { [LOCK]: "{ nope" });
    expect(record.status).toBe("fail");
    expect(record.evidence).toHaveLength(1);
    expect(record.evidence[0]).toContain("package-lock.json");
  });

  it("fails for a source lockfile that is not JSON", async () => {
    const record = await run({ [LOCK]: "{ nope" }, { [LOCK]: lock({ "node_modules/a": v("1.0.0") }) });
    expect(record.status).toBe("fail");
    expect(record.evidence).toHaveLength(1);
    expect(record.evidence[0]).toContain("package-lock.json");
  });

  it("is sanctioned by a commit message line with the reason on the evidence line", async () => {
    const record = await run({}, { [LOCK]: lock({ "node_modules/a": v("1.0.0", FLAG) }) }, { message: "add\n\nSanctioned-Weakening: install-script:package-lock.json esbuild needs it" });
    expect(record).toEqual({
      name: "RT-94",
      status: "pass",
      evidence: ["package-lock.json: install-script node_modules/a@1.0.0 - sanctioned: esbuild needs it"],
    });
  });

  it("is sanctioned by the caller's sanctions", async () => {
    const record = await run({}, { [LOCK]: lock({ "node_modules/a": v("1.0.0", FLAG) }) }, { sanctions: { "install-script:package-lock.json": "approved" } });
    expect(record.status).toBe("pass");
    expect(record.evidence).toEqual(["package-lock.json: install-script node_modules/a@1.0.0 - sanctioned: approved"]);
  });

  it("is not sanctioned by a line naming another file or giving no reason", async () => {
    const message = "add\n\nSanctioned-Weakening: install-script:sub/package-lock.json why\nSanctioned-Weakening: install-script:package-lock.json";
    const record = await run({}, { [LOCK]: lock({ "node_modules/a": v("1.0.0", FLAG) }) }, { message });
    expect(record.status).toBe("fail");
    expect(record.evidence).toEqual(["package-lock.json: install-script node_modules/a@1.0.0"]);
  });

  it("does not count an entry the other side added after the merge base", async () => {
    await commit(repo, { "keep.txt": "keep\n", [LOCK]: lock({ "node_modules/a": v("1.0.0") }) }, "root");
    await git(repo, ["checkout", "--quiet", "-b", "side"]);
    const candidate = await commit(repo, { "other.txt": "x\n" }, "side change");
    await git(repo, ["checkout", "--quiet", "main"]);
    const base = await commit(repo, { [LOCK]: lock({ "node_modules/a": v("1.0.0"), "node_modules/z": v("1.0.0", FLAG) }) }, "main change");
    expect(await check({ cwd: repo, base, candidate })).toEqual({ name: "RT-94", status: "pass", evidence: [NOTE] });
  });

  it("fails for a revision that names no commit", async () => {
    const base = await commit(repo, { "keep.txt": "keep\n" }, "base");
    const record = await check({ cwd: repo, base, candidate: "no-such-revision" });
    expect(record.status).toBe("fail");
    expect(record.evidence[0]).toContain("no-such-revision");
  });
});
