/**
 * End-to-end suite: runs the built `repo-truth` the way a user does - the file
 * package.json's `bin` names, as a child process, over throwaway git repositories.
 *
 *   npm run build && node --test test/e2e/cli.e2e.mjs
 *
 * Not collected by `npx vitest run`: the name matches no vitest pattern.
 */

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const MISSING_BUILD = "does not exist: the build step has not run - run `npm run build` first";

let scratch;
let names = [];
let counter = 0;
let ran = 0;

/** The names in the built REGISTRY, or a failure naming the build as the missing step. */
async function registered() {
  assert.ok(existsSync(BIN), "the built file " + BIN + " " + MISSING_BUILD);
  assert.ok(existsSync(REGISTRY_FILE), "the built registry " + REGISTRY_FILE + " " + MISSING_BUILD);
  if (names.length === 0) {
    const { REGISTRY } = await import(pathToFileURL(REGISTRY_FILE).href);
    names = REGISTRY.map((e) => e.name);
  }
  assert.ok(names.length > 0, "the built REGISTRY holds no check");
  return names;
}

/** Every case begins here: the build is checked, then a scratch directory exists. */
async function start() {
  const all = await registered();
  scratch ??= mkdtempSync(join(tmpdir(), "repo-truth-e2e-"));
  return all;
}

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

/**
 * A repository whose base commit holds `baseFiles` and whose candidate commit then
 * removes `removed` and writes `added` (a string or a Buffer per path).
 */
function makeRepoWith({ baseFiles = {}, added = {}, removed = [] }) {
  const dir = join(scratch, "repo-" + counter++);
  execFileSync("git", ["init", "--quiet", dir], { env: GIT_ENV });
  git(dir, "config", "user.name", "Test User");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  const put = (files) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
  };
  put({ "README.md": "# fixture\n", ...baseFiles });
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "initial commit");
  const base = git(dir, "rev-parse", "HEAD");
  for (const path of removed) rmSync(join(dir, path));
  put({ "notes.txt": "some notes\n", ...added });
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "change files");
  return { dir, base, candidate: git(dir, "rev-parse", "HEAD") };
}

const configText = (checks) => JSON.stringify({ schema: "repo-truth.config/v1", checks }) + "\n";
const BIG = "x".repeat(500) + "\n";

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

/** One JSON document and nothing else on stdout. */
function parseDocument(result) {
  assert.ok(result.stdout.endsWith("\n"), "stdout ends with a newline");
  return JSON.parse(result.stdout);
}

function assertRefused(result, mention) {
  assert.equal(result.code, 2, "exit code " + result.code + ": " + result.stderr);
  assert.equal(result.stdout, "");
  assert.ok(result.stderr.includes(mention), "stderr names " + JSON.stringify(mention) + ": " + result.stderr);
}

/** One check's run over a range, as the document and the record it names. */
function runCheck(cwd, repo, name, ...more) {
  const result = run(cwd, "--base", repo.base, "--candidate", repo.candidate, "--check", name, "--format", "json", ...more);
  const doc = parseDocument(result);
  assert.deepEqual(doc.records.map((r) => r.name), [name]);
  assertAgrees(doc, result);
  return { result, doc, record: doc.records[0] };
}

function assertRefusedWithoutUsage(result, mention) {
  assertRefused(result, mention);
  assert.ok(!/usage/i.test(result.stderr), "stderr holds no usage text: " + result.stderr);
}

after(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

describe("repo-truth check, built", () => {
  test("the bin field names a file that exists", async () => {
    await start();
    assert.ok(BIN.endsWith(".js"), BIN + " is a script");
  });

  test("a default run answers 0 or 1 with one record per registered check, in order", async () => {
    const all = await start();
    const { dir, base, candidate } = makeRepo();
    const result = run(dir, "--base", base, "--candidate", candidate, "--format", "json");
    assert.ok(result.code === 0 || result.code === 1, "exit code " + result.code + ": " + result.stderr);
    const doc = parseDocument(result);
    assert.deepEqual(doc.records.map((r) => r.name), all);
    assert.equal(doc.base, base);
    assert.equal(doc.candidate, candidate);
    assert.equal(doc.config, null);
    assertAgrees(doc, result);
  });

  test("a text run ends with a verdict line that agrees with the exit code", async () => {
    const all = await start();
    const { dir, base, candidate } = makeRepo();
    const result = run(dir, "--base", base, "--candidate", candidate);
    assert.ok(result.code === 0 || result.code === 1, "exit code " + result.code + ": " + result.stderr);
    const last = result.stdout.trimEnd().split("\n").pop();
    assert.equal(last, result.code === 0 ? "repo-truth: all checks passed" : "repo-truth: at least one check failed");
    for (const name of all) assert.ok(result.stdout.includes(name), name + " appears in the output");
  });

  test("each registered name given to --check runs that check alone", async () => {
    const all = await start();
    const { dir, base, candidate } = makeRepo();
    for (const name of all) {
      const result = run(dir, "--base", base, "--candidate", candidate, "--check", name, "--format", "json");
      assert.ok(result.code === 0 || result.code === 1, name + ": exit code " + result.code + ": " + result.stderr);
      const doc = parseDocument(result);
      assert.deepEqual(doc.records.map((r) => r.name), [name]);
      assertAgrees(doc, result);
    }
  });

  test("a commit message outside printable ASCII exits 1 with a fail record", async () => {
    const all = await start();
    const { dir, base, candidate } = makeRepo("add a file — with a dash and café");
    const result = run(dir, "--base", base, "--candidate", candidate, "--format", "json");
    assert.equal(result.code, 1, result.stderr);
    const doc = parseDocument(result);
    assert.ok(doc.records.some((r) => r.status === "fail"), "at least one fail record");
    assert.deepEqual(doc.records.map((r) => r.name), all);
    assertAgrees(doc, result);
  });

  test("a revision that names no commit exits 2, stdout empty, the revision named", async () => {
    await start();
    const { dir, base } = makeRepo();
    for (const format of [[], ["--format", "json"]]) {
      assertRefused(
        run(dir, "--base", base, "--candidate", "no-such-revision-anywhere", ...format),
        "no-such-revision-anywhere",
      );
      assertRefused(
        run(dir, "--base", "no-such-base-anywhere", "--candidate", base, ...format),
        "no-such-base-anywhere",
      );
    }
  });

  test("an unknown --check name exits 2, stdout empty, the name given", async () => {
    await start();
    const { dir, base, candidate } = makeRepo();
    for (const format of [[], ["--format", "json"]]) {
      assertRefused(
        run(dir, "--base", base, "--candidate", candidate, "--check", "RT-no-such-check", ...format),
        "RT-no-such-check",
      );
    }
  });

  test("an unknown option exits 2, stdout empty, the option named", async () => {
    await start();
    const { dir, base, candidate } = makeRepo();
    for (const format of [[], ["--format", "json"]]) {
      assertRefused(
        run(dir, "--base", base, "--candidate", candidate, "--no-such-option", ...format),
        "--no-such-option",
      );
    }
  });

  test("repo-truth.json at the base gives RT-57 its forbidden paths, and the document names the file", async () => {
    const all = await start();
    assert.ok(all.includes("RT-57"), "the built registry holds RT-57");
    const repo = makeRepoWith({
      baseFiles: { "repo-truth.json": configText({ "RT-57": { forbidden: ["secrets/**"] } }) },
      added: { "secrets/key.txt": "k\n" },
    });
    const { result, doc, record } = runCheck(repo.dir, repo, "RT-57");
    assert.equal(result.code, 1);
    assert.equal(record.status, "fail");
    assert.ok(record.evidence.some((e) => e.includes("secrets/key.txt")), record.evidence.join("\n"));
    assert.equal(doc.config, "repo-truth.json at " + repo.base.slice(0, 12));
  });

  test("RT-57 skips with no policy and passes a range its policy does not reach", async () => {
    const all = await start();
    assert.ok(all.includes("RT-57"), "the built registry holds RT-57");
    const bare = makeRepoWith({ added: { "secrets/key.txt": "k\n" } });
    const skipped = runCheck(bare.dir, bare, "RT-57");
    assert.equal(skipped.result.code, 0);
    assert.equal(skipped.record.status, "skip");
    const policed = makeRepoWith({
      baseFiles: { "repo-truth.json": configText({ "RT-57": { forbidden: ["secrets/**"] } }) },
      added: { "docs/key.txt": "k\n" },
    });
    const passed = runCheck(policed.dir, policed, "RT-57");
    assert.equal(passed.result.code, 0);
    assert.equal(passed.record.status, "pass");
  });

  test("RT-12 fails a file above the base's maxBytes and passes the same file with no repo-truth.json", async () => {
    const all = await start();
    assert.ok(all.includes("RT-12"), "the built registry holds RT-12");
    const limited = makeRepoWith({
      baseFiles: { "repo-truth.json": configText({ "RT-12": { maxBytes: 100 } }) },
      added: { "big.txt": BIG },
    });
    const failed = runCheck(limited.dir, limited, "RT-12");
    assert.equal(failed.result.code, 1);
    assert.equal(failed.record.status, "fail");
    assert.ok(failed.record.evidence.some((e) => e.includes("big.txt")), failed.record.evidence.join("\n"));
    const free = makeRepoWith({ added: { "big.txt": BIG } });
    const passed = runCheck(free.dir, free, "RT-12");
    assert.equal(passed.result.code, 0);
    assert.equal(passed.record.status, "pass");
    assert.equal(passed.doc.config, null);
  });

  test("a repo-truth.json that only the candidate holds or changes gives no option", async () => {
    const all = await start();
    assert.ok(all.includes("RT-12") && all.includes("RT-57"), "the built registry holds RT-12 and RT-57");
    const added = makeRepoWith({
      added: {
        "repo-truth.json": configText({ "RT-12": { maxBytes: 100 }, "RT-57": { forbidden: ["secrets/**"] } }),
        "big.txt": BIG,
        "secrets/key.txt": "k\n",
      },
    });
    for (const name of ["RT-12", "RT-57"]) {
      const { result, doc, record } = runCheck(added.dir, added, name);
      assert.equal(result.code, 0, name);
      assert.equal(record.status, name === "RT-57" ? "skip" : "pass", name);
      assert.equal(doc.config, null);
    }
    const changed = makeRepoWith({
      baseFiles: { "repo-truth.json": configText({ "RT-12": { maxBytes: 100000 } }) },
      added: { "repo-truth.json": configText({ "RT-12": { maxBytes: 100 } }), "big.txt": BIG },
    });
    const kept = runCheck(changed.dir, changed, "RT-12");
    assert.equal(kept.result.code, 0);
    assert.equal(kept.record.status, "pass");
    assert.equal(kept.doc.config, "repo-truth.json at " + changed.base.slice(0, 12));
    const loosened = makeRepoWith({
      baseFiles: { "repo-truth.json": configText({ "RT-12": { maxBytes: 100 } }) },
      added: { "repo-truth.json": configText({ "RT-12": { maxBytes: 100000 } }), "big.txt": BIG },
    });
    const strict = runCheck(loosened.dir, loosened, "RT-12");
    assert.equal(strict.result.code, 1);
    assert.equal(strict.record.status, "fail");
  });

  test("--config reads that file in place of the base's, by absolute and by relative path", async () => {
    const all = await start();
    assert.ok(all.includes("RT-12"), "the built registry holds RT-12");
    const repo = makeRepoWith({
      baseFiles: { "repo-truth.json": configText({ "RT-12": { maxBytes: 100000 } }) },
      added: { "big.txt": BIG },
    });
    const tight = configText({ "RT-12": { maxBytes: 100 } });
    assert.equal(runCheck(repo.dir, repo, "RT-12").record.status, "pass");

    const absolute = join(scratch, "absolute-config-" + counter++ + ".json");
    writeFileSync(absolute, tight);
    const byAbsolute = runCheck(repo.dir, repo, "RT-12", "--config", absolute);
    assert.equal(byAbsolute.result.code, 1);
    assert.equal(byAbsolute.record.status, "fail");
    assert.equal(byAbsolute.doc.config, absolute);

    writeFileSync(join(repo.dir, "alt-config.json"), tight);
    const byRelative = runCheck(repo.dir, repo, "RT-12", "--config", "alt-config.json");
    assert.equal(byRelative.result.code, 1);
    assert.equal(byRelative.record.status, "fail");
    assert.equal(byRelative.doc.config, "alt-config.json");
  });

  test("with no repo-truth.json a default run's document has config null", async () => {
    await start();
    const { dir, base, candidate } = makeRepo();
    const result = run(dir, "--base", base, "--candidate", candidate, "--format", "json");
    assert.ok(result.code === 0 || result.code === 1, result.stderr);
    assert.equal(parseDocument(result).config, null);
  });

  test("a configuration the command refuses exits 2, stdout empty, the problem named, no usage text", async () => {
    const all = await start();
    assert.ok(all.includes("RT-12"), "the built registry holds RT-12");
    const wrongKind = makeRepoWith({ baseFiles: { "repo-truth.json": configText({ "RT-12": { maxBytes: "big" } }) } });
    const unknownCheck = makeRepoWith({ baseFiles: { "repo-truth.json": configText({ "RT-no-such-check": { a: 1 } }) } });
    const clean = makeRepoWith({});
    const missing = join(scratch, "no-such-config-" + counter++ + ".json");
    const cases = [
      [wrongKind, [], "checks.RT-12.maxBytes"],
      [unknownCheck, [], "RT-no-such-check"],
      [clean, ["--config", missing], missing],
    ];
    for (const [repo, extra, mention] of cases) {
      for (const format of [[], ["--format", "json"]]) {
        const result = run(repo.dir, "--base", repo.base, "--candidate", repo.candidate, ...format, ...extra);
        assertRefusedWithoutUsage(result, mention);
      }
    }
  });

  test("RT-55 fails a binary file the range adds and passes a text one", async () => {
    const all = await start();
    assert.ok(all.includes("RT-55"), "the built registry holds RT-55");
    const binary = makeRepoWith({ added: { "assets/blob.bin": Buffer.from([1, 2, 0, 3, 4]) } });
    const failed = runCheck(binary.dir, binary, "RT-55");
    assert.equal(failed.result.code, 1);
    assert.equal(failed.record.status, "fail");
    assert.ok(failed.record.evidence.some((e) => e.includes("assets/blob.bin")), failed.record.evidence.join("\n"));
    const text = makeRepoWith({ added: { "assets/words.txt": "plain words\n" } });
    const passed = runCheck(text.dir, text, "RT-55");
    assert.equal(passed.result.code, 0);
    assert.equal(passed.record.status, "pass");
  });

  test("RT-56 fails a workflow the range deletes and passes a range that leaves it alone", async () => {
    const all = await start();
    assert.ok(all.includes("RT-56"), "the built registry holds RT-56");
    const workflow = ".github/workflows/ci.yml";
    const files = { [workflow]: "name: ci\non: push\njobs: {}\n" };
    const deleted = makeRepoWith({ baseFiles: files, removed: [workflow] });
    const failed = runCheck(deleted.dir, deleted, "RT-56");
    assert.equal(failed.result.code, 1);
    assert.equal(failed.record.status, "fail");
    assert.ok(failed.record.evidence.some((e) => e.includes(workflow)), failed.record.evidence.join("\n"));
    const kept = makeRepoWith({ baseFiles: files });
    const passed = runCheck(kept.dir, kept, "RT-56");
    assert.equal(passed.result.code, 0);
    assert.equal(passed.record.status, "pass");
  });

  /** RT-66 over a range: the exit code, the record's status and its evidence lines, exactly. */
  function assertRt66(repo, code, status, evidence, ...more) {
    const { result, record } = runCheck(repo.dir, repo, "RT-66", ...more);
    assert.equal(result.code, code, result.stderr + result.stdout);
    assert.equal(record.status, status);
    assert.deepEqual(record.evidence, evidence);
  }

  const baseConfig = configText({ "RT-12": { maxBytes: 100000 } });
  const otherConfig = configText({ "RT-12": { maxBytes: 200000 } });

  test("RT-66 fails a range that changes repo-truth.json, and one that adds, deletes or renames it", async () => {
    const all = await start();
    assert.ok(all.includes("RT-66"), "the built registry holds RT-66");
    const changed = makeRepoWith({
      baseFiles: { "repo-truth.json": baseConfig },
      added: { "repo-truth.json": otherConfig },
    });
    assertRt66(changed, 1, "fail", ["repo-truth.json: config-changed"]);
    const added = makeRepoWith({ added: { "repo-truth.json": baseConfig } });
    assertRt66(added, 1, "fail", ["repo-truth.json: config-added"]);
    const deleted = makeRepoWith({ baseFiles: { "repo-truth.json": baseConfig }, removed: ["repo-truth.json"] });
    assertRt66(deleted, 1, "fail", ["repo-truth.json: config-deleted"]);
    const renamed = makeRepoWith({
      baseFiles: { "repo-truth.json": baseConfig },
      removed: ["repo-truth.json"],
      added: { "moved-config.json": baseConfig },
    });
    assertRt66(renamed, 1, "fail", ["repo-truth.json: config-renamed (other path: moved-config.json)"]);
  });

  test("RT-66 watches the file --config names inside the repository, not repo-truth.json", async () => {
    const all = await start();
    assert.ok(all.includes("RT-66"), "the built registry holds RT-66");
    const changed = makeRepoWith({
      baseFiles: { "alt-config.json": baseConfig, "repo-truth.json": baseConfig },
      added: { "alt-config.json": otherConfig },
    });
    assertRt66(changed, 1, "fail", ["alt-config.json: config-changed"], "--config", "alt-config.json");
    const other = makeRepoWith({
      baseFiles: { "alt-config.json": baseConfig, "repo-truth.json": baseConfig },
      added: { "repo-truth.json": otherConfig },
    });
    assertRt66(other, 0, "pass", ["alt-config.json: not added, changed, deleted or renamed"], "--config", "alt-config.json");
  });

  test("RT-66 skips a --config file outside the repository", async () => {
    const all = await start();
    assert.ok(all.includes("RT-66"), "the built registry holds RT-66");
    const repo = makeRepoWith({
      baseFiles: { "repo-truth.json": baseConfig },
      added: { "repo-truth.json": otherConfig },
    });
    const outside = join(scratch, "outside-config-" + counter++ + ".json");
    writeFileSync(outside, baseConfig);
    assertRt66(repo, 0, "skip", [outside + ": outside the repository, no range can change it"], "--config", outside);
  });

  test("RT-66 passes a change a Sanctioned-Weakening line of the range sanctions, and only that one", async () => {
    const all = await start();
    assert.ok(all.includes("RT-66"), "the built registry holds RT-66");
    const sanctioned = makeRepoWith({
      baseFiles: { "repo-truth.json": baseConfig },
      added: { "repo-truth.json": otherConfig },
    });
    git(sanctioned.dir, "commit", "--quiet", "--amend", "-m",
      "change files\n\nSanctioned-Weakening: config-changed:repo-truth.json the limit moves with the new fixtures");
    sanctioned.candidate = git(sanctioned.dir, "rev-parse", "HEAD");
    assertRt66(sanctioned, 0, "pass", [
      "repo-truth.json: config-changed - sanctioned: the limit moves with the new fixtures",
    ]);
    const wrong = makeRepoWith({
      baseFiles: { "repo-truth.json": baseConfig },
      added: { "repo-truth.json": otherConfig },
    });
    git(wrong.dir, "commit", "--quiet", "--amend", "-m",
      "change files\n\nSanctioned-Weakening: config-added:repo-truth.json not this category");
    wrong.candidate = git(wrong.dir, "rev-parse", "HEAD");
    assertRt66(wrong, 1, "fail", ["repo-truth.json: config-changed"]);
  });

  test("RT-66 passes a range that leaves repo-truth.json alone", async () => {
    const all = await start();
    assert.ok(all.includes("RT-66"), "the built registry holds RT-66");
    const present = makeRepoWith({ baseFiles: { "repo-truth.json": baseConfig } });
    assertRt66(present, 0, "pass", ["repo-truth.json: not added, changed, deleted or renamed"]);
    const absent = makeRepoWith({});
    assertRt66(absent, 0, "pass", ["repo-truth.json: not added, changed, deleted or renamed"]);
  });

  /** The subdirectory of a throwaway repository the cases below run the command in. */
  const SUB = "pkg/inner";
  const subKeep = { [SUB + "/keep.txt"]: "kept\n" };

  /** One check run with the repository's subdirectory as the working directory. */
  function runInSub(repo, name, ...more) {
    const cwd = join(repo.dir, SUB);
    assert.ok(existsSync(cwd), "the subdirectory exists in the repository");
    return runCheck(cwd, repo, name, ...more);
  }

  function assertRt66InSub(repo, code, status, evidence, ...more) {
    const { result, record } = runInSub(repo, "RT-66", ...more);
    assert.equal(result.code, code, result.stderr + result.stdout);
    assert.equal(record.status, status);
    assert.deepEqual(record.evidence, evidence);
  }

  test("in a subdirectory, the top directory's repo-truth.json is read and named", async () => {
    const all = await start();
    assert.ok(all.includes("RT-12"), "the built registry holds RT-12");
    const repo = makeRepoWith({
      baseFiles: { ...subKeep, "repo-truth.json": configText({ "RT-12": { maxBytes: 100 } }) },
      added: { "big.txt": BIG },
    });
    const { result, doc, record } = runInSub(repo, "RT-12");
    assert.equal(result.code, 1, result.stderr);
    assert.equal(record.status, "fail");
    assert.equal(doc.config, "repo-truth.json at " + repo.base.slice(0, 12));
  });

  test("in a subdirectory, a repo-truth.json of the subdirectory alone is not read", async () => {
    const all = await start();
    assert.ok(all.includes("RT-12"), "the built registry holds RT-12");
    const repo = makeRepoWith({
      baseFiles: { ...subKeep, [SUB + "/repo-truth.json"]: configText({ "RT-12": { maxBytes: 100 } }) },
      added: { "big.txt": BIG },
    });
    const { result, doc, record } = runInSub(repo, "RT-12");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(record.status, "pass");
    assert.equal(doc.config, null);
  });

  test("in a subdirectory, a relative --config is read against the subdirectory", async () => {
    const all = await start();
    assert.ok(all.includes("RT-12"), "the built registry holds RT-12");
    const repo = makeRepoWith({
      baseFiles: {
        ...subKeep,
        "repo-truth.json": configText({ "RT-12": { maxBytes: 100000 } }),
        [SUB + "/repo-truth.json"]: configText({ "RT-12": { maxBytes: 100 } }),
      },
      added: { "big.txt": BIG },
    });
    const { result, doc, record } = runInSub(repo, "RT-12", "--config", "repo-truth.json");
    assert.equal(result.code, 1, result.stderr);
    assert.equal(record.status, "fail");
    assert.equal(doc.config, "repo-truth.json");
  });

  test("in a subdirectory, RT-66 with no --config watches the top directory's repo-truth.json", async () => {
    const all = await start();
    assert.ok(all.includes("RT-66"), "the built registry holds RT-66");
    const baseFiles = {
      ...subKeep,
      "repo-truth.json": baseConfig,
      [SUB + "/repo-truth.json"]: baseConfig,
    };
    const top = makeRepoWith({ baseFiles, added: { "repo-truth.json": otherConfig } });
    assertRt66InSub(top, 1, "fail", ["repo-truth.json: config-changed"]);
    const sub = makeRepoWith({ baseFiles, added: { [SUB + "/repo-truth.json"]: otherConfig } });
    assertRt66InSub(sub, 0, "pass", ["repo-truth.json: not added, changed, deleted or renamed"]);
  });

  test("in a subdirectory, RT-66 with a relative --config watches the subdirectory's file", async () => {
    const all = await start();
    assert.ok(all.includes("RT-66"), "the built registry holds RT-66");
    const repo = makeRepoWith({
      baseFiles: {
        ...subKeep,
        "repo-truth.json": baseConfig,
        [SUB + "/repo-truth.json"]: baseConfig,
      },
      added: { [SUB + "/repo-truth.json"]: otherConfig },
    });
    assertRt66InSub(repo, 1, "fail", [SUB + "/repo-truth.json: config-changed"], "--config", "repo-truth.json");
  });

  test("cases ran, under the operating system's temporary directory", async () => {
    await start();
    assert.ok(ran > 0, "no case ran the built file");
    assert.ok(scratch.startsWith(tmpdir()), "repositories live under os.tmpdir()");
  });
});
