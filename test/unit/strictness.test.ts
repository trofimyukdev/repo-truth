import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli.js";
import { STRICT_OPTIONS, check, name } from "../../src/checks/strictness.js";
import { SANCTION_KEY } from "../../src/weakened-tests.js";

const execFileAsync = promisify(execFile);

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "Test Committer",
  GIT_COMMITTER_EMAIL: "committer@example.com",
};

const TSCONFIG = "tsconfig.json";
const NESTED = "packages/app/tsconfig.json";
const INDENT = 2;

const config = (compilerOptions: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ ...extra, compilerOptions }, null, INDENT) + "\n";

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

describe("RT-34 compiler strictness lowered", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "repo-truth-strictness-"));
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

  const ids = (record: { findings: readonly { id: string }[] }): string[] => record.findings.map((f) => f.id);

  it("is named RT-34", () => {
    expect(name).toBe("RT-34");
  });

  it("lists the options the acceptance names", () => {
    const listed = new Map(STRICT_OPTIONS.map((o) => [o.name, o]));
    for (const option of ["noImplicitAny", "strictNullChecks", "strictFunctionTypes", "strictBindCallApply", "strictPropertyInitialization", "strictBuiltinIteratorReturn", "noImplicitThis", "alwaysStrict", "useUnknownInCatchVariables"]) {
      expect(listed.get(option)).toEqual({ name: option, strict: true, fromStrict: true });
    }
    for (const option of ["noUncheckedIndexedAccess", "exactOptionalPropertyTypes", "noImplicitOverride", "noImplicitReturns", "noFallthroughCasesInSwitch", "noPropertyAccessFromIndexSignature"]) {
      expect(listed.get(option)).toEqual({ name: option, strict: true, fromStrict: false });
    }
    expect(listed.get("skipLibCheck")).toEqual({ name: "skipLibCheck", strict: false, fromStrict: false });
    expect(listed.get("strict")?.strict).toBe(true);
  });

  it("reports strict turned off, with the file, option and both values", async () => {
    const record = await run({ [TSCONFIG]: config({ strict: true }) }, { [TSCONFIG]: config({ strict: false }) });
    expect(record.status).toBe("fail");
    expect(ids(record)).toContain("strictness-lowered:tsconfig.json:strict");
    expect(record.evidence[0]).toMatch(/^tsconfig\.json:.*lowered.*strict.*true.*false/);
  });

  it("reports strict removed, and each member that loses it", async () => {
    const record = await run({ [TSCONFIG]: config({ strict: true, target: "es2022" }) }, { [TSCONFIG]: config({ target: "es2022" }) });
    expect(record.status).toBe("fail");
    expect(ids(record)).toContain("strictness-lowered:tsconfig.json:strict");
    expect(ids(record)).toContain("strictness-lowered:tsconfig.json:noImplicitAny");
    expect(ids(record)).not.toContain("strictness-lowered:tsconfig.json:noUncheckedIndexedAccess");
  });

  it("reports a member turned off beneath strict, and only that one", async () => {
    const record = await run({ [TSCONFIG]: config({ strict: true }) }, { [TSCONFIG]: config({ strict: true, strictNullChecks: false }) });
    expect(ids(record)).toEqual(["strictness-lowered:tsconfig.json:strictNullChecks"]);
  });

  it("does not report a member whose own value stays strict while strict goes off", async () => {
    const record = await run(
      { [TSCONFIG]: config({ strict: true, noImplicitAny: true }) },
      { [TSCONFIG]: config({ strict: false, noImplicitAny: true }) },
    );
    expect(ids(record)).not.toContain("strictness-lowered:tsconfig.json:noImplicitAny");
    expect(ids(record)).toContain("strictness-lowered:tsconfig.json:strict");
  });

  it("reports skipLibCheck turned on and an option turned off that was on", async () => {
    const record = await run(
      { [TSCONFIG]: config({ skipLibCheck: false, noImplicitReturns: true }) },
      { [TSCONFIG]: config({ skipLibCheck: true, noImplicitReturns: false }) },
    );
    expect(ids(record).sort()).toEqual(["strictness-lowered:tsconfig.json:noImplicitReturns", "strictness-lowered:tsconfig.json:skipLibCheck"]);
  });

  it("passes an option turned on, an edit elsewhere and no change", async () => {
    const record = await run(
      { [TSCONFIG]: config({ strict: false, skipLibCheck: true }) },
      { [TSCONFIG]: config({ strict: true, skipLibCheck: false, target: "es2022" }), "README.md": "x\n" },
    );
    expect(record.status).toBe("pass");
    expect(record.evidence).toEqual(["no strict option lowered"]);
    expect(record.findings).toEqual([]);
  });

  it("reads a file the range adds and yields nothing", async () => {
    const record = await run({}, { [TSCONFIG]: config({ strict: false }, { extends: "./base.json" }) });
    expect(record.status).toBe("pass");
    expect(record.findings).toEqual([]);
  });

  it("fails on a file the range adds that is not JSON", async () => {
    const record = await run({}, { [TSCONFIG]: "not json" });
    expect(record.status).toBe("fail");
    expect(record.evidence[0]).toMatch(/^tsconfig\.json:.*candidate/);
  });

  it("judges a file the range deletes against a file that sets nothing", async () => {
    const record = await run({ [TSCONFIG]: config({ strict: true }, { extends: "./base.json" }) }, { [TSCONFIG]: null });
    expect(ids(record)).toContain("strictness-lowered:tsconfig.json:strict");
    expect(ids(record)).toContain("extends-changed:tsconfig.json:extends");
  });

  it("fails on a file the range deletes that is not JSON", async () => {
    const record = await run({ [TSCONFIG]: "[1]" }, { [TSCONFIG]: null });
    expect(record.status).toBe("fail");
    expect(record.evidence[0]).toMatch(/^tsconfig\.json:.*merge base/);
  });

  it("passes a rename with the options as they were", async () => {
    const text = config({ strict: true, noImplicitAny: true });
    const record = await run({ [TSCONFIG]: text }, { [TSCONFIG]: null, "tsconfig.build.json": text });
    expect(record.status).toBe("pass");
  });

  it("compares a rename between tsconfig names at both ends", async () => {
    const record = await run(
      { [TSCONFIG]: config({ strict: true, noImplicitAny: true, target: "es2022" }) },
      { [TSCONFIG]: null, "tsconfig.build.json": config({ strict: false, noImplicitAny: true, target: "es2022" }) },
    );
    expect(ids(record)).toContain("strictness-lowered:tsconfig.build.json:strict");
    expect(ids(record)).not.toContain("strictness-lowered:tsconfig.build.json:noImplicitAny");
  });

  it("treats a rename from a non-tsconfig name as an add, and to one as a delete", async () => {
    const text = config({ strict: true });
    const added = await run({ "settings.json": text }, { "settings.json": null, [TSCONFIG]: text });
    expect(added.findings).toEqual([]);
    expect(added.status).toBe("pass");
  });

  it("treats a rename to a non-tsconfig name as a delete", async () => {
    const text = config({ strict: true });
    const record = await run({ [TSCONFIG]: text }, { [TSCONFIG]: null, "settings.json": text });
    expect(ids(record)).toContain("strictness-lowered:tsconfig.json:strict");
  });

  it("reads files below the root, tsconfig.build.json and jsconfig.json", async () => {
    const record = await run(
      { [NESTED]: config({ strict: true }), "tsconfig.build.json": config({ strict: true }), "jsconfig.json": config({ strict: true }) },
      { [NESTED]: config({ strict: false }), "tsconfig.build.json": config({ strict: false }), "jsconfig.json": config({ strict: false }) },
    );
    const strict = ids(record).filter((id) => id.endsWith(":strict")).sort();
    expect(strict).toEqual(["strictness-lowered:jsconfig.json:strict", "strictness-lowered:packages/app/tsconfig.json:strict", "strictness-lowered:tsconfig.build.json:strict"]);
  });

  it("reads comments, a trailing comma and comment characters inside a string", async () => {
    const before = `{
  // a comment
  "compilerOptions": {
    /* block */ "strict": true,
    "paths": { "@/*": ["src/*"], },
    "outDir": "a//b",
  },
}
`;
    const after = before.replace('"strict": true', '"strict": false');
    const record = await run({ [TSCONFIG]: before }, { [TSCONFIG]: after });
    expect(ids(record)).toContain("strictness-lowered:tsconfig.json:strict");
    expect(record.evidence.every((line) => !/not JSON/.test(line))).toBe(true);
  });

  it("fails on a file that is not an object or whose compilerOptions is not", async () => {
    const changed = await run({ [TSCONFIG]: config({ strict: true }) }, { [TSCONFIG]: "{ nope" });
    expect(changed.status).toBe("fail");
    expect(changed.evidence[0]).toMatch(/^tsconfig\.json:.*candidate/);
  });

  it("fails on a compilerOptions that is not an object at the merge base", async () => {
    const record = await run({ [TSCONFIG]: '{"compilerOptions": 3}' }, { [TSCONFIG]: config({ strict: true }) });
    expect(record.status).toBe("fail");
    expect(record.evidence[0]).toMatch(/^tsconfig\.json:.*merge base/);
  });

  it("is not passed by a sanction when a file cannot be read", async () => {
    const record = await run({ [TSCONFIG]: config({}) }, { [TSCONFIG]: "[]" }, { sanctions: { "strictness-lowered:tsconfig.json": "ok" } });
    expect(record.status).toBe("fail");
  });

  it("reports a change of extends, not following it", async () => {
    const record = await run({ [TSCONFIG]: config({}, { extends: "./a.json" }) }, { [TSCONFIG]: config({}, { extends: "./b.json" }) });
    expect(ids(record)).toEqual(["extends-changed:tsconfig.json:extends"]);
    expect(record.evidence[0]).toMatch(/^tsconfig\.json:.*extends changed.*"\.\/a\.json".*"\.\/b\.json"/);
  });

  it("sanctions by line, by category and file, by option, and by the caller", async () => {
    const files = [{ [TSCONFIG]: config({ strict: true }) }, { [TSCONFIG]: config({ strict: false }) }] as const;
    const byId = await run(files[0], files[1], { message: `change\n\n${SANCTION_KEY}: strictness-lowered:tsconfig.json:strict testing only` });
    expect(byId.status).toBe("fail");
    await rm(repo, { recursive: true, force: true });
    repo = await mkdtemp(join(tmpdir(), "repo-truth-strictness-"));
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
    const all = await run(files[0], files[1], { message: `change\n\n${SANCTION_KEY}: strictness-lowered:tsconfig.json relaxed for now` });
    expect(all.status).toBe("pass");
    expect(all.evidence[0]).toMatch(/sanctioned.*relaxed for now/);
  });

  it("sanctions by the caller and ignores a sanction written in a file", async () => {
    const files = [{ [TSCONFIG]: config({ strict: true }) }, { [TSCONFIG]: config({ strict: false }) }] as const;
    const given = await run(files[0], files[1], { sanctions: { "strictness-lowered:tsconfig.json:strict": "caller says so" } });
    const strictOnly = given.findings.find((f) => f.option === "strict");
    expect(strictOnly?.sanction).toBe("caller says so");
    expect(given.status).toBe("fail");
  });

  it("ignores a sanction written in a file", async () => {
    const record = await run(
      { [TSCONFIG]: config({ strict: true }) },
      { [TSCONFIG]: config({ strict: false }), "NOTES.md": `${SANCTION_KEY}: strictness-lowered:tsconfig.json:strict nope\n` },
    );
    expect(record.status).toBe("fail");
  });

  it("applies an entry appended to STRICT_OPTIONS", async () => {
    STRICT_OPTIONS.push({ name: "allowUnreachableCode", strict: false, fromStrict: false });
    try {
      const record = await run({ [TSCONFIG]: config({ allowUnreachableCode: false }) }, { [TSCONFIG]: config({ allowUnreachableCode: true }) });
      expect(ids(record)).toEqual(["strictness-lowered:tsconfig.json:allowUnreachableCode"]);
    } finally {
      STRICT_OPTIONS.pop();
    }
  });

  it("escapes characters outside printable ASCII in a finding", async () => {
    const path = "café/tsconfig.json";
    const record = await run({ [path]: config({ strict: true }) }, { [path]: config({ strict: false }) });
    expect(record.evidence[0]).toMatch(/^caf\\u\{00e9\}\/tsconfig\.json:/);
    expect(/^[\x20-\x7e]*$/.test(record.evidence[0] ?? "")).toBe(true);
  });

  it("fails closed on a revision that names no commit", async () => {
    await commit(repo, { "keep.txt": "keep\n" }, "base");
    const record = await check({ cwd: repo, base: "no-such-revision", candidate: "HEAD" });
    expect(record.name).toBe("RT-34");
    expect(record.status).toBe("fail");
    expect(record.evidence.join("\n")).toContain("no-such-revision");
  });

  it("fails closed when git cannot run in the directory", async () => {
    const record = await check({ cwd: join(repo, "missing"), base: "HEAD", candidate: "HEAD" });
    expect(record.status).toBe("fail");
    expect(record.evidence.length).toBeGreaterThan(0);
  });

  it("is the only record `repo-truth check --check RT-34` prints", async () => {
    await commit(repo, { [TSCONFIG]: config({ strict: true }) }, "base");
    await commit(repo, { [TSCONFIG]: config({ strict: false }) }, "change");
    let stdout = "";
    const code = await main(["check", "--check", "RT-34", "--no-fetch", "--base", "HEAD~1", "--candidate", "main", "--format", "json"], {
      cwd: repo,
      stdout: (t) => void (stdout += t),
      stderr: () => undefined,
    });
    expect(code).not.toBe(0);
    const parsed = JSON.parse(stdout) as unknown;
    const records = (Array.isArray(parsed) ? parsed : (parsed as { records: unknown[] }).records) as { name: string }[];
    expect(records.map((r) => r.name)).toEqual(["RT-34"]);
  });
});

const FAR = "HEAD~9";
const BOM = "﻿";

describe("RT-34 compiler strictness lowered, as the compiler reads a tsconfig", () => {
  let repo: string;
  let made: string[];

  async function fresh(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "repo-truth-strictness-"));
    made.push(dir);
    await git(dir, ["init", "--quiet", "--initial-branch=main"]);
    return dir;
  }

  beforeEach(async () => {
    made = [];
    repo = await fresh();
  });

  afterEach(async () => {
    for (const dir of made) await rm(dir, { recursive: true, force: true });
  });

  const STRICT_ID = "strictness-lowered:tsconfig.json:strict";
  const NULLS_ID = "strictness-lowered:tsconfig.json:strictNullChecks";
  const ids = (record: { findings: readonly { id: string }[] }): string[] => record.findings.map((f) => f.id);

  /** A merge base that holds strict and a candidate that holds `text`. */
  async function judge(text: string, baseText = config({ strict: true })) {
    const base = await commit(repo, { "keep.txt": "keep\n", [TSCONFIG]: baseText }, "base");
    const candidate = await commit(repo, { [TSCONFIG]: text }, "change");
    return check({ cwd: repo, base, candidate });
  }

  const read = (compilerOptions: string): string => `{ "compilerOptions": { ${compilerOptions} } }\n`;

  async function expectRead(text: string, baseText?: string): Promise<void> {
    const record = await judge(text, baseText);
    expect(record.evidence.join("\n")).not.toMatch(/not JSON/);
    expect(ids(record)).toContain(STRICT_ID);
    repo = await fresh();
  }

  async function expectUnreadable(text: string): Promise<void> {
    const record = await judge(text);
    expect(record.status).toBe("fail");
    expect(record.evidence[0]).toMatch(/^tsconfig\.json: at the candidate the file is not JSON/);
    repo = await fresh();
  }

  it("carries git's own complaint for a directory that is not a repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "repo-truth-strictness-plain-"));
    made.push(dir);
    const record = await check({ cwd: dir, base: "HEAD", candidate: "HEAD" });
    expect(record.status).toBe("fail");
    const text = record.evidence.join("\n");
    expect(text).toMatch(/not a git repository/i);
    expect(text).not.toContain("Command failed");
  });

  it("refuses a revision that is empty or begins with a minus sign, before git runs", async () => {
    await commit(repo, { "keep.txt": "keep\n" }, "base");
    for (const revision of ["", "-", "-x", "--all"]) {
      for (const side of ["base", "candidate"] as const) {
        const options = side === "base" ? { base: revision, candidate: "HEAD" } : { base: "HEAD", candidate: revision };
        const record = await check({ cwd: repo, ...options });
        expect(record.status).toBe("fail");
        expect(record.evidence).toEqual([`revision "${revision}" does not name a commit`]);
      }
    }
  });

  it("resolves a revision one character long that names a commit", async () => {
    const base = await commit(repo, { "keep.txt": "keep\n", [TSCONFIG]: config({ strict: true }) }, "base");
    await commit(repo, { [TSCONFIG]: config({ strict: false }) }, "change");
    const record = await check({ cwd: repo, base, candidate: "@" });
    expect(ids(record)).toContain(STRICT_ID);
    const same = await check({ cwd: repo, base: "@", candidate: "@" });
    expect(same.status).toBe("pass");
    expect(same.evidence).toEqual(["no strict option lowered"]);
  });

  it("prints a tilde as it is in a revision that names no commit", async () => {
    await commit(repo, { "keep.txt": "keep\n" }, "base");
    await commit(repo, { "keep.txt": "again\n" }, "next");
    const record = await check({ cwd: repo, base: FAR, candidate: "HEAD" });
    expect(record.status).toBe("fail");
    expect(record.evidence[0]).toContain(`revision "${FAR}" does not name a commit`);
  });

  it("reads a file that opens with a byte order mark as the same file without it", async () => {
    await expectRead(BOM + config({ strict: false }));
    await expectRead(config({ strict: false }), BOM + config({ strict: true }));
  });

  it("reads a string that holds a backslash escape whole", async () => {
    await expectRead(read(String.raw`"outDir": "a\"b", "strict": false`));
    await expectRead(read(String.raw`"outDir": "a\\", "strict": false`));
    await expectRead(read(String.raw`"outDir": "a\\\"", "strict": false`));
    await expectRead(read(String.raw`"outDir": "// \\", "strict": false`));
  });

  it("ends a block comment that begins with a slash only at a */ after its opening", async () => {
    await expectRead(read(`"strict": false /*/ off */`));
    await expectRead(read(`/*/ off */ "strict": false`));
  });

  it("does not take a slash that opens no comment for a comment opener", async () => {
    await expectUnreadable("{} / x */");
    await expectUnreadable(read(`"strict": false / x */`));
    await expectUnreadable(read(`"strict": false /`));
  });

  it("fails on a block comment that is never closed, naming the file", async () => {
    const record = await judge(read(`"strict": false /* never closed`));
    expect(record.status).toBe("fail");
    expect(record.evidence[0]).toMatch(/^tsconfig\.json:/);
    expect(record.evidence[0]).toContain("unterminated comment");
  });

  it("keeps the parts of a value apart across a comment or a blank", async () => {
    await expectUnreadable(read(`"strict": tr/* x */ue`));
    await expectUnreadable(read(`"strict": tr// x\nue`));
    await expectUnreadable(read(`"strict": tr ue`));
    await expectUnreadable(read(`"strict": tr\tue`));
    await expectUnreadable(read(`"strict": tr\nue`));
    await expectUnreadable(read(`"strict": tr\rue`));
  });

  it("allows a comma before the bracket that closes an array, as before a brace", async () => {
    await expectRead(read(`"lib": ["a", "b",], "strict": false`));
    await expectRead(read(`"lib": ["a", /* c */ ], "strict": false`));
    await expectRead(read(`"lib": ["a", // c\n ], "strict": false`));
    await expectRead(read(`"strict": false, `));
    await expectRead(`{ "compilerOptions": { "strict": false, }, }\n`);
  });

  it("keeps the commas between the objects of an array", async () => {
    await expectRead(`{ "references": [{ "path": "a" }, { "path": "b" }], "compilerOptions": { "strict": false } }\n`);
    await expectRead(`{ "references": [{ "path": "a" }, { "path": "b" },], "compilerOptions": { "strict": false } }\n`);
    await expectRead(`{ "references": [[1], [2]], "compilerOptions": { "strict": false } }\n`);
    await expectUnreadable(`{ "references": [{ "path": "a" } { "path": "b" }], "compilerOptions": { "strict": false } }\n`);
  });

  it("refuses a tsconfig that is a symbolic link at the candidate", async () => {
    const base = await commit(repo, { "keep.txt": "keep\n", [TSCONFIG]: config({ strict: true }) }, "base");
    await rm(join(repo, TSCONFIG));
    await symlink("keep.txt", join(repo, TSCONFIG));
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "--quiet", "-m", "link"]);
    const record = await check({ cwd: repo, base, candidate: "HEAD" });
    expect(record.status).toBe("fail");
    expect(record.evidence[0]).toBe("tsconfig.json: at the candidate the file is not a regular file");
  });

  it("refuses a tsconfig that is a symbolic link at the merge base", async () => {
    await symlink("keep.txt", join(repo, TSCONFIG));
    const base = await commit(repo, { "keep.txt": "keep\n" }, "base");
    await rm(join(repo, TSCONFIG));
    const candidate = await commit(repo, { [TSCONFIG]: config({ strict: true }) }, "file");
    const record = await check({ cwd: repo, base, candidate });
    expect(record.status).toBe("fail");
    expect(record.evidence[0]).toBe("tsconfig.json: at the merge base the file is not a regular file");
  });

  describe("sanctions", () => {
    async function lowerOne(sanctions: Record<string, string>, message = "change") {
      const dir = await fresh();
      const base = await commit(dir, { "keep.txt": "keep\n", [TSCONFIG]: config({ strict: true }) }, "base");
      const candidate = await commit(dir, { [TSCONFIG]: config({ strict: true, strictNullChecks: false }) }, message);
      return check({ cwd: dir, base, candidate, sanctions });
    }

    it("sanctions nothing by a reason from the caller that is empty or only blanks", async () => {
      for (const reason of ["", " ", "   ", "\t", "\n"]) {
        for (const key of [NULLS_ID, "strictness-lowered:tsconfig.json"]) {
          const record = await lowerOne({ [key]: reason });
          expect(record.status).toBe("fail");
          expect(ids(record)).toEqual([NULLS_ID]);
          expect(record.findings[0]?.sanction).toBeNull();
        }
      }
    });

    it("sanctions a finding by a reason from the caller that is one character long", async () => {
      const record = await lowerOne({ [NULLS_ID]: "y" });
      expect(record.status).toBe("pass");
      expect(record.findings[0]?.sanction).toBe("y");
      expect(record.evidence).toEqual(["tsconfig.json: lowered strictNullChecks: true -> false - sanctioned: y"]);
    });

    it("passes a range whose one finding is sanctioned by a line in a commit message", async () => {
      const record = await lowerOne({}, `change\n\n${SANCTION_KEY}: ${NULLS_ID} y`);
      expect(record.status).toBe("pass");
      expect(record.findings[0]?.sanction).toBe("y");
    });

    it("passes a range sanctioned by a category and file line in a commit message", async () => {
      const record = await lowerOne({}, `change\n\n${SANCTION_KEY}:   strictness-lowered:tsconfig.json   relaxed for now  `);
      expect(record.status).toBe("pass");
      expect(record.findings[0]?.sanction).toBe("relaxed for now");
    });

    it("leaves a finding open when the line gives no reason", async () => {
      const record = await lowerOne({}, `change\n\n${SANCTION_KEY}: ${NULLS_ID}`);
      expect(record.status).toBe("fail");
      expect(record.findings[0]?.sanction).toBeNull();
    });
  });
});
