import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { STRAY_SHAPES, checkStrayFiles } from "../../src/stray-files.js";

const execFileAsync = promisify(execFile);

const ID_PREFIX = 12;
const GLOBAL_MATCHES = 2;

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

async function commitFiles(cwd: string, names: readonly string[]): Promise<string> {
  for (const name of names) {
    await mkdir(dirname(join(cwd, name)), { recursive: true });
    await writeFile(join(cwd, name), `${name}\n`);
  }
  await git(cwd, ["add", "-f", "--", ...names]);
  await git(cwd, ["commit", "--quiet", "-m", "add files"]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

describe("checkStrayFiles", () => {
  let repo: string;
  let base: string;
  const extraDirs: string[] = [];

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "repo-truth-stray-files-"));
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
    base = await commitFiles(repo, ["README.md", "src/config.ts"]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    for (const dir of extraDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("passes a range of ordinary files", async () => {
    const candidate = await commitFiles(repo, ["src/main.ts", "docs/guide.md"]);
    const record = await checkStrayFiles({ cwd: repo, base, candidate });
    expect(record.name).toBe("RT-05");
    expect(record.status).toBe("pass");
  });

  it.each([
    ["debug.log", "log-file"],
    ["src/config.ts.bak", "editor-backup"],
    ["src/index 2.ts", "set-aside-copy"],
    ["coverage/lcov.info", "coverage-output"],
    ["dist/main.js", "build-output"],
    ["build/out.js", "build-output"],
  ])("reports %s by shape %s", async (path, shape) => {
    expect(STRAY_SHAPES.map((s) => s.name)).toContain(shape);
    const candidate = await commitFiles(repo, [path]);
    const record = await checkStrayFiles({ cwd: repo, base, candidate });
    expect(record.status).toBe("fail");
    expect(record.evidence.some((line) => line.includes(path) && line.includes(shape))).toBe(true);
    expect(record.evidence.some((line) => line.includes("ignore rules"))).toBe(false);
  });

  it("applies a shape appended to the exported list", async () => {
    const candidate = await commitFiles(repo, ["notes.todo"]);
    expect((await checkStrayFiles({ cwd: repo, base, candidate })).status).toBe("pass");
    const added = { name: "todo-file", description: "test shape", pattern: /\.todo$/g };
    STRAY_SHAPES.push(added);
    try {
      const record = await checkStrayFiles({ cwd: repo, base, candidate });
      expect(record.status).toBe("fail");
      expect(record.evidence[0]).toContain("todo-file");
    } finally {
      STRAY_SHAPES.splice(STRAY_SHAPES.indexOf(added), 1);
    }
  });

  it("states every shape in the list completely", () => {
    for (const shape of STRAY_SHAPES) {
      expect(shape.pattern).toBeInstanceOf(RegExp);
      expect(shape.name.length).toBeGreaterThan(0);
      expect(shape.description.length).toBeGreaterThan(0);
    }
  });

  it("does not report a rename or a modification", async () => {
    await writeFile(join(repo, "src/config.ts"), "changed\n");
    await git(repo, ["commit", "--quiet", "-am", "modify"]);
    await mkdir(join(repo, "lib"), { recursive: true });
    await git(repo, ["mv", "README.md", "lib/README.md"]);
    await git(repo, ["commit", "--quiet", "-m", "rename"]);
    const candidate = await git(repo, ["rev-parse", "HEAD"]);
    const record = await checkStrayFiles({ cwd: repo, base, candidate });
    expect(record.status).toBe("pass");
  });

  it("does not read the working tree", async () => {
    const candidate = await commitFiles(repo, ["src/main.ts"]);
    await writeFile(join(repo, "local.log"), "x\n");
    const record = await checkStrayFiles({ cwd: repo, base, candidate });
    expect(record.status).toBe("pass");
  });

  it("reports an added path the ignore rules exclude as its own category", async () => {
    await writeFile(join(repo, ".gitignore"), "*.secret\n");
    await git(repo, ["add", ".gitignore"]);
    await git(repo, ["commit", "--quiet", "-m", "ignore"]);
    const ruled = await git(repo, ["rev-parse", "HEAD"]);
    const candidate = await commitFiles(repo, ["keys.secret"]);
    const record = await checkStrayFiles({ cwd: repo, base: ruled, candidate });
    expect(record.status).toBe("fail");
    expect(record.evidence).toHaveLength(1);
    expect(record.evidence[0]).toContain("keys.secret");
    expect(record.evidence[0]).toContain("ignore rules");
  });

  it("reports both categories for one path that matches both", async () => {
    await writeFile(join(repo, ".gitignore"), "*.log\n");
    await git(repo, ["add", ".gitignore"]);
    await git(repo, ["commit", "--quiet", "-m", "ignore"]);
    const ruled = await git(repo, ["rev-parse", "HEAD"]);
    const candidate = await commitFiles(repo, ["a.log"]);
    const record = await checkStrayFiles({ cwd: repo, base: ruled, candidate });
    expect(record.evidence).toHaveLength(2);
    expect(record.evidence.some((l) => l.includes("log-file"))).toBe(true);
    expect(record.evidence.some((l) => l.includes("ignore rules"))).toBe(true);
  });

  it("fails closed on a revision that names no commit", async () => {
    const record = await checkStrayFiles({ cwd: repo, base: "no-such-rev", candidate: "HEAD" });
    expect(record.status).toBe("fail");
    expect(record.evidence.join("\n")).toContain("no-such-rev");
  });

  it("fails closed when git cannot run in the directory", async () => {
    const record = await checkStrayFiles({ cwd: join(repo, "missing"), base: "HEAD", candidate: "HEAD" });
    expect(record.status).toBe("fail");
    expect(record.evidence.length).toBeGreaterThan(0);
  });

  it("carries git's own complaint for a directory that is not a repository", async () => {
    const plain = await mkdtemp(join(tmpdir(), "repo-truth-stray-plain-"));
    extraDirs.push(plain);
    const record = await checkStrayFiles({ cwd: plain, base: "HEAD", candidate: "HEAD" });
    expect(record.status).toBe("fail");
    const text = record.evidence.join("\n");
    expect(text).toContain("not a git repository");
    expect(text).not.toContain("Command failed");
  });

  it("names the git command when a revision cannot be found", async () => {
    const record = await checkStrayFiles({ cwd: repo, base: "no-such-branch", candidate: "HEAD" });
    expect(record.status).toBe("fail");
    expect(record.evidence).toHaveLength(1);
    expect(record.evidence[0]?.startsWith('revision "no-such-branch" names no commit: ')).toBe(true);
    expect(record.evidence[0]).toContain("no-such-branch^{commit}");
  });

  it.each([
    ["", "HEAD", ""],
    ["-x", "HEAD", "-x"],
    ["HEAD", "", ""],
    ["HEAD", "-x", "-x"],
  ])("refuses revisions %j and %j before git runs", async (a, b, bad) => {
    const record = await checkStrayFiles({ cwd: repo, base: a, candidate: b });
    expect(record.status).toBe("fail");
    expect(record.evidence).toEqual([`revision "${bad}" names no commit`]);
  });

  it("refuses an empty revision even where git cannot run", async () => {
    const record = await checkStrayFiles({ cwd: join(repo, "missing"), base: "", candidate: "HEAD" });
    expect(record.evidence).toEqual(['revision "" names no commit']);
  });

  it("resolves a revision one character long that names a commit", async () => {
    const stray = await commitFiles(repo, ["debug.log"]);
    const failing = await checkStrayFiles({ cwd: repo, base, candidate: "@" });
    expect(failing.status).toBe("fail");
    expect(failing.evidence.some((line) => line.includes("debug.log") && line.includes("log-file"))).toBe(true);
    const passing = await checkStrayFiles({ cwd: repo, base: "@", candidate: stray });
    expect(passing.status).toBe("pass");
  });

  it("names two commits that share no history", async () => {
    await git(repo, ["checkout", "--quiet", "--orphan", "unrelated"]);
    await git(repo, ["rm", "-rf", "--quiet", "."]);
    const orphan = await commitFiles(repo, ["other.md"]);
    const record = await checkStrayFiles({ cwd: repo, base, candidate: orphan });
    expect(record.status).toBe("fail");
    expect(record.evidence).toHaveLength(1);
    const prefix = `no merge base of ${base.slice(0, ID_PREFIX)} and ${orphan.slice(0, ID_PREFIX)}: `;
    expect(record.evidence[0]?.startsWith(prefix)).toBe(true);
    expect(record.evidence[0]).toContain("git merge-base");
  });

  it("escapes characters outside printable ASCII and keeps a tilde", async () => {
    const candidate = await commitFiles(repo, ["café.log", "tab\there.log", "notes.txt~"]);
    const record = await checkStrayFiles({ cwd: repo, base, candidate });
    expect(record.status).toBe("fail");
    expect(record.evidence.some((l) => l.startsWith('"caf\\u{00e9}.log" matches stray shape "log-file"'))).toBe(true);
    expect(record.evidence.some((l) => l.startsWith('"tab\\u{0009}here.log" matches'))).toBe(true);
    expect(record.evidence.some((l) => l.startsWith('"notes.txt~" matches stray shape "editor-backup"'))).toBe(true);
  });

  it("reports every path a global anchored shape matches", async () => {
    const candidate = await commitFiles(repo, ["zzz-one.txt", "zzz-two.txt", "other.txt"]);
    const added = { name: "zzz-file", description: "test shape", pattern: /^zzz/g };
    STRAY_SHAPES.push(added);
    try {
      const record = await checkStrayFiles({ cwd: repo, base, candidate });
      expect(record.status).toBe("fail");
      const hits = record.evidence.filter((l) => l.includes('"zzz-file"'));
      expect(hits).toHaveLength(GLOBAL_MATCHES);
      expect(hits.some((l) => l.includes("zzz-one.txt"))).toBe(true);
      expect(hits.some((l) => l.includes("zzz-two.txt"))).toBe(true);
    } finally {
      STRAY_SHAPES.splice(STRAY_SHAPES.indexOf(added), 1);
    }
  });
});
