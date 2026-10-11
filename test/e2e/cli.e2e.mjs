/**
 * End-to-end suite: runs the built `repo-truth` the way a user does - the file
 * package.json's `bin` names, as a child process, over throwaway git repositories.
 *
 *   npm run build && node --test test/e2e/cli.e2e.mjs
 *
 * Not collected by `npx vitest run`: the name matches no vitest pattern.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const BIN = resolve(ROOT, pkg.bin["repo-truth"]);
const REGISTRY_FILE = join(ROOT, "dist", "registry.js");

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

let scratch;
let names = [];
let counter = 0;
let ran = 0;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A fresh repository with a base commit and a candidate commit carrying `message`. */
function makeRepo(message = "add a file") {
  const dir = join(scratch, "repo-" + counter++);
  execFileSync("git", ["init", "--quiet", dir], { env: GIT_ENV });
  git(dir, "config", "user.name", "Test User");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "initial commit");
  const base = git(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "notes.txt"), "some notes\n");
  git(dir, "add", "-A");
  const messageFile = join(scratch, "message-" + counter++ + ".txt");
  writeFileSync(messageFile, message + "\n", "utf8");
  git(dir, "commit", "--quiet", "-F", messageFile);
  return { dir, base, candidate: git(dir, "rev-parse", "HEAD") };
}

/** `node <bin> check ...args` in `cwd`, as a process of its own. */
function run(cwd, ...args) {
  ran++;
  const result = spawnSync(process.execPath, [BIN, "check", ...args], {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(result.error, undefined, "could not run the built file: " + result.error);
  assert.equal(result.signal, null, "the process was killed by a signal");
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The document agrees with its own records and with the process's exit code. */
function assertAgrees(doc, result) {
  assert.ok(Array.isArray(doc.records) && doc.records.length > 0, "records is a non-empty array");
  const ok = doc.records.every((r) => r.status === "pass" || r.status === "skip");
  for (const r of doc.records) {
    assert.ok(["pass", "fail", "skip"].includes(r.status), "record " + r.name + " has status " + r.status);
    assert.ok(Array.isArray(r.evidence));
  }
  assert.equal(doc.ok, ok);
  assert.equal(doc.exitCode, ok ? 0 : 1);
  assert.equal(result.code, doc.exitCode);
}

function assertRefused(result, mention) {
  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.ok(result.stderr.includes(mention), "stderr names " + JSON.stringify(mention) + ": " + result.stderr);
}

before(async () => {
  assert.ok(existsSync(BIN), "the built file " + BIN + " is missing: run `npm run build` first");
  assert.ok(existsSync(REGISTRY_FILE), REGISTRY_FILE + " is missing: run `npm run build` first");
  const { REGISTRY } = await import(pathToFileURL(REGISTRY_FILE).href);
  names = REGISTRY.map((e) => e.name);
  assert.ok(names.length > 0, "the built REGISTRY holds no check");
  scratch = mkdtempSync(join(tmpdir(), "repo-truth-e2e-"));
});

after(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("repo-truth check, built", () => {
  test("the bin field names a file that exists", () => {
    assert.ok(existsSync(BIN), BIN + " is missing: run `npm run build` first");
  });

  test("a default run answers 0 or 1 with one record per registered check, in order", () => {
    const { dir, base, candidate } = makeRepo();
    const result = run(dir, "--base", base, "--candidate", candidate, "--format", "json", "--no-fetch");
    assert.ok(result.code === 0 || result.code === 1, "exit code " + result.code + ": " + result.stderr);
    const doc = JSON.parse(result.stdout);
    assert.deepEqual(doc.records.map((r) => r.name), names);
    assert.equal(doc.base, base);
    assert.equal(doc.candidate, candidate);
    assertAgrees(doc, result);
  });

  test("a text run ends with a verdict line that agrees with the exit code", () => {
    const { dir, base, candidate } = makeRepo();
    const result = run(dir, "--base", base, "--candidate", candidate, "--no-fetch");
    assert.ok(result.code === 0 || result.code === 1, "exit code " + result.code + ": " + result.stderr);
    const last = result.stdout.trimEnd().split("\n").pop();
    assert.equal(last, result.code === 0 ? "repo-truth: all checks passed" : "repo-truth: at least one check failed");
    for (const name of names) assert.ok(result.stdout.includes(name), name + " appears in the output");
  });

  test("each registered name given to --check runs that check alone", () => {
    const { dir, base, candidate } = makeRepo();
    for (const name of names) {
      const result = run(dir, "--base", base, "--candidate", candidate, "--check", name, "--format", "json", "--no-fetch");
      assert.ok(result.code === 0 || result.code === 1, name + ": exit code " + result.code + ": " + result.stderr);
      const doc = JSON.parse(result.stdout);
      assert.deepEqual(doc.records.map((r) => r.name), [name]);
      assertAgrees(doc, result);
    }
  });

  test("a commit message outside printable ASCII exits 1 with a fail record", () => {
    const { dir, base, candidate } = makeRepo("add a file — with a dash and café");
    const result = run(dir, "--base", base, "--candidate", candidate, "--format", "json", "--no-fetch");
    assert.equal(result.code, 1, result.stderr);
    const doc = JSON.parse(result.stdout);
    assert.ok(doc.records.some((r) => r.status === "fail"), "at least one fail record");
    assert.deepEqual(doc.records.map((r) => r.name), names);
    assertAgrees(doc, result);
  });

  test("a revision that names no commit exits 2, stdout empty, the revision named", () => {
    const { dir, base } = makeRepo();
    for (const format of [[], ["--format", "json"]]) {
      assertRefused(
        run(dir, "--base", base, "--candidate", "no-such-revision-anywhere", "--no-fetch", ...format),
        "no-such-revision-anywhere",
      );
      assertRefused(
        run(dir, "--base", "no-such-base-anywhere", "--candidate", base, "--no-fetch", ...format),
        "no-such-base-anywhere",
      );
    }
  });

  test("an unknown --check name exits 2, stdout empty, the name given", () => {
    const { dir, base, candidate } = makeRepo();
    assertRefused(
      run(dir, "--base", base, "--candidate", candidate, "--check", "RT-no-such-check", "--format", "json", "--no-fetch"),
      "RT-no-such-check",
    );
  });

  test("an unknown option exits 2, stdout empty, the option named", () => {
    const { dir, base, candidate } = makeRepo();
    assertRefused(
      run(dir, "--base", base, "--candidate", candidate, "--no-such-option", "--format", "json", "--no-fetch"),
      "--no-such-option",
    );
  });

  test("cases ran, under the operating system's temporary directory", () => {
    assert.ok(ran > 0, "no case ran the built file");
    assert.ok(scratch.startsWith(tmpdir()), "repositories live under os.tmpdir()");
  });
});
