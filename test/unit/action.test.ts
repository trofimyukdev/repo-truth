import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { actionArguments, assertPullRequestEvent, RangeResolutionError, resolveMergeBase } from "../../src/action.js";
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
    expect(text).toContain("check --target");
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
    expect(script).toContain('node "$REPO_TRUTH_BIN" check --target "$REPO_TRUTH_TARGET" --candidate "$REPO_TRUTH_CANDIDATE"');
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
});
