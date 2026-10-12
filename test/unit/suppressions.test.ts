import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli.js";
import { check, name, SUPPRESSION_DIRECTIVES } from "../../src/checks/suppressions.js";
import { SANCTION_KEY } from "../../src/weakened-tests.js";

const execFileAsync = promisify(execFile);

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "Test Committer",
  GIT_COMMITTER_EMAIL: "committer@example.com",
};

// No directive is written out whole here: each is joined at run time.
const SLASHES = "/".repeat(2);
const BLOCK = "/" + "*";
const AT = "@";
const WORDS: [string, string, string][] = [
  ["@ts-ignore", `${AT}ts-` + "ignore", "a.ts"],
  ["@ts-nocheck", `${AT}ts-` + "nocheck", "a.tsx"],
  ["@ts-expect-error", `${AT}ts-` + "expect-error", "a.mts"],
  ["eslint-disable", "eslint-" + "disable", "a.cts"],
  ["eslint-disable", "eslint-" + "disable-line", "a.js"],
  ["eslint-disable", "eslint-" + "disable-next-line", "a.jsx"],
  ["istanbul ignore", "istanbul " + "ignore next", "a.mjs"],
  ["c8 ignore", "c8 " + "ignore next", "a.cjs"],
  ["v8 ignore", "v8 " + "ignore next", "a.ts"],
];
const TS_IGNORE = WORDS[0]![1];
const ESLINT = WORDS[3]![1];
const line = (words: string): string => `${SLASHES} ${words}\nlet x = 1;\n`;
const block = (words: string): string => `${BLOCK}* ${words} */\nlet x = 1;\n`;
const PLAIN = "let x = 1;\n";
const FIRST = 1;
const THIRD = 3;

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args as string[], { cwd, env: ENV });
  return stdout.trim();
}

async function commit(cwd: string, files: Record<string, string | Buffer | null>, message = "change"): Promise<string> {
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

describe("RT-31 suppression directives", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "repo-truth-suppressions-"));
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function run(
    before: Record<string, string | Buffer | null>,
    after: Record<string, string | Buffer | null>,
    extra: { message?: string; sanctions?: Record<string, string> } = {},
  ) {
    const base = await commit(repo, { "keep.txt": "keep\n", ...before }, "base");
    const candidate = await commit(repo, after, extra.message ?? "change");
    return check({ cwd: repo, base, candidate, sanctions: extra.sanctions });
  }

  it("is named RT-31", () => {
    expect(name).toBe("RT-31");
  });

  for (const [label, words, file] of WORDS) {
    for (const [kind, make] of [["line", line], ["block", block]] as const) {
      it(`reports ${words} in a ${kind} comment of ${file}`, async () => {
        const record = await run({ [file]: PLAIN }, { [file]: make(words) });
        expect(record.name).toBe("RT-31");
        expect(record.status).toBe("fail");
        expect(record.findings.map((f) => [f.category, f.file, f.line, f.name])).toEqual([["suppression-added", file, FIRST, label]]);
        expect(record.evidence[0]).toContain(`${file}:${FIRST}: added ${label}`);
      });
    }
  }

  it("says nothing of a directive the base already holds", async () => {
    const text = line(TS_IGNORE);
    const record = await run({ "a.ts": text }, { "a.ts": `${text}let y = 2;\n` });
    expect(record.status).toBe("pass");
    expect(record.evidence).toEqual(["no suppression directive added"]);
  });

  it("says nothing of a directive that moved within its file", async () => {
    const record = await run({ "a.ts": `${line(TS_IGNORE)}let y = 2;\n` }, { "a.ts": `let y = 2;\n${line(TS_IGNORE)}` });
    expect(record.status).toBe("pass");
    expect(record.findings).toEqual([]);
  });

  it("says nothing of a file renamed with its directives", async () => {
    const text = `${line(ESLINT)}${SLASHES} padding one\n${SLASHES} padding two\n`;
    const record = await run({ "a.ts": text }, { "a.ts": null, "dir/b.ts": text });
    expect(record.status).toBe("pass");
  });

  it("reports a directive added in a renamed file", async () => {
    const before = `${line(TS_IGNORE)}${SLASHES} padding one\n${SLASHES} padding two\n${SLASHES} padding three\n`;
    const record = await run({ "a.ts": before }, { "a.ts": null, "b.ts": `${before}${line(TS_IGNORE)}` });
    expect(record.findings.map((f) => [f.file, f.line])).toEqual([["b.ts", THIRD + 3]]);
  });

  it("reports a directive in a file the range adds", async () => {
    const record = await run({}, { "new.ts": line(WORDS[6]![1]) });
    expect(record.status).toBe("fail");
    expect(record.findings.map((f) => f.file)).toEqual(["new.ts"]);
  });

  it("reports one finding for each entry a line matches", async () => {
    const both = `${SLASHES} ${TS_IGNORE} ${BLOCK} ${ESLINT} */\n`;
    const record = await run({ "a.ts": PLAIN }, { "a.ts": both });
    expect(record.findings.map((f) => f.name).sort()).toEqual(["@ts-ignore", "eslint-disable"]);
  });

  it("ignores the word where no comment opener comes right before it", async () => {
    const text = `${SLASHES} see ${TS_IGNORE} here\nconst s = "${TS_IGNORE}";\n ${BLOCK}\n * ${TS_IGNORE}\n */\n`;
    const record = await run({ "a.ts": PLAIN }, { "a.ts": text });
    expect(record.status).toBe("pass");
  });

  it("ignores a Markdown file and a binary file", async () => {
    const binary = Buffer.concat([Buffer.from(line(TS_IGNORE)), Buffer.from([0, 1, 2])]);
    const record = await run({}, { "notes.md": line(TS_IGNORE), "blob.ts": binary });
    expect(record.status).toBe("pass");
  });

  it("escapes a path outside printable ASCII", async () => {
    const record = await run({}, { "café.ts": line(TS_IGNORE) });
    expect(record.evidence[0]).toMatch(/^caf\\u\{00e9\}\.ts:1: /);
    expect(record.findings[0]?.file).toBe("café.ts");
  });

  it("is sanctioned by a line of a commit message", async () => {
    const message = `change\n\n${SANCTION_KEY}: suppression-added:a.ts:${FIRST} generated code\n`;
    const record = await run({ "a.ts": PLAIN }, { "a.ts": line(TS_IGNORE) }, { message });
    expect(record.status).toBe("pass");
    expect(record.evidence[0]).toMatch(/added.*sanctioned.*generated code/);
  });

  it("is sanctioned for a whole file by a line of a commit message", async () => {
    const message = `change\n\n${SANCTION_KEY}: suppression-added:a.ts whole file\n`;
    const record = await run({ "a.ts": PLAIN }, { "a.ts": line(TS_IGNORE) + line(ESLINT) }, { message });
    expect(record.status).toBe("pass");
    expect(record.findings).toHaveLength(2);
  });

  it("is sanctioned by the caller's option, and only the finding it names", async () => {
    const sanctions = { [`suppression-added:a.ts:${FIRST}`]: "caller says so" };
    const record = await run({ "a.ts": PLAIN }, { "a.ts": line(TS_IGNORE) + line(ESLINT) }, { sanctions });
    expect(record.status).toBe("fail");
    expect(record.evidence[0]).toContain("sanctioned: caller says so");
    expect(record.evidence[1]).not.toContain("sanctioned");
  });

  it("does not read a sanction from a file", async () => {
    const file = `${SANCTION_KEY}: suppression-added:a.ts a file says so\n`;
    const record = await run({ "a.ts": PLAIN }, { "a.ts": line(TS_IGNORE), "SANCTIONS.md": file });
    expect(record.status).toBe("fail");
  });

  it("applies an entry appended to the list", async () => {
    const entry = { name: "custom", files: /\.ts$/, pattern: new RegExp(SLASHES + "\\s*custom-" + "skip") };
    SUPPRESSION_DIRECTIVES.push(entry);
    try {
      const record = await run({ "a.ts": PLAIN }, { "a.ts": `${SLASHES} custom-skip\n` });
      expect(record.findings.map((f) => f.name)).toEqual(["custom"]);
    } finally {
      SUPPRESSION_DIRECTIVES.splice(SUPPRESSION_DIRECTIVES.indexOf(entry), 1);
    }
  });

  it("fails closed on a revision that names no commit", async () => {
    await commit(repo, { "a.ts": PLAIN }, "base");
    const record = await check({ cwd: repo, base: "no-such-revision", candidate: "HEAD" });
    expect(record.status).toBe("fail");
    expect(record.evidence.join("\n")).toContain("no-such-revision");
  });

  it("fails closed when git itself fails", async () => {
    const record = await check({ cwd: join(repo, "does-not-exist"), base: "HEAD", candidate: "HEAD" });
    expect(record.status).toBe("fail");
    expect(record.evidence.length).toBeGreaterThan(0);
  });

  it("is the only record `repo-truth check --check RT-31` prints", async () => {
    await commit(repo, { "m.ts": PLAIN }, "base");
    await commit(repo, { "m.ts": line(TS_IGNORE) }, "change");
    let stdout = "";
    const code = await main(["check", "--check", "RT-31", "--no-fetch", "--base", "HEAD~1", "--candidate", "main", "--format", "json"], {
      cwd: repo,
      stdout: (t) => void (stdout += t),
      stderr: () => undefined,
    });
    expect(code).not.toBe(0);
    const parsed = JSON.parse(stdout) as unknown;
    const records = (Array.isArray(parsed) ? parsed : (parsed as { records: unknown[] }).records) as { name: string }[];
    expect(records.map((r) => r.name)).toEqual(["RT-31"]);
  });
});
