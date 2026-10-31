import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  actionArguments,
  assertPullRequestEvent,
  jobSummary,
  RangeResolutionError,
  resolveMergeBase,
  runAction,
} from "../../src/action.js";
import { EXIT_BAD_INVOCATION, EXIT_CHECK_FAILED, EXIT_OK, main } from "../../src/cli.js";
import type { CheckRecord } from "../../src/index.js";
import { REGISTRY, type RegistryEntry } from "../../src/registry.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(cwd: string, file: string, content: string, message: string): string {
  writeFileSync(join(cwd, file), content);
  git(cwd, "add", "-A");
  git(cwd, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

const ident = ["-c", "user.name=T", "-c", "user.email=t@example.com"];

async function run(argv: string[], cwd: string, env: Record<string, string | undefined> = {}) {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    cwd,
    env,
    stdout: (t) => void (stdout += t),
    stderr: (t) => void (stderr += t),
  });
  return { code, stdout, stderr };
}

const stub = (name: string, status: CheckRecord["status"], calls?: string[]): RegistryEntry => ({
  name,
  run: () => {
    calls?.push(name);
    return { name, status, evidence: [`${name} says ${status}`] };
  },
});

function useRegistry(...entries: RegistryEntry[]): void {
  REGISTRY.splice(0, REGISTRY.length, ...entries);
}

const original = [...REGISTRY];
let root: string;
let counter = 0;

function newRepo(): string {
  const dir = join(root, `repo-${counter++}`);
  git(root, "init", "-q", "-b", "main", dir);
  return dir;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "repo-truth-action-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => {
  REGISTRY.splice(0, REGISTRY.length, ...original);
});

describe("resolveMergeBase", () => {
  it("is the fork point when the target branch has moved, not the target's tip", async () => {
    const repo = newRepo();
    const fork = commit(repo, "a.txt", "1\n", "fork");
    git(repo, "checkout", "-q", "-b", "feature");
    const head = commit(repo, "f.txt", "f\n", "feature work");
    git(repo, "checkout", "-q", "main");
    const tip = commit(repo, "m.txt", "m\n", "target moved");
    const base = await resolveMergeBase(repo, "main", head);
    expect(base).toBe(fork);
    expect(base).not.toBe(tip);
    expect(base).toBe(git(repo, "merge-base", "main", head));
  });

  it("after a rebase, is the new tip of the target and excludes the target's commits", async () => {
    const repo = newRepo();
    commit(repo, "a.txt", "1\n", "fork");
    git(repo, "checkout", "-q", "-b", "feature");
    commit(repo, "f.txt", "f\n", "feature work");
    git(repo, "checkout", "-q", "main");
    const tip = commit(repo, "m.txt", "m\n", "target moved");
    git(repo, "checkout", "-q", "feature");
    git(repo, ...ident, "rebase", "-q", "main");
    const head = git(repo, "rev-parse", "HEAD");
    const base = await resolveMergeBase(repo, "main", head);
    expect(base).toBe(tip);
    expect(git(repo, "rev-list", `${base}..${head}`).split("\n")).toHaveLength(1);
  });

  it("with a merge commit on the target, is the latest common ancestor", async () => {
    const repo = newRepo();
    commit(repo, "a.txt", "1\n", "fork");
    git(repo, "checkout", "-q", "-b", "feature");
    const head = commit(repo, "f.txt", "f\n", "feature work");
    git(repo, "checkout", "-q", "main");
    commit(repo, "m.txt", "m\n", "target moved");
    git(repo, ...ident, "merge", "-q", "--no-ff", "-m", "merge feature", "feature");
    const merged = commit(repo, "n.txt", "n\n", "after merge");
    // The target now contains the feature head; the merge base is that head.
    expect(await resolveMergeBase(repo, "main", head)).toBe(head);
    // A second branch cut after the merge forks from the merge-containing tip.
    git(repo, "checkout", "-q", "-b", "next");
    const next = commit(repo, "x.txt", "x\n", "next");
    expect(await resolveMergeBase(repo, "main", next)).toBe(merged);
  });

  it("fails naming the missing history and fetch-depth: 0 on a shallow checkout", async () => {
    const origin = newRepo();
    commit(origin, "a.txt", "1\n", "fork");
    git(origin, "checkout", "-q", "-b", "feature");
    commit(origin, "f1.txt", "f\n", "feature 1");
    commit(origin, "f2.txt", "f\n", "feature 2");
    git(origin, "checkout", "-q", "main");
    commit(origin, "m1.txt", "m\n", "main 1");
    commit(origin, "m2.txt", "m\n", "main 2");
    const clone = join(root, `clone-${counter++}`);
    git(root, "clone", "-q", "--depth", "1", "--no-single-branch", pathToFileURL(origin).href, clone);
    git(clone, "fetch", "-q", "--depth", "1", "origin", "feature");
    expect(git(clone, "rev-parse", "--is-shallow-repository")).toBe("true");
    const head = git(clone, "rev-parse", "FETCH_HEAD");
    const error = await resolveMergeBase(clone, "origin/main", head).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RangeResolutionError);
    expect((error as Error).message).toMatch(/merge base/);
    expect((error as Error).message).toMatch(/missing/);
    expect((error as Error).message).toContain("fetch-depth: 0");
  });
});

describe("assertPullRequestEvent", () => {
  it("allows pull request events and an unset name, refuses the rest naming the event", () => {
    expect(() => assertPullRequestEvent(undefined)).not.toThrow();
    expect(() => assertPullRequestEvent("pull_request")).not.toThrow();
    expect(() => assertPullRequestEvent("pull_request_target")).not.toThrow();
    expect(() => assertPullRequestEvent("push")).toThrow(/push/);
  });
});

describe("repo-truth check --target", () => {
  let repo: string;
  let fork: string;
  let head: string;

  beforeAll(() => {
    repo = newRepo();
    fork = commit(repo, "a.txt", "1\n", "fork");
    git(repo, "checkout", "-q", "-b", "feature");
    head = commit(repo, "f.txt", "f\n", "feature work");
    git(repo, "checkout", "-q", "main");
    commit(repo, "m.txt", "m\n", "target moved");
  });

  const args = (...more: string[]) => ["check", "--no-fetch", "--format", "json", ...more];

  it("answers with the merge base as `base`, and exits 0 on passing checks", async () => {
    useRegistry(stub("A", "pass"));
    const r = await run(args("--target", "main", "--candidate", head), repo);
    expect(r.code).toBe(EXIT_OK);
    const doc = JSON.parse(r.stdout);
    expect(doc.base).toBe(fork);
    expect(doc.candidate).toBe(head);
  });

  it("exits 1 with the document when a check fails or throws", async () => {
    useRegistry(stub("A", "fail"));
    let r = await run(args("--target", "main", "--candidate", head), repo);
    expect(r.code).toBe(EXIT_CHECK_FAILED);
    expect(JSON.parse(r.stdout).ok).toBe(false);
    useRegistry({
      name: "T",
      run: () => {
        throw new Error("boom");
      },
    });
    r = await run(args("--target", "main", "--candidate", head), repo);
    expect(r.code).toBe(EXIT_CHECK_FAILED);
    expect(JSON.parse(r.stdout).records[0].evidence[0]).toContain("boom");
  });

  it("exits 2 with nothing on stdout for --base with --target, neither, or an unknown target", async () => {
    const calls: string[] = [];
    useRegistry(stub("A", "pass", calls));
    for (const argv of [
      args("--base", fork, "--target", "main", "--candidate", head),
      args("--candidate", head),
      args("--target", "no-such-branch", "--candidate", head),
    ]) {
      const r = await run(argv, repo);
      expect(r.code).toBe(EXIT_BAD_INVOCATION);
      expect(r.stdout).toBe("");
    }
    expect(calls).toEqual([]);
  });

  it("exits 2, runs nothing and names the event for a non-pull-request event", async () => {
    const calls: string[] = [];
    useRegistry(stub("A", "pass", calls));
    const r = await run(args("--target", "main", "--candidate", head), repo, { GITHUB_EVENT_NAME: "push" });
    expect(r.code).toBe(EXIT_BAD_INVOCATION);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("push");
    expect(calls).toEqual([]);
  });

  it("works for pull_request events, and --base ignores the event", async () => {
    useRegistry(stub("A", "pass"));
    let r = await run(args("--target", "main", "--candidate", head), repo, { GITHUB_EVENT_NAME: "pull_request" });
    expect(r.code).toBe(EXIT_OK);
    r = await run(args("--base", fork, "--candidate", head), repo, { GITHUB_EVENT_NAME: "push" });
    expect(r.code).toBe(EXIT_OK);
  });

  it("exits 2 with nothing on stdout and no check run when the merge base is missing", async () => {
    const calls: string[] = [];
    useRegistry(stub("A", "pass", calls));
    const origin = repo;
    const clone = join(root, `clone-${counter++}`);
    git(root, "clone", "-q", "--depth", "1", "--no-single-branch", pathToFileURL(origin).href, clone);
    const r = await run(args("--target", "origin/main", "--candidate", "origin/feature"), clone);
    expect(r.code).toBe(EXIT_BAD_INVOCATION);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/merge base/);
    expect(r.stderr).toContain("fetch-depth: 0");
    expect(calls).toEqual([]);
  });
});

describe("action.yml", () => {
  const text = readFileSync(join(__dirname, "..", "..", "action.yml"), "utf8");

  it("is a composite action that calls the command with --target and --candidate", () => {
    expect(text).toMatch(/using:\s*composite/);
    expect(text).toContain('exec node "$REPO_TRUTH_BIN" check');
    expect(text).toContain("--candidate");
    expect(text).toContain("github.event.pull_request.head.sha");
    expect(text).toContain("origin/${{ github.event.pull_request.base.ref }}");
  });

  it("declares the two inputs with their defaults", () => {
    const inputs = text.slice(text.indexOf("\ninputs:"), text.indexOf("\nruns:"));
    const checks = inputs.slice(inputs.indexOf("  checks:"), inputs.indexOf("  format:"));
    const format = inputs.slice(inputs.indexOf("  format:"));
    expect(checks).toMatch(/white space or commas/);
    expect(checks).toContain("--check <name>");
    expect(checks).toMatch(/Empty runs every registered check/);
    expect(checks).toMatch(/required: false/);
    expect(checks).toMatch(/default: ""/);
    expect(format).toContain("text");
    expect(format).toContain("json");
    expect(format).toMatch(/required: false/);
    expect(format).toMatch(/default: "text"/);
  });

  it("hands each input to the step through one env entry and never into a script", () => {
    expect(text).toMatch(/^ {8}REPO_TRUTH_CHECKS: \$\{\{ inputs\.checks \}\}$/m);
    expect(text).toMatch(/^ {8}REPO_TRUTH_FORMAT: \$\{\{ inputs\.format \}\}$/m);
    for (const line of text.split("\n").filter((l) => /^\s+run:/.test(l))) expect(line).not.toContain("${{");
    const script = text.slice(text.indexOf("run: |"));
    expect(script).toContain('exec node "$REPO_TRUTH_BIN" check');
    expect(script).not.toContain("REPO_TRUTH_CHECKS");
    expect(script).not.toContain("REPO_TRUTH_FORMAT");
    expect(text).toContain("/dist/action.js");
    expect(text).toContain("npm ci && npm run build");
  });
});

describe("actionArguments", () => {
  const base = ["check", "--target", "origin/main", "--candidate", "abc"];

  it("is argv as given with no input, and a new array", () => {
    const out = actionArguments(base, {});
    expect(out).toEqual(base);
    expect(out).not.toBe(base);
    expect(actionArguments(base, { REPO_TRUTH_CHECKS: "", REPO_TRUTH_FORMAT: "" })).toEqual(base);
  });

  it("passes one name as one --check", () => {
    expect(actionArguments(base, { REPO_TRUTH_CHECKS: "A" })).toEqual([...base, "--check", "A"]);
  });

  it("splits at spaces, commas, tabs and newlines, dropping empty names, in order", () => {
    expect(actionArguments(base, { REPO_TRUTH_CHECKS: "A B" })).toEqual([...base, "--check", "A", "--check", "B"]);
    expect(actionArguments(base, { REPO_TRUTH_CHECKS: " A,,B ,\tC\nD\r\n,E " })).toEqual([
      ...base,
      ...["A", "B", "C", "D", "E"].flatMap((n) => ["--check", n]),
    ]);
  });

  it("leaves shell characters as one argument each", () => {
    expect(actionArguments([], { REPO_TRUTH_CHECKS: "$(id);x `id` 'q' *" })).toEqual([
      "--check",
      "$(id);x",
      "--check",
      "`id`",
      "--check",
      "'q'",
      "--check",
      "*",
    ]);
  });

  it("passes a format when set and not empty, any value as written", () => {
    expect(actionArguments(base, { REPO_TRUTH_FORMAT: "json" })).toEqual([...base, "--format", "json"]);
    expect(actionArguments(base, { REPO_TRUTH_FORMAT: "yaml" })).toEqual([...base, "--format", "yaml"]);
    expect(actionArguments(base, { REPO_TRUTH_CHECKS: "A", REPO_TRUTH_FORMAT: "text" })).toEqual([
      ...base,
      "--check",
      "A",
      "--format",
      "text",
    ]);
  });

  it("passes no --config when the config is empty or unset", () => {
    expect(actionArguments(base, { REPO_TRUTH_CONFIG: "" })).toEqual(base);
    expect(actionArguments(base, { REPO_TRUTH_CONFIG: undefined })).toEqual(base);
  });

  it("passes a path as --config after the checks and the format", () => {
    expect(actionArguments(base, { REPO_TRUTH_CONFIG: "c.json" })).toEqual([...base, "--config", "c.json"]);
    expect(actionArguments(base, { REPO_TRUTH_CONFIG: "c.json", REPO_TRUTH_FORMAT: "json", REPO_TRUTH_CHECKS: "A" })).toEqual([
      ...base,
      "--check",
      "A",
      "--format",
      "json",
      "--config",
      "c.json",
    ]);
  });

  it("keeps a path holding a space and shell characters as one argument", () => {
    const path = "my dir/$(id);`id` 'q' \"d\" *.json";
    expect(actionArguments(base, { REPO_TRUTH_CONFIG: path })).toEqual([...base, "--config", path]);
  });
});

describe("the base input", () => {
  const text = readFileSync(join(__dirname, "..", "..", "action.yml"), "utf8");
  const inputs = text.slice(text.indexOf("\ninputs:"), text.indexOf("\nruns:"));
  const input = inputs.slice(inputs.indexOf("  base:"));
  const argv = ["check"];

  it("is declared optional, empty by default, naming --base and --candidate", () => {
    expect(input).toMatch(/required: false/);
    expect(input).toMatch(/default: ""/);
    expect(input).toContain("--base");
    expect(input).toContain("--candidate");
    expect(input).toMatch(/Empty keeps the pull request's range/);
  });

  it("reaches the step through one env entry, and the script passes no range", () => {
    expect(text.match(/REPO_TRUTH_BASE/g)).toHaveLength(1);
    expect(text).toMatch(/^ {8}REPO_TRUTH_BASE: \$\{\{ inputs\.base \}\}$/m);
    expect(text).not.toContain("--target");
    expect(text).toMatch(/^ {8}exec node "\$REPO_TRUTH_BIN" check$/m);
  });

  it("passes --base and the commit of the run, whatever the target and candidate hold", () => {
    const env = { REPO_TRUTH_BASE: "abc", GITHUB_SHA: "def", REPO_TRUTH_TARGET: "origin/", REPO_TRUTH_CANDIDATE: "" };
    expect(actionArguments(argv, env)).toEqual(["check", "--base", "abc", "--candidate", "def"]);
    expect(actionArguments(argv, { ...env, REPO_TRUTH_EXCEPT: "A", REPO_TRUTH_FORMAT: "json", REPO_TRUTH_CONFIG: "c" })).toEqual([
      "check", "--base", "abc", "--candidate", "def", "--except", "A", "--format", "json", "--config", "c",
    ]);
  });

  it("falls back to HEAD when GITHUB_SHA is unset or empty", () => {
    const want = ["check", "--base", "abc", "--candidate", "HEAD"];
    expect(actionArguments(argv, { REPO_TRUTH_BASE: "abc" })).toEqual(want);
    expect(actionArguments(argv, { REPO_TRUTH_BASE: "abc", GITHUB_SHA: "" })).toEqual(want);
  });

  it("keeps shell characters as one argument", () => {
    expect(actionArguments(argv, { REPO_TRUTH_BASE: "$(id);`x` *", GITHUB_SHA: "'q' $y" })).toEqual([
      "check", "--base", "$(id);`x` *", "--candidate", "'q' $y",
    ]);
  });

  it("keeps the pull request's range when empty or unset", () => {
    expect(actionArguments(argv, { REPO_TRUTH_BASE: "", REPO_TRUTH_TARGET: "origin/main", REPO_TRUTH_CANDIDATE: "f00" })).toEqual([
      "check", "--target", "origin/main", "--candidate", "f00",
    ]);
    expect(actionArguments(argv, { REPO_TRUTH_TARGET: "origin/", GITHUB_SHA: "d" })).toEqual([
      "check", "--target", "origin/", "--candidate", "",
    ]);
    expect(actionArguments(argv, { REPO_TRUTH_BASE: "", GITHUB_SHA: "d" })).toEqual(["check"]);
  });

  describe("through runAction on a push event", () => {
    let repo: string;
    let before: string;
    let sha: string;

    beforeAll(() => {
      repo = newRepo();
      before = commit(repo, "a.txt", "1\n", "before");
      sha = commit(repo, "b.txt", "2\n", "push");
    });

    const act = async (env: Record<string, string | undefined>) => {
      let stdout = "";
      let stderr = "";
      const full = { GITHUB_EVENT_NAME: "push", REPO_TRUTH_TARGET: "origin/", REPO_TRUTH_CANDIDATE: "", ...env };
      const code = await runAction(["check", "--no-fetch", "--format", "json"], full, {
        cwd: repo,
        env: full,
        stdout: (t) => void (stdout += t),
        stderr: (t) => void (stderr += t),
      });
      return { code, stdout, stderr };
    };

    it("runs the checks over exactly base..GITHUB_SHA", async () => {
      useRegistry(stub("A", "pass"));
      const r = await act({ REPO_TRUTH_BASE: before, GITHUB_SHA: sha });
      expect(r.code).toBe(EXIT_OK);
      const doc = JSON.parse(r.stdout);
      expect(doc.base).toBe(before);
      expect(doc.candidate).toBe(sha);
    });

    it("is exit 2 with a summary saying the checks did not run when base is empty", async () => {
      const calls: string[] = [];
      useRegistry(stub("A", "pass", calls));
      const file = join(root, `base-summary-${counter++}.md`);
      const r = await act({ REPO_TRUTH_BASE: "", GITHUB_SHA: sha, GITHUB_STEP_SUMMARY: file });
      expect(r.code).toBe(EXIT_BAD_INVOCATION);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("push");
      expect(readFileSync(file, "utf8")).toContain("The checks did not run (exit code 2).");
      expect(calls).toEqual([]);
    });

    it("is exit 2 naming a base that names no commit", async () => {
      useRegistry(stub("A", "pass"));
      const r = await act({ REPO_TRUTH_BASE: "no-such-revision", GITHUB_SHA: sha });
      expect(r.code).toBe(EXIT_BAD_INVOCATION);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("no-such-revision");
    });
  });
});

describe("action.yml config input", () => {
  const text = readFileSync(join(__dirname, "..", "..", "action.yml"), "utf8");
  const inputs = text.slice(text.indexOf("\ninputs:"), text.indexOf("\nruns:"));
  const config = inputs.slice(inputs.indexOf("  config:"));

  it("is optional, empty by default, and states what it does and its limit", () => {
    expect(inputs.indexOf("  config:")).toBeGreaterThan(inputs.indexOf("  format:"));
    expect(config).toMatch(/required: false/);
    expect(config).toMatch(/default: ""/);
    expect(config).toContain("--config");
    expect(config).toContain("repo-truth.json");
    expect(config).toContain("checked-out tree");
    expect(config).toContain("merge base");
  });

  it("reaches the step through one env entry and no script names it", () => {
    expect(text.match(/REPO_TRUTH_CONFIG/g)).toHaveLength(1);
    expect(text).toMatch(/^ {8}REPO_TRUTH_CONFIG: \$\{\{ inputs\.config \}\}$/m);
    expect(text.match(/inputs\.config/g)).toHaveLength(1);
    expect(text.slice(text.indexOf("run: |"))).not.toContain("CONFIG");
  });
});

describe("main with actionArguments", () => {
  let repo: string;
  let head: string;

  beforeAll(() => {
    repo = newRepo();
    commit(repo, "a.txt", "1\n", "fork");
    git(repo, "checkout", "-q", "-b", "feature");
    head = commit(repo, "f.txt", "f\n", "feature work");
    git(repo, "checkout", "-q", "main");
  });

  const argv = () => ["check", "--no-fetch", "--target", "main", "--candidate", head];

  it("runs only the named checks and prints the json document", async () => {
    const calls: string[] = [];
    useRegistry(stub("A", "pass", calls), stub("B", "pass", calls), stub("C", "pass", calls));
    const r = await run(actionArguments(argv(), { REPO_TRUTH_CHECKS: "C, A", REPO_TRUTH_FORMAT: "json" }), repo);
    expect(r.code).toBe(EXIT_OK);
    expect(calls.sort()).toEqual(["A", "C"]);
    expect(JSON.parse(r.stdout).records.map((x: CheckRecord) => x.name).sort()).toEqual(["A", "C"]);
  });

  it("runs every check when checks is empty", async () => {
    const calls: string[] = [];
    useRegistry(stub("A", "pass", calls), stub("B", "pass", calls));
    const r = await run(actionArguments(argv(), { REPO_TRUTH_CHECKS: "", REPO_TRUTH_FORMAT: "text" }), repo);
    expect(r.code).toBe(EXIT_OK);
    expect(calls.sort()).toEqual(["A", "B"]);
  });

  it("refuses an unknown name or format with nothing on stdout", async () => {
    const calls: string[] = [];
    useRegistry(stub("A", "pass", calls));
    for (const env of [{ REPO_TRUTH_CHECKS: "$(id)" }, { REPO_TRUTH_FORMAT: "yaml" }]) {
      const r = await run(actionArguments(argv(), env), repo);
      expect(r.code).toBe(EXIT_BAD_INVOCATION);
      expect(r.stdout).toBe("");
    }
    expect(calls).toEqual([]);
  });

  describe("with the config input", () => {
    const seen: unknown[][] = [];
    const recorder: RegistryEntry = {
      name: "REC",
      options: { limit: "integer" },
      run: (...given) => {
        seen.push(given.slice(2));
        return { name: "REC", status: "pass", evidence: [] };
      },
    };
    const settings = (limit: number) =>
      JSON.stringify({ schema: "repo-truth.config/v1", checks: { REC: { limit } } });

    it("hands the options of the file it names, and the document's config is that path", async () => {
      useRegistry(recorder);
      const dir = join(root, "config with $(spaces)");
      mkdirSync(dir);
      const file = join(dir, "other; one.json");
      writeFileSync(file, settings(7));
      seen.length = 0;
      const env = { REPO_TRUTH_FORMAT: "json", REPO_TRUTH_CONFIG: file };
      const r = await run(actionArguments(argv(), env), repo);
      expect(r.code).toBe(EXIT_OK);
      expect(seen).toEqual([[{ limit: 7 }]]);
      expect(JSON.parse(r.stdout).config).toBe(file);
    });

    it("is exit 2 with nothing on stdout, no check run and no usage text for a path naming no file", async () => {
      useRegistry(recorder);
      seen.length = 0;
      const r = await run(actionArguments(argv(), { REPO_TRUTH_CONFIG: "no-such-config.json" }), repo);
      expect(r.code).toBe(EXIT_BAD_INVOCATION);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("no-such-config.json");
      expect(r.stderr).not.toContain("usage:");
      expect(seen).toEqual([]);
    });
  });
});

const tick =(n: number): string => "`".repeat(n);

describe("jobSummary", () => {
  const sentences = [
    "All checks passed (exit code 0).",
    "At least one check failed (exit code 1).",
    "The checks did not run (exit code 2).",
  ];
  const head = (code: number) => `## repo-truth\n\n${sentences[code]}\n\n`;

  it("holds the heading, the sentence and one fenced block, for each exit code", () => {
    for (const code of [0, 1, 2]) {
      const f = tick(3);
      expect(jobSummary(code, "a\nb")).toBe(`${head(code)}${f}\na\nb\n${f}\n`);
      expect(jobSummary(code, "a\nb\n")).toBe(`${head(code)}${f}\na\nb\n${f}\n`);
      expect(jobSummary(code, "a\n\n")).toBe(`${head(code)}${f}\na\n\n${f}\n`);
      expect(jobSummary(code, "")).toBe(`${head(code)}${f}\n${f}\n`);
    }
  });

  it("fences with a run longer than any run of backticks in the output", () => {
    const three = `x ${tick(3)} y\n`;
    expect(jobSummary(1, three)).toBe(`${head(1)}${tick(4)}\nx ${tick(3)} y\n${tick(4)}\n`);
    const five = `${tick(5)}\nz`;
    expect(jobSummary(0, five)).toBe(`${head(0)}${tick(6)}\n${tick(5)}\nz\n${tick(6)}\n`);
    expect(jobSummary(2, `a ${tick(1)} b ${tick(2)}`)).toBe(`${head(2)}${tick(3)}\na ${tick(1)} b ${tick(2)}\n${tick(3)}\n`);
  });
});

describe("runAction", () => {
  let repo: string;
  let head: string;
  let dir: string;

  beforeAll(() => {
    repo = newRepo();
    commit(repo, "a.txt", "1\n", "fork");
    git(repo, "checkout", "-q", "-b", "feature");
    head = commit(repo, "f.txt", "f\n", "feature work");
    git(repo, "checkout", "-q", "main");
    dir = join(root, "summaries");
    mkdirSync(dir);
  });

  const argv = () => ["check", "--no-fetch", "--format", "json", "--target", "main", "--candidate", head];

  async function act(args: string[], env: Record<string, string | undefined>) {
    let stdout = "";
    let stderr = "";
    const code = await runAction(args, env, {
      cwd: repo,
      env,
      stdout: (t) => void (stdout += t),
      stderr: (t) => void (stderr += t),
    });
    return { code, stdout, stderr };
  }

  const summaryPath = () => join(dir, `s-${counter++}.md`);

  it("appends the summary of a passing run to an absent file, and prints what the command prints", async () => {
    useRegistry(stub("A", "pass"));
    const file = summaryPath();
    const plain = await run(argv(), repo);
    const r = await act(argv(), { GITHUB_STEP_SUMMARY: file });
    expect(r).toEqual(plain);
    expect(r.code).toBe(EXIT_OK);
    expect(readFileSync(file, "utf8")).toBe(jobSummary(0, r.stdout));
  });

  it("appends after an empty file, a line with its newline, and a line without", async () => {
    useRegistry(stub("A", "fail"));
    for (const held of ["", "line\n", "line"]) {
      const file = summaryPath();
      writeFileSync(file, held);
      const r = await act(argv(), { GITHUB_STEP_SUMMARY: file });
      expect(r.code).toBe(EXIT_CHECK_FAILED);
      const lead = held === "" || held.endsWith("\n") ? "" : "\n";
      expect(readFileSync(file, "utf8")).toBe(held + lead + jobSummary(1, r.stdout));
      expect(r.stderr).toBe("");
    }
  });

  it("holds stderr on exit 2 and leaves stdout empty", async () => {
    useRegistry(stub("A", "pass"));
    const file = summaryPath();
    const r = await act(["check", "--no-fetch", "--candidate", head], { GITHUB_STEP_SUMMARY: file });
    expect(r.code).toBe(EXIT_BAD_INVOCATION);
    expect(r.stdout).toBe("");
    expect(r.stderr).not.toBe("");
    expect(readFileSync(file, "utf8")).toBe(jobSummary(2, r.stderr));
  });

  it("holds the refusal in the summary for a config path naming no file", async () => {
    useRegistry(stub("A", "pass"));
    const file = summaryPath();
    const r = await act(argv(), { GITHUB_STEP_SUMMARY: file, REPO_TRUTH_CONFIG: "no-such-config.json" });
    expect(r.code).toBe(EXIT_BAD_INVOCATION);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("no-such-config.json");
    expect(r.stderr).not.toContain("usage:");
    const summary = readFileSync(file, "utf8");
    expect(summary).toBe(jobSummary(2, r.stderr));
    expect(summary).toContain("The checks did not run (exit code 2).");
    expect(summary).toContain("no-such-config.json");
  });

  it("says one line on stderr and changes nothing else when the file cannot be written", async () => {
    useRegistry(stub("A", "pass"));
    const plain = await run(argv(), repo);
    const r = await act(argv(), { GITHUB_STEP_SUMMARY: dir });
    expect(r.code).toBe(plain.code);
    expect(r.stdout).toBe(plain.stdout);
    expect(r.stderr.startsWith("repo-truth: could not write the job summary")).toBe(true);
    expect(r.stderr.trimEnd().split("\n")).toHaveLength(1);
  });

  it("writes no file when the variable is unset or empty", async () => {
    useRegistry(stub("A", "pass"));
    const plain = await run(argv(), repo);
    for (const env of [{}, { GITHUB_STEP_SUMMARY: "" }]) {
      const r = await act(argv(), env);
      expect(r).toEqual(plain);
    }
    expect(existsSync(join(dir, `s-${counter}.md`))).toBe(false);
  });
});

describe("the except input", () => {
  const base = ["check", "--target", "origin/main", "--candidate", "abc"];
  const text = readFileSync(join(__dirname, "..", "..", "action.yml"), "utf8");
  const inputs = text.slice(text.indexOf("\ninputs:"), text.indexOf("\nruns:"));
  const except = inputs.slice(inputs.indexOf("  except:"), inputs.indexOf("  format:"));
  const exceptions = (...names: string[]) => names.flatMap((n) => ["--except", n]);

  it("passes nothing for an empty or unset except", () => {
    expect(actionArguments(base, { REPO_TRUTH_EXCEPT: "" })).toEqual(base);
    expect(actionArguments(base, { REPO_TRUTH_EXCEPT: undefined })).toEqual(base);
    expect(actionArguments(base, { REPO_TRUTH_EXCEPT: " ,\n" })).toEqual(base);
  });

  it("passes one name as one --except", () => {
    expect(actionArguments(base, { REPO_TRUTH_EXCEPT: "A" })).toEqual([...base, "--except", "A"]);
  });

  it("splits at commas, spaces, tabs and newlines, dropping empty names, in order", () => {
    expect(actionArguments(base, { REPO_TRUTH_EXCEPT: "A,B" })).toEqual([...base, ...exceptions("A", "B")]);
    expect(actionArguments(base, { REPO_TRUTH_EXCEPT: " A,,B ,\tC\nD\r\n,E " })).toEqual([
      ...base,
      ...exceptions("A", "B", "C", "D", "E"),
    ]);
  });

  it("comes after the checks and before the format and the config", () => {
    const env = {
      REPO_TRUTH_CONFIG: "c.json",
      REPO_TRUTH_FORMAT: "json",
      REPO_TRUTH_EXCEPT: "X Y",
      REPO_TRUTH_CHECKS: "A",
    };
    expect(actionArguments(base, env)).toEqual([
      ...base,
      "--check",
      "A",
      ...exceptions("X", "Y"),
      "--format",
      "json",
      "--config",
      "c.json",
    ]);
  });

  it("leaves shell characters as one argument each", () => {
    expect(actionArguments([], { REPO_TRUTH_EXCEPT: "$(id);x `id` 'q' *" })).toEqual(
      exceptions("$(id);x", "`id`", "'q'", "*"),
    );
  });

  it("is declared optional, empty by default, and names --except in action.yml", () => {
    expect(except).toMatch(/required: false/);
    expect(except).toMatch(/default: ""/);
    expect(except).toContain("--except");
    expect(except).toMatch(/left out/);
    expect(except).toMatch(/every other registered check runs/);
  });

  it("reaches the step through one env entry and no script names it", () => {
    expect(text.match(/REPO_TRUTH_EXCEPT/g)).toHaveLength(1);
    expect(text).toMatch(/^ {8}REPO_TRUTH_EXCEPT: \$\{\{ inputs\.except \}\}$/m);
    expect(text.match(/inputs\.except/g)).toHaveLength(1);
    expect(text.slice(text.indexOf("run: |"))).not.toContain("EXCEPT");
  });

  describe("through main and runAction", () => {
    let repo: string;
    let head: string;

    beforeAll(() => {
      repo = newRepo();
      commit(repo, "a.txt", "1\n", "fork");
      git(repo, "checkout", "-q", "-b", "feature");
      head = commit(repo, "f.txt", "f\n", "feature work");
      git(repo, "checkout", "-q", "main");
    });

    const argv = () => ["check", "--no-fetch", "--format", "json", "--target", "main", "--candidate", head];

    it("runs every entry but the one named", async () => {
      const calls: string[] = [];
      useRegistry(stub("A", "pass", calls), stub("B", "pass", calls), stub("C", "pass", calls));
      const r = await run(actionArguments(argv(), { REPO_TRUTH_EXCEPT: "B" }), repo);
      expect(r.code).toBe(EXIT_OK);
      expect(calls.sort()).toEqual(["A", "C"]);
      expect(JSON.parse(r.stdout).records.map((x: CheckRecord) => x.name).sort()).toEqual(["A", "C"]);
    });

    it("leaves out a failing check and takes the code of the rest", async () => {
      const calls: string[] = [];
      useRegistry(stub("A", "pass", calls), stub("B", "fail", calls));
      const r = await run(actionArguments(argv(), { REPO_TRUTH_EXCEPT: "B" }), repo);
      expect(r.code).toBe(EXIT_OK);
      expect(calls).toEqual(["A"]);
    });

    it("is exit 2 with nothing on stdout and no check run for an unknown name, every entry, or checks too", async () => {
      const calls: string[] = [];
      useRegistry(stub("A", "pass", calls), stub("B", "pass", calls));
      for (const env of [
        { REPO_TRUTH_EXCEPT: "NOPE" },
        { REPO_TRUTH_EXCEPT: "A,B" },
        { REPO_TRUTH_EXCEPT: "A", REPO_TRUTH_CHECKS: "B" },
      ]) {
        const r = await run(actionArguments(argv(), env), repo);
        expect(r.code).toBe(EXIT_BAD_INVOCATION);
        expect(r.stdout).toBe("");
        expect(r.stderr).not.toBe("");
      }
      expect(calls).toEqual([]);
    });

    it("holds the refusal in the job summary for an except the command refuses", async () => {
      useRegistry(stub("A", "pass"));
      const file = join(root, `except-summary-${counter++}.md`);
      const env = { GITHUB_STEP_SUMMARY: file, REPO_TRUTH_EXCEPT: "RT-no-such-check" };
      let stdout = "";
      let stderr = "";
      const code = await runAction(argv(), env, {
        cwd: repo,
        env,
        stdout: (t) => void (stdout += t),
        stderr: (t) => void (stderr += t),
      });
      expect(code).toBe(EXIT_BAD_INVOCATION);
      expect(stdout).toBe("");
      expect(stderr).toContain("RT-no-such-check");
      const summary = readFileSync(file, "utf8");
      expect(summary).toBe(jobSummary(2, stderr));
      expect(summary).toContain("The checks did not run (exit code 2).");
      expect(summary).toContain("RT-no-such-check");
    });
  });
});

describe("resolveMergeBase failures", () => {
  it("says the checkout is shallow in a shallow checkout", async () => {
    const origin = newRepo();
    commit(origin, "a.txt", "1\n", "fork");
    git(origin, "checkout", "-q", "-b", "feature");
    commit(origin, "f.txt", "f\n", "feature work");
    git(origin, "checkout", "-q", "main");
    commit(origin, "m1.txt", "m\n", "main 1");
    commit(origin, "m2.txt", "m\n", "main 2");
    const clone = join(root, `clone-${counter++}`);
    git(root, "clone", "-q", "--depth", "1", "--no-single-branch", pathToFileURL(origin).href, clone);
    expect(git(clone, "rev-parse", "--is-shallow-repository")).toBe("true");
    const error = await resolveMergeBase(clone, "origin/main", "origin/feature").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RangeResolutionError);
    expect((error as Error).message).toMatch(/shallow/);
    expect((error as Error).message).toContain("fetch-depth: 0");
  });

  it("says the two share no history, and not that the checkout is shallow, in a full checkout", async () => {
    const repo = newRepo();
    commit(repo, "a.txt", "1\n", "main work");
    git(repo, "checkout", "-q", "--orphan", "island");
    const island = commit(repo, "i.txt", "i\n", "island work");
    expect(git(repo, "rev-parse", "--is-shallow-repository")).toBe("false");
    const error = await resolveMergeBase(repo, "main", island).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RangeResolutionError);
    expect((error as Error).message).toContain("share no history");
    expect((error as Error).message).not.toMatch(/shallow/);
  });

  it("carries git's own complaint, naming the target, for a target that names no commit", async () => {
    const repo = newRepo();
    const only = commit(repo, "a.txt", "1\n", "work");
    const error = await resolveMergeBase(repo, "no-such-branch", only).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RangeResolutionError);
    const message = (error as Error).message;
    expect(message.startsWith("could not compute the merge base of")).toBe(true);
    expect(message).toContain("no-such-branch");
    expect(message).toContain("fatal:");
    expect(message).not.toContain("Command failed");
    expect(message).not.toMatch(/share no history|shallow/);
  });
});

const PROGRAM_TIMEOUT_MS = 120000;

describe("as a program", () => {
  let built: string;
  let broken: string;
  let summaries: string;

  beforeAll(() => {
    built = mkdtempSync(join(tmpdir(), "repo-truth-action-program-"));
    broken = mkdtempSync(join(tmpdir(), "repo-truth-action-broken-"));
    summaries = mkdtempSync(join(tmpdir(), "repo-truth-action-out-"));
    const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
    const project = fileURLToPath(new URL("../../tsconfig.build.json", import.meta.url));
    execFileSync(process.execPath, [tsc, "-p", project, "--outDir", built], { encoding: "utf8" });
    writeFileSync(join(built, "package.json"), '{"type":"module"}\n');
    cpSync(built, broken, { recursive: true });
    rmSync(join(broken, "cli.js"));
  }, PROGRAM_TIMEOUT_MS);

  afterAll(() => {
    for (const dir of [built, broken, summaries]) if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const program = (dir: string, file: string, ...args: string[]) =>
    spawnSync(process.execPath, [join(dir, "action.js"), ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: file },
    });

  it("answers --help with the usage main prints, and appends its summary", async () => {
    const file = join(summaries, "help.md");
    let usage = "";
    const code = await main(["--help"], { stdout: (t) => void (usage += t), stderr: () => undefined });
    expect(code).toBe(EXIT_OK);
    expect(usage).not.toBe("");
    const result = program(built, file, "--help");
    expect(result.status).toBe(EXIT_OK);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(usage);
    expect(readFileSync(file, "utf8")).toBe(jobSummary(0, usage));
  });

  it("prints nothing, says repo-truth: on stderr and exits 2 when the command cannot be loaded", () => {
    const file = join(summaries, "broken.md");
    const result = program(broken, file, "--help");
    expect(result.status).toBe(EXIT_BAD_INVOCATION);
    expect(result.stdout).toBe("");
    expect(result.stderr.startsWith("repo-truth: ")).toBe(true);
    expect(result.stderr.trimEnd().split("\n")).toHaveLength(1);
  });
});
