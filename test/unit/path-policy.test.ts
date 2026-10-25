import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli.js";
import { check, matchesPattern, name, optionKinds, type PathPolicyOptions } from "../../src/checks/path-policy.js";
import { SANCTION_KEY } from "../../src/weakened-tests.js";

const execFileAsync = promisify(execFile);

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "Test Committer",
  GIT_COMMITTER_EMAIL: "committer@example.com",
};

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args as string[], { cwd, env: ENV });
  return stdout.trim();
}

async function commit(cwd: string, files: Record<string, string | null>, message = "change"): Promise<void> {
  for (const [file, content] of Object.entries(files)) {
    if (content === null) await rm(join(cwd, file));
    else {
      await mkdir(dirname(join(cwd, file)), { recursive: true });
      await writeFile(join(cwd, file), content);
    }
  }
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "--quiet", "--allow-empty", "-m", message]);
}

describe("RT-57 matchesPattern", () => {
  const yes = (pattern: string, path: string): void => expect(matchesPattern(pattern, path), `${pattern} ~ ${path}`).toBe(true);
  const no = (pattern: string, path: string): void => expect(matchesPattern(pattern, path), `${pattern} !~ ${path}`).toBe(false);

  it("matches whole paths only", () => {
    yes("a/b", "a/b");
    no("a", "a/b");
    no("b", "a/b");
    no("a/b", "x/a/b");
    no("a/b", "a/b/c");
  });

  it("reads ? as one character but /", () => {
    yes("a?c", "abc");
    no("a?c", "ac");
    no("a?c", "a/c");
    no("a?c", "abbc");
  });

  it("reads * as a run without /, the empty run included", () => {
    yes("a*c", "ac");
    yes("a*c", "abbbc");
    yes("*.ts", "x.ts");
    no("*.ts", "src/x.ts");
    no("a*c", "a/c");
    yes("src/*/x", "src/a/x");
    no("src/*/x", "src/x");
  });

  it("reads a whole-segment ** as any number of whole segments", () => {
    yes("**/x", "x");
    yes("**/x", "a/b/x");
    yes("a/**", "a");
    yes("a/**", "a/b");
    yes("a/**", "a/b/c");
    yes("a/**/b", "a/b");
    yes("a/**/b", "a/c/d/b");
    no("a/**/b", "a/c");
    no("a/**", "ab");
    no("**/x", "ax");
  });

  it("reads ** that is not a whole segment as two stars", () => {
    yes("a**b", "ab");
    yes("a**b", "axxb");
    no("a**b", "a/b");
    no("**.ts", "src/x.ts");
    yes("**.ts", "x.ts");
  });

  it("reads every other character as itself, case included", () => {
    yes("a[b]", "a[b]");
    no("a[b]", "ab");
    yes("{a,b}", "{a,b}");
    no("{a,b}", "a");
    yes("!a", "!a");
    yes("a\\b", "a\\b");
    no("a\\*", "ab");
    no("A", "a");
    yes("a.b", "a.b");
    no("a.b", "axb");
  });
});

describe("RT-57 path policy", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "repo-truth-path-policy-"));
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  /** Commits `before`, then `after` with `message`, and checks the second against the first. */
  async function run(
    before: Record<string, string | null>,
    after: Record<string, string | null>,
    extra: Partial<PathPolicyOptions> & Record<string, unknown> = {},
    message = "change",
  ) {
    await commit(repo, before, "base");
    await commit(repo, after, message);
    return check({ cwd: repo, base: "HEAD~1", candidate: "HEAD", ...extra } as PathPolicyOptions);
  }

  it("is a module of the check directory", () => {
    expect(name).toBe("RT-57");
    expect(optionKinds).toEqual({ forbidden: "strings", allowed: "strings" });
  });

  it("reports a forbidden path added, changed and deleted, naming the first matching pattern", async () => {
    const record = await run(
      { "gen/b.txt": "1\n", "gen/c.txt": "1\n", "ok.txt": "1\n" },
      { "gen/a.txt": "1\n", "gen/b.txt": "2\n", "gen/c.txt": null },
      { forbidden: ["nothing", "gen/**", "gen/a.txt"] },
    );
    expect(record.name).toBe("RT-57");
    expect(record.status).toBe("fail");
    expect(record.evidence).toEqual([
      'gen/a.txt: path-forbidden "gen/**"',
      'gen/b.txt: path-forbidden "gen/**"',
      'gen/c.txt: path-forbidden "gen/**"',
    ]);
  });

  it("reports both paths of a rename", async () => {
    const body = "line\n".repeat(20);
    const record = await run({ "gen/old.txt": body }, { "gen/old.txt": null, "src/new.txt": body }, { forbidden: ["gen/**"] });
    expect(record.status).toBe("fail");
    expect(record.evidence).toEqual(['gen/old.txt: path-forbidden "gen/**"']);
    const both = await check({ cwd: repo, base: "HEAD~1", candidate: "HEAD", forbidden: ["gen/**", "src/**"] });
    expect(both.evidence).toEqual(['gen/old.txt: path-forbidden "gen/**"', 'src/new.txt: path-forbidden "src/**"']);
  });

  it("reports a path no allowed pattern covers, and none that both lists permit", async () => {
    const record = await run({ "keep.txt": "1\n" }, { "src/a.ts": "1\n", "docs/b.md": "1\n", "src/gen.ts": "1\n" }, {
      allowed: ["src/**"],
      forbidden: ["src/gen.ts"],
    });
    expect(record.status).toBe("fail");
    expect(record.evidence).toEqual(['docs/b.md: path-not-allowed', 'src/gen.ts: path-forbidden "src/gen.ts"']);
  });

  it("passes when every touched path is permitted, and ignores paths the range leaves alone", async () => {
    const record = await run({ "gen/x.txt": "1\n" }, { "src/a.ts": "1\n" }, { allowed: ["src/**"], forbidden: ["gen/**"] });
    expect(record).toEqual({ name: "RT-57", status: "pass", evidence: ["no path outside the policy"] });
  });

  it("skips with no policy, and with empty lists", async () => {
    const none = await run({ "a.txt": "1\n" }, { "b.txt": "1\n" });
    expect(none.status).toBe("skip");
    expect(none.evidence).toHaveLength(1);
    expect(none.evidence[0]).toContain("no path policy is configured");
    const empty = await check({ cwd: repo, base: "HEAD~1", candidate: "HEAD", forbidden: [], allowed: [] });
    expect(empty.status).toBe("skip");
  });

  it("refuses everything when allowed is absent and forbidden alone is given only by its patterns", async () => {
    const record = await run({ "a.txt": "1\n" }, { "b.txt": "1\n" }, { forbidden: ["zzz"] });
    expect(record.status).toBe("pass");
  });

  it("fails on a list that is not an array of strings, naming the option", async () => {
    await commit(repo, { "a.txt": "1\n" }, "base");
    await commit(repo, { "b.txt": "1\n" });
    for (const bad of ["gen/**", [1], { 0: "a" }, null]) {
      const record = await check({ cwd: repo, base: "HEAD~1", candidate: "HEAD", forbidden: bad } as unknown as PathPolicyOptions);
      expect(record.status).toBe("fail");
      expect(record.evidence.join("\n")).toContain("forbidden");
    }
    const record = await check({ cwd: repo, base: "HEAD~1", candidate: "HEAD", allowed: 3 } as unknown as PathPolicyOptions);
    expect(record.status).toBe("fail");
    expect(record.evidence.join("\n")).toContain("allowed");
  });

  it("reads the commits, not the working tree", async () => {
    await commit(repo, { "a.txt": "1\n" }, "base");
    await commit(repo, { "b.txt": "1\n" });
    await writeFile(join(repo, "gen.txt"), "dirty\n");
    await writeFile(join(repo, "a.txt"), "dirty\n");
    const record = await check({ cwd: repo, base: "HEAD~1", candidate: "HEAD", forbidden: ["gen.txt", "a.txt"] });
    expect(record.status).toBe("pass");
  });

  it("is sanctioned by a line in a commit message, or by the caller", async () => {
    const line = `${SANCTION_KEY}: path-forbidden:gen/a.txt regenerated by the build`;
    const byLine = await run({ "k.txt": "1\n" }, { "gen/a.txt": "1\n" }, { forbidden: ["gen/**"] }, `change\n\n${line}`);
    expect(byLine.status).toBe("pass");
    expect(byLine.evidence).toEqual(['gen/a.txt: path-forbidden "gen/**" - sanctioned: regenerated by the build']);
    const byCaller = await check({
      cwd: repo,
      base: "HEAD~1",
      candidate: "HEAD",
      forbidden: ["gen/**"],
      sanctions: { "path-forbidden:gen/a.txt": "caller says so" },
    });
    expect(byCaller.status).toBe("pass");
    expect(byCaller.evidence[0]).toContain("sanctioned");
    expect(byCaller.evidence[0]).toContain("caller says so");
  });

  it("does not read a sanction from a file", async () => {
    const record = await run(
      { "k.txt": "1\n" },
      { "gen/a.txt": `${SANCTION_KEY}: path-forbidden:gen/a.txt in a file\n` },
      { forbidden: ["gen/**"] },
    );
    expect(record.status).toBe("fail");
  });

  it("escapes characters outside printable ASCII", async () => {
    const record = await run({ "k.txt": "1\n" }, { "gen/é.txt": "1\n" }, { forbidden: ["gen/**"] });
    expect(record.evidence).toEqual(['gen/\\u{00e9}.txt: path-forbidden "gen/**"']);
  });

  it("fails closed on a revision that names no commit", async () => {
    await commit(repo, { "a.txt": "1\n" }, "base");
    const record = await check({ cwd: repo, base: "nope", candidate: "HEAD", forbidden: ["x"] });
    expect(record.status).toBe("fail");
    expect(record.evidence.join("\n")).toContain("nope");
    const dash = await check({ cwd: repo, base: "HEAD", candidate: "--output=x", forbidden: ["x"] });
    expect(dash.status).toBe("fail");
    const outside = await check({ cwd: join(repo, "missing"), base: "HEAD", candidate: "HEAD", forbidden: ["x"] });
    expect(outside.status).toBe("fail");
  });

  it("is the only record `repo-truth check --check RT-57` prints", async () => {
    await commit(repo, { "keep.txt": "keep\n" }, "base");
    await commit(repo, { "a.txt": "1\n" }, "change");
    let stdout = "";
    const code = await main(["check", "--check", "RT-57", "--no-fetch", "--base", "HEAD~1", "--candidate", "main", "--format", "json"], {
      cwd: repo,
      stdout: (t) => void (stdout += t),
      stderr: () => undefined,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as unknown;
    const records = (Array.isArray(parsed) ? parsed : (parsed as { records: unknown[] }).records) as { name: string; status: string }[];
    expect(records.map((r) => [r.name, r.status])).toEqual([["RT-57", "skip"]]);
  });

  describe("revisions, text and sanctions", () => {
    const POLICY = ["gen/**"];

    it("names git's complaint after a revision it does not resolve, for either end", async () => {
      await commit(repo, { "a.txt": "1\n" }, "base");
      for (const [base, candidate] of [["nope", "HEAD"], ["HEAD", "nope"]] as const) {
        const record = await check({ cwd: repo, base, candidate, forbidden: POLICY });
        const opening = 'revision "nope" does not name a commit: ';
        expect(record.status).toBe("fail");
        expect(record.evidence).toHaveLength(1);
        expect(record.evidence[0]?.startsWith(opening)).toBe(true);
        expect((record.evidence[0] ?? "").slice(opening.length).trim().length).toBeGreaterThan(0);
      }
    });

    it("refuses an empty revision and one that begins with a dash before git is asked", async () => {
      await commit(repo, { "a.txt": "1\n" }, "base");
      for (const [base, candidate, said] of [
        ["", "HEAD", 'revision "" does not name a commit'],
        ["HEAD", "", 'revision "" does not name a commit'],
        ["-x", "HEAD", 'revision "-x" does not name a commit'],
        ["HEAD", "-x", 'revision "-x" does not name a commit'],
      ] as const) {
        const record = await check({ cwd: repo, base, candidate, forbidden: POLICY });
        expect(record).toEqual({ name: "RT-57", status: "fail", evidence: [said] });
      }
    });

    it("reads a revision one character long like any other", async () => {
      await commit(repo, { "k.txt": "1\n" }, "base");
      await git(repo, ["branch", "b"]);
      await commit(repo, { "gen/a.txt": "1\n" });
      await git(repo, ["branch", "c"]);
      const asBase = await check({ cwd: repo, base: "b", candidate: "HEAD", forbidden: POLICY });
      expect(asBase.status).toBe("fail");
      expect(asBase.evidence).toEqual(['gen/a.txt: path-forbidden "gen/**"']);
      const asCandidate = await check({ cwd: repo, base: "HEAD~1", candidate: "c", forbidden: POLICY });
      expect(asCandidate.evidence).toEqual(['gen/a.txt: path-forbidden "gen/**"']);
    });

    it("writes a tilde and a space as they are, and escapes a tab and a delete", async () => {
      const record = await run(
        { "k.txt": "1\n" },
        { "gen/a~b.txt": "1\n", "gen/c d.txt": "1\n", "gen/e\tf.txt": "1\n", "gen/g\x7fh.txt": "1\n" },
        { forbidden: POLICY },
      );
      expect(record.evidence).toEqual([
        'gen/a~b.txt: path-forbidden "gen/**"',
        'gen/c d.txt: path-forbidden "gen/**"',
        'gen/e\\u{0009}f.txt: path-forbidden "gen/**"',
        'gen/g\\u{007f}h.txt: path-forbidden "gen/**"',
      ]);
    });

    it("lets a caller's reason of one character sanction its finding", async () => {
      await commit(repo, { "k.txt": "1\n" }, "base");
      await commit(repo, { "gen/a.txt": "1\n" });
      const record = await check({
        cwd: repo,
        base: "HEAD~1",
        candidate: "HEAD",
        forbidden: POLICY,
        sanctions: { "path-forbidden:gen/a.txt": "x" },
      });
      expect(record.status).toBe("pass");
      expect(record.evidence).toEqual(['gen/a.txt: path-forbidden "gen/**" - sanctioned: x']);
    });

    it("lets a caller's reason of white space alone sanction nothing", async () => {
      await commit(repo, { "k.txt": "1\n" }, "base");
      await commit(repo, { "gen/a.txt": "1\n" });
      const record = await check({
        cwd: repo,
        base: "HEAD~1",
        candidate: "HEAD",
        forbidden: POLICY,
        sanctions: { "path-forbidden:gen/a.txt": " \t " },
      });
      expect(record.status).toBe("fail");
      expect(record.evidence).toEqual(['gen/a.txt: path-forbidden "gen/**"']);
    });

    it("does not let a sanction line for another path, its id as long as the finding's, sanction anything", async () => {
      const line = `${SANCTION_KEY}: path-forbidden:gen/b.txt regenerated by the build`;
      const record = await run({ "k.txt": "1\n" }, { "gen/a.txt": "1\n" }, { forbidden: POLICY }, `change\n\n${line}`);
      expect(record.status).toBe("fail");
      expect(record.evidence).toEqual(['gen/a.txt: path-forbidden "gen/**"']);
    });
  });
});
