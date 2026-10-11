import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readFigureClaims } from "../../src/figure-claims.js";

const execFileAsync = promisify(execFile);

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "Test Committer",
  GIT_COMMITTER_EMAIL: "committer@example.com",
};

const COMMAND = "git rev-list --count HEAD";

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args as string[], { cwd, env: ENV });
  return stdout.trim();
}

async function commit(cwd: string, files: Record<string, string>, message = "change"): Promise<string> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, name)), { recursive: true });
    await writeFile(join(cwd, name), content);
  }
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "--quiet", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

/** Rename `from` to `to`, giving it `content`, and commit. */
async function renameWith(cwd: string, from: string, to: string, content: string): Promise<string> {
  await git(cwd, ["mv", from, to]);
  return commit(cwd, { [to]: content }, "rename");
}

const claim = (out: string) => `Run \`${COMMAND}\` and it printed \`${out}\`.\n`;
const LONG = Array.from({ length: 12 }, (_, i) => `Filler line number ${i} of the page.\n`).join("");

describe("readFigureClaims", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "repo-truth-figure-claims-"));
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const read = (base: string, candidate: string) => readFigureClaims({ cwd: repo, base, candidate });

  it("claims a figure in a page the range adds", async () => {
    const base = await commit(repo, { "a.txt": "x\n" });
    const head = await commit(repo, { "docs/p.md": `intro\n\n${claim("7")}` });
    expect(await read(base, head)).toEqual({
      claims: [{ where: "docs/p.md:3", command: COMMAND, claimed: "7" }],
    });
  });

  it("claims when the command is a line the base held and the output a line the range adds", async () => {
    const base = await commit(repo, { "p.md": `Run \`${COMMAND}\` and it\n` });
    const head = await commit(repo, { "p.md": `Run \`${COMMAND}\` and it\nprinted \`9\`.\n` });
    expect(await read(base, head)).toEqual({ claims: [{ where: "p.md:2", command: COMMAND, claimed: "9" }] });
  });

  it("does not claim a figure whose output line the base already held", async () => {
    const base = await commit(repo, { "p.md": claim("7") });
    const head = await commit(repo, { "p.md": `${claim("7")}\nmore\n` });
    expect(await read(base, head)).toEqual({ claims: [] });
  });

  it("adds no claim for a page the range only renames", async () => {
    const base = await commit(repo, { "old.md": claim("7") + LONG });
    const head = await renameWith(repo, "old.md", "new.md", claim("7") + LONG);
    expect(await read(base, head)).toEqual({ claims: [] });
  });

  it("adds only the claims an edit adds to a renamed page", async () => {
    const base = await commit(repo, { "old.md": claim("7") + LONG });
    const head = await renameWith(repo, "old.md", "new.md", `${claim("7")}${LONG}\n${claim("8")}`);
    expect(await read(base, head)).toEqual({ claims: [{ where: "new.md:15", command: COMMAND, claimed: "8" }] });
  });

  it("claims a changed output of a claim a renamed page held", async () => {
    const base = await commit(repo, { "old.md": claim("7") + LONG });
    const head = await renameWith(repo, "old.md", "new.md", claim("8") + LONG);
    expect(await read(base, head)).toEqual({ claims: [{ where: "new.md:1", command: COMMAND, claimed: "8" }] });
  });

  it("compares a page renamed from a non-.md file with that file", async () => {
    const base = await commit(repo, { "old.txt": claim("7") + LONG });
    const head = await renameWith(repo, "old.txt", "new.md", `${claim("7")}${LONG}\n${claim("8")}`);
    expect(await read(base, head)).toEqual({ claims: [{ where: "new.md:15", command: COMMAND, claimed: "8" }] });
  });

  it("ignores a file whose name does not end in .md", async () => {
    const base = await commit(repo, { "a.txt": "x\n" });
    const head = await commit(repo, { "notes.txt": claim("7"), "p.md.bak": claim("7") });
    expect(await read(base, head)).toEqual({ claims: [] });
  });

  it("reads claims in commit bodies of the range only", async () => {
    await commit(repo, { "a.txt": "x\n" }, `old\n\n${claim("1")}`);
    const base = await git(repo, ["rev-parse", "HEAD"]);
    const head = await commit(repo, { "b.txt": "y\n" }, `new\n\n${claim("2")}`);
    expect(await read(base, head)).toEqual({ claims: [{ where: head, command: COMMAND, claimed: "2" }] });
  });

  it("reads from the merge base when the base is not an ancestor", async () => {
    await commit(repo, { "p.md": claim("7") });
    await git(repo, ["checkout", "--quiet", "-b", "side"]);
    const head = await commit(repo, { "q.md": claim("3") });
    await git(repo, ["checkout", "--quiet", "main"]);
    const other = await commit(repo, { "p.md": claim("9") });
    expect(await read(other, head)).toEqual({ claims: [{ where: "q.md:1", command: COMMAND, claimed: "3" }] });
  });

  it("reads the candidate, not the working tree", async () => {
    const base = await commit(repo, { "a.txt": "x\n" });
    const head = await commit(repo, { "p.md": claim("7") });
    await writeFile(join(repo, "p.md"), claim("99"));
    expect(await read(base, head)).toEqual({ claims: [{ where: "p.md:1", command: COMMAND, claimed: "7" }] });
  });

  it("reads a page whose name a shell would act on", async () => {
    const base = await commit(repo, { "a.txt": "x\n" });
    const name = "$(touch pwned) `x`; a b.md";
    const head = await commit(repo, { [name]: claim("7") });
    expect(await read(base, head)).toEqual({ claims: [{ where: `${name}:1`, command: COMMAND, claimed: "7" }] });
  });

  it("fails, naming the revision, when it names no commit", async () => {
    const head = await commit(repo, { "a.txt": "x\n" });
    const result = await read("nonexistent-rev", head);
    expect(result).toEqual({ failure: expect.stringContaining("nonexistent-rev") });
    expect("claims" in result).toBe(false);
    expect(await read(head, "--output=x")).toEqual({ failure: expect.stringContaining("--output=x") });
  });

  it("fails rather than throwing when git cannot run", async () => {
    const result = await readFigureClaims({ cwd: join(repo, "missing"), base: "a", candidate: "b" });
    expect("failure" in result).toBe(true);
  });
});
