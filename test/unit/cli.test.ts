import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

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

async function run(argv: string[], cwd: string) {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    cwd,
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

let root: string;
let repo: string;
let first: string;
let second: string;
const original = [...REGISTRY];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "repo-truth-cli-"));
  repo = join(root, "repo");
  git(root, "init", "-q", "-b", "main", repo);
  first = commit(repo, "a.txt", "one\n", "first");
  second = commit(repo, "a.txt", "two\n", "second");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

afterEach(() => {
  REGISTRY.splice(0, REGISTRY.length, ...original);
});

function useRegistry(...entries: RegistryEntry[]): void {
  REGISTRY.splice(0, REGISTRY.length, ...entries);
}

const range = () => ["check", "--no-fetch", "--base", first, "--candidate", second];

describe("exit codes", () => {
  it("0 when every check passes or skips", async () => {
    useRegistry(stub("A", "pass"), stub("B", "skip"));
    expect((await run(range(), repo)).code).toBe(EXIT_OK);
    expect(EXIT_OK).toBe(0);
  });

  it("1 when at least one check fails", async () => {
    useRegistry(stub("A", "pass"), stub("B", "fail"));
    expect((await run(range(), repo)).code).toBe(EXIT_CHECK_FAILED);
    expect(EXIT_CHECK_FAILED).toBe(1);
  });

  it("2 for a bad invocation, with nothing on stdout", async () => {
    useRegistry(stub("A", "fail"));
    for (const argv of [
      [],
      ["bogus"],
      ["check"],
      ["check", "--base", first],
      ["check", "--no-fetch", "--base", first, "--candidate", second, "--wat"],
      ["check", "--no-fetch", "--base", first, "--candidate", second, "--format", "yaml"],
    ]) {
      const result = await run(argv, repo);
      expect(result.code, argv.join(" ")).toBe(EXIT_BAD_INVOCATION);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toBe("");
    }
    expect(EXIT_BAD_INVOCATION).toBe(2);
  });

  it("2 outside a git repository", async () => {
    const result = await run(range(), root);
    expect(result.code).toBe(EXIT_BAD_INVOCATION);
    expect(result.stdout).toBe("");
  });
});

describe("revisions that name no commit", () => {
  for (const which of ["--base", "--candidate"]) {
    for (const fetch of [false, true]) {
      it(`${which} with a missing revision exits 2, ${fetch ? "after" : "without"} fetching`, async () => {
        const calls: string[] = [];
        useRegistry(stub("A", "pass", calls));
        const argv = ["check", "--base", first, "--candidate", second];
        if (!fetch) argv.push("--no-fetch");
        argv[argv.indexOf(which) + 1] = "no-such-revision";
        const result = await run(argv, repo);
        expect(result.code).toBe(EXIT_BAD_INVOCATION);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("no-such-revision");
        expect(calls).toEqual([]);
      });
    }
  }

  it("a revision starting with a dash is not handed to git as an option", async () => {
    const result = await run(["check", "--no-fetch", "--base", "--all", "--candidate", second], repo);
    expect(result.code).toBe(EXIT_BAD_INVOCATION);
  });

  it("a blob id is not a commit", async () => {
    const blob = git(repo, "rev-parse", `${second}:a.txt`);
    const result = await run(["check", "--no-fetch", "--base", blob, "--candidate", second], repo);
    expect(result.code).toBe(EXIT_BAD_INVOCATION);
    expect(result.stdout).toBe("");
  });
});

describe("registry", () => {
  it("runs exactly what the registry holds", async () => {
    const calls: string[] = [];
    useRegistry(stub("X", "pass", calls), stub("Y", "pass", calls), stub("Z", "pass", calls));
    const result = await run([...range(), "--format", "json"], repo);
    expect(calls).toEqual(["X", "Y", "Z"]);
    expect(JSON.parse(result.stdout).records.map((r: CheckRecord) => r.name)).toEqual(["X", "Y", "Z"]);
  });

  it("a check added to the registry is in the run", async () => {
    const calls: string[] = [];
    useRegistry(...original, stub("EXTRA", "pass", calls));
    const result = await run([...range(), "--format", "json"], repo);
    expect(calls).toEqual(["EXTRA"]);
    const names = JSON.parse(result.stdout).records.map((r: CheckRecord) => r.name);
    expect(names).toEqual([...original.map((e) => e.name), "EXTRA"]);
  });

  it("hands run the repository and the resolved range", async () => {
    let seen: unknown;
    useRegistry({
      name: "SEEN",
      run: (r, rg) => {
        seen = { r, rg };
        return { name: "SEEN", status: "pass", evidence: [] };
      },
    });
    await run(["check", "--no-fetch", "--base", "HEAD~1", "--candidate", "HEAD"], repo);
    expect(seen).toEqual({ r: { cwd: repo }, rg: { base: first, candidate: second } });
  });

  it("runs the real checks over a real range", async () => {
    const result = await run([...range(), "--format", "json"], repo);
    const doc = JSON.parse(result.stdout);
    expect(doc.records.map((r: CheckRecord) => r.name)).toEqual(original.map((e) => e.name));
  });

  it("package.json has no stale list: registry names are unique", () => {
    const names = original.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("a throwing check", () => {
  it("becomes a fail record and the run continues", async () => {
    useRegistry(
      stub("BEFORE", "pass"),
      {
        name: "BOOM",
        run: () => {
          throw new Error("kaboom");
        },
      },
      { name: "REJECT", run: () => Promise.reject(new Error("rejected")) },
      stub("AFTER", "pass"),
    );
    const result = await run([...range(), "--format", "json"], repo);
    expect(result.code).toBe(EXIT_CHECK_FAILED);
    const doc = JSON.parse(result.stdout);
    const byName = Object.fromEntries(doc.records.map((r: CheckRecord) => [r.name, r]));
    expect(Object.keys(byName)).toEqual(["BEFORE", "BOOM", "REJECT", "AFTER"]);
    expect(byName.BOOM.status).toBe("fail");
    expect(byName.BOOM.evidence.join("\n")).toContain("kaboom");
    expect(byName.REJECT.status).toBe("fail");
    expect(byName.REJECT.evidence.join("\n")).toContain("rejected");
    expect(byName.BEFORE.status).toBe("pass");
    expect(byName.AFTER.status).toBe("pass");
  });
});

describe("output", () => {
  it("--format json prints one documented JSON document", async () => {
    useRegistry(stub("A", "pass"), stub("B", "fail"));
    const result = await run([...range(), "--format", "json"], repo);
    expect(JSON.parse(result.stdout)).toEqual({
      schema: "repo-truth.check/v1",
      base: first,
      candidate: second,
      ok: false,
      exitCode: 1,
      records: [
        { name: "A", status: "pass", evidence: ["A says pass"] },
        { name: "B", status: "fail", evidence: ["B says fail"] },
      ],
    });
  });

  it("json resolves revisions to commit ids and reports ok/exitCode 0", async () => {
    useRegistry(stub("A", "skip"));
    const result = await run(["check", "--no-fetch", "--base", "HEAD~1", "--candidate", "main", "--format=json"], repo);
    const doc = JSON.parse(result.stdout);
    expect(doc.base).toBe(first);
    expect(doc.candidate).toBe(second);
    expect(doc.ok).toBe(true);
    expect(doc.exitCode).toBe(0);
  });

  it("the default is the human rendering, not JSON", async () => {
    useRegistry(stub("A", "pass"));
    const result = await run(range(), repo);
    expect(() => JSON.parse(result.stdout)).toThrow();
    expect(result.stdout).toContain("A says pass");
    expect(result.stdout).not.toMatch(/\u001b\[/);
  });
});

describe("--check", () => {
  it("runs only the named checks, and may repeat", async () => {
    const calls: string[] = [];
    useRegistry(stub("A", "pass", calls), stub("B", "pass", calls), stub("C", "pass", calls));
    const result = await run([...range(), "--check", "C", "--check", "A", "--format", "json"], repo);
    expect(calls).toEqual(["A", "C"]);
    expect(result.code).toBe(0);
  });

  it("an unknown name is a bad invocation and nothing runs", async () => {
    const calls: string[] = [];
    useRegistry(stub("A", "pass", calls));
    const result = await run([...range(), "--check", "A", "--check", "NOPE"], repo);
    expect(result.code).toBe(EXIT_BAD_INVOCATION);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("NOPE");
    expect(calls).toEqual([]);
  });
});

describe("fetching", () => {
  let upstream: string;
  let clone: string;
  let newer: string;

  beforeAll(() => {
    upstream = join(root, "upstream");
    git(root, "init", "-q", "-b", "main", upstream);
    commit(upstream, "f.txt", "1\n", "u1");
    clone = join(root, "clone");
    git(root, "clone", "-q", upstream, clone);
    newer = commit(upstream, "f.txt", "2\n", "u2");
  });

  it("fetches every remote before resolving, unless --no-fetch", async () => {
    useRegistry(stub("A", "pass"));
    const argv = ["check", "--base", "HEAD", "--candidate", newer];

    const stale = await run([...argv, "--no-fetch"], clone);
    expect(stale.code).toBe(EXIT_BAD_INVOCATION);
    expect(stale.stdout).toBe("");

    const fetched = await run([...argv, "--format", "json"], clone);
    expect(fetched.code).toBe(EXIT_OK);
    expect(JSON.parse(fetched.stdout).candidate).toBe(newer);
  });

  it("a failed fetch is an unrunnable environment", async () => {
    useRegistry(stub("A", "pass"));
    git(clone, "remote", "add", "broken", join(root, "does-not-exist"));
    const result = await run(["check", "--base", "HEAD", "--candidate", "HEAD"], clone);
    expect(result.code).toBe(EXIT_BAD_INVOCATION);
    expect(result.stdout).toBe("");
    git(clone, "remote", "remove", "broken");
  });
});

describe("package.json", () => {
  it("maps repo-truth in bin to the built entry point", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8"));
    expect(pkg.bin["repo-truth"]).toBe("dist/cli.js");
  });
});
