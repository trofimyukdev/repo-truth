import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import { checkWeakenedTests } from "../../src/weakened-tests.js";

const execFileAsync = promisify(execFile);
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "a@example.com",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "c@example.com",
};
const roots: string[] = [];

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, env: ENV });
}

async function run(path: string, before: string, after: string): Promise<string[]> {
  const cwd = await mkdtemp(join(tmpdir(), "rt04-strings-"));
  roots.push(cwd);
  await git(cwd, ["init", "-q"]);
  const put = async (text: string): Promise<void> => {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), text);
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-q", "-m", "c"]);
  };
  await put(before);
  await git(cwd, ["tag", "base"]);
  await put(after);
  return (await checkWeakenedTests({ cwd, base: "base", candidate: "HEAD" })).findings.map((f) => f.category);
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const F = "a.test.ts";
const BASE = "const x = 1;\n";

describe("markers inside string literals", () => {
  it.each([
    ["single", `const S = 'it.skip("a", () => {});';`],
    ["double", `const S = "it.only('a', () => {});";`],
    ["template", "const S = `it.skip(\"a\");`;"],
    ["escaped quote", `const S = 'it\\'s it.skip("a")';`],
    ["beside another string", `const S = ['x', 'it.skip("a")'];`],
  ])("%s is no finding", async (_name, line) => {
    expect(await run(F, BASE, BASE + line + "\n")).toEqual([]);
  });
});

describe("markers written as code", () => {
  it.each([
    ["beside a string", `it.skip("a", () => {}); const s = 'x';`, ["skip"]],
    ["after a string", `const s = 'x'; it.only("a", () => {});`, ["only"]],
    ["unclosed quote", `it.skip("a"); const t = 'oops`, ["skip"]],
    ["between comments", `/* ' */ it.skip("a"); /* " */`, ["skip"]],
  ])("%s is a finding", async (_name, line, expected) => {
    expect(await run(F, BASE, BASE + line + "\n")).toEqual(expected);
  });
});

describe("other cases", () => {
  it("reads a config file as before", async () => {
    expect(await run("vitest.config.ts", BASE, BASE + `  "testNamePattern": "x",\n`)).toEqual(["only"]);
  });
  it("a moved code marker is no finding", async () => {
    const marker = `it.skip("a", () => {});\n`;
    expect(await run(F, marker + BASE, BASE + marker)).toEqual([]);
  });
  it("code replacing text is a finding", async () => {
    expect(await run(F, `const S = 'it.skip("a")';\n`, `it.skip("a");\n`)).toEqual(["skip"]);
  });
});
