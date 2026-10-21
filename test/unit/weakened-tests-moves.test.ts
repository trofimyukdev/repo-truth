import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkWeakenedTests } from "../../src/weakened-tests.js";

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

const SKIPPED = 'it.skip("parses the header", () => {});';

const BEFORE = [
  'import { expect, it } from "vitest";',
  "",
  SKIPPED,
  "",
  'it("adds", () => {',
  "  expect(1 + 1).toBe(2);",
  "});",
  "",
  'it("subtracts", () => {',
  "  expect(2 - 1).toBe(1);",
  "});",
  "",
].join("\n");

const MOVED = [
  'import { expect, it } from "vitest";',
  "",
  'it("adds", () => {',
  "  expect(1 + 1).toBe(2);",
  "});",
  "",
  'it("subtracts", () => {',
  "  expect(2 - 1).toBe(1);",
  "});",
  "",
  SKIPPED,
  "",
].join("\n");

describe("checkWeakenedTests, a skip line moved while a document gains it", () => {
  let repo: string;
  let base: string;

  async function put(path: string, content: string): Promise<void> {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  }

  async function commit(message: string): Promise<string> {
    await git(repo, ["add", "--all"]);
    await git(repo, ["commit", "--quiet", "--allow-empty", "-m", message]);
    return git(repo, ["rev-parse", "HEAD"]);
  }

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "repo-truth-weakened-moves-"));
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
    await put("test/math.test.ts", BEFORE);
    await put("docs/notes.md", "# Notes\n");
    base = await commit("initial");
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const run = () => checkWeakenedTests({ cwd: repo, base, candidate: "HEAD" });

  it("yields no skip finding when the document is listed before the test file", async () => {
    await put("test/math.test.ts", MOVED);
    await put("docs/notes.md", `# Notes\n\n${SKIPPED}\n`);
    await commit("move the skip line, quote it in the notes");
    const record = await run();
    expect(record.findings.filter((finding) => finding.category === "skip")).toEqual([]);
    expect(record.findings).toEqual([]);
    expect(record.status).toBe("pass");
  });

  it("still reports a second copy of the skip line added to the test file itself", async () => {
    await put("test/math.test.ts", `${MOVED}${SKIPPED}\n`);
    await put("docs/notes.md", `# Notes\n\n${SKIPPED}\n`);
    await commit("move the line and add another copy");
    const record = await run();
    const skips = record.findings.filter((finding) => finding.category === "skip");
    expect(skips).toHaveLength(1);
    expect(skips[0]?.file).toBe("test/math.test.ts");
    expect(skips[0]?.side).toBe("candidate");
    expect(skips[0]?.detail).toContain("parses the header");
    expect(record.status).toBe("fail");
  });

  it("still reports a skip line added to the test file when the document gains it and nothing moves", async () => {
    await put("test/math.test.ts", `${BEFORE}${SKIPPED}\n`);
    await put("docs/notes.md", `# Notes\n\n${SKIPPED}\n`);
    await commit("add a copy");
    const record = await run();
    const skips = record.findings.filter((finding) => finding.category === "skip");
    expect(skips).toHaveLength(1);
    expect(skips[0]?.file).toBe("test/math.test.ts");
    expect(record.status).toBe("fail");
  });
});
