import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkPortablePaths } from "../../src/portable-paths.js";

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

/** Write each file, add it, and commit; returns the new HEAD. */
async function commitFiles(cwd: string, names: readonly string[], message = "add files"): Promise<string> {
  for (const name of names) {
    await mkdir(dirname(join(cwd, name)), { recursive: true });
    await writeFile(join(cwd, name), `${name}\n`);
  }
  await git(cwd, ["add", "--", ...names]);
  await git(cwd, ["commit", "--quiet", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

describe("checkPortablePaths", () => {
  let repo: string;
  let base: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "repo-truth-portable-paths-"));
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
    await git(repo, ["config", "core.ignorecase", "false"]);
    base = await commitFiles(repo, ["README.md", "docs/guide.md"], "initial commit");
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("passes a range whose names are portable", async () => {
    const candidate = await commitFiles(repo, ["src/main.ts", "auxiliary.ts", "com10.txt", "a.b.c"]);

    const record = await checkPortablePaths({ cwd: repo, base, candidate });

    expect(record.name).toBe("RT-10");
    expect(record.status).toBe("pass");
  });

  it("passes an empty range", async () => {
    const record = await checkPortablePaths({ cwd: repo, base, candidate: base });

    expect(record.status).toBe("pass");
  });

  it("fails an added file that differs in case from a file the base holds", async () => {
    const candidate = await commitFiles(repo, ["Readme.md"]);

    const record = await checkPortablePaths({ cwd: repo, base, candidate });

    expect(record.status).toBe("fail");
    expect(record.evidence).toHaveLength(1);
    expect(record.evidence[0]).toContain("Readme.md");
    expect(record.evidence[0]).toContain("README.md");
    expect(record.evidence[0]).toContain("[case]");
  });

  it("fails two added files that differ only in case", async () => {
    const candidate = await commitFiles(repo, ["lib/Util.ts", "lib/util.ts"]);

    const record = await checkPortablePaths({ cwd: repo, base, candidate });

    expect(record.status).toBe("fail");
    expect(record.evidence).toHaveLength(1);
    expect(record.evidence[0]).toContain("lib/Util.ts");
    expect(record.evidence[0]).toContain("lib/util.ts");
  });

  it("fails a directory that differs only in case from a directory the base holds", async () => {
    const candidate = await commitFiles(repo, ["Docs/a.md"]);

    const record = await checkPortablePaths({ cwd: repo, base, candidate });

    expect(record.status).toBe("fail");
    expect(record.evidence).toHaveLength(1);
    expect(record.evidence[0]).toContain('"Docs"');
    expect(record.evidence[0]).toContain('"docs"');
    expect(record.evidence[0]).toContain("[case]");
  });

  it.each([
    ["aux.ts", "aux.ts"],
    ["nul.tar.gz", "nul.tar.gz"],
    ["CON", "CON"],
    ["Com1.txt", "Com1.txt"],
    ["src/lpt9.log", "src/lpt9.log"],
  ])("fails the reserved device name %s", async (file, shown) => {
    const candidate = await commitFiles(repo, [file]);

    const record = await checkPortablePaths({ cwd: repo, base, candidate });

    expect(record.status).toBe("fail");
    expect(record.evidence).toHaveLength(1);
    expect(record.evidence[0]).toContain(shown);
    expect(record.evidence[0]).toContain("[reserved]");
  });

  it("fails a directory called con", async () => {
    const candidate = await commitFiles(repo, ["con/readme.txt"]);

    const record = await checkPortablePaths({ cwd: repo, base, candidate });

    expect(record.status).toBe("fail");
    expect(record.evidence).toHaveLength(1);
    expect(record.evidence[0]).toContain('"con"');
    expect(record.evidence[0]).toContain("[reserved]");
  });

  it("fails a name that ends in a dot or a space", async () => {
    const candidate = await commitFiles(repo, ["notes.", "draft.txt "]);

    const record = await checkPortablePaths({ cwd: repo, base, candidate });

    expect(record.status).toBe("fail");
    expect(record.evidence).toHaveLength(2);
    for (const line of record.evidence) {
      expect(line).toContain("[trailing]");
    }
    expect(record.evidence.join("\n")).toContain('"notes."');
    expect(record.evidence.join("\n")).toContain('"draft.txt "');
  });

  it.each(["a<b", "a>b", "a:b", 'a"b', "a\\b", "a|b", "a?b", "a*b"])(
    "fails the forbidden character in %s",
    async (file) => {
      const candidate = await commitFiles(repo, [file]);

      const record = await checkPortablePaths({ cwd: repo, base, candidate });

      expect(record.status).toBe("fail");
      expect(record.evidence).toHaveLength(1);
      expect(record.evidence[0]).toContain("[character]");
    },
  );

  it("escapes a control character instead of replaying it", async () => {
    const candidate = await commitFiles(repo, ["bell\u0007\u001b[31mred.txt"]);

    const record = await checkPortablePaths({ cwd: repo, base, candidate });

    expect(record.status).toBe("fail");
    const text = record.evidence.join("\n");
    expect(text).toContain("[character]");
    expect(text).toContain("\\u{0007}");
    expect(text).toContain("\\u{001b}");
    expect(text).toMatch(/^[\n\x20-\x7e]*$/);
  });

  it("escapes a non-ASCII spelling in a case finding", async () => {
    const candidate = await commitFiles(repo, ["É.md", "é.md"]);

    const record = await checkPortablePaths({ cwd: repo, base, candidate });

    expect(record.status).toBe("fail");
    expect(record.evidence[0]).toContain("\\u{00c9}.md");
    expect(record.evidence[0]).toContain("\\u{00e9}.md");
    expect(record.evidence[0]).toMatch(/^[\x20-\x7e]*$/);
  });

  it("judges the destination of a rename as a name the range introduces", async () => {
    await git(repo, ["mv", "docs/guide.md", "docs/aux.md"]);
    await git(repo, ["commit", "--quiet", "-m", "rename"]);
    const candidate = await git(repo, ["rev-parse", "HEAD"]);

    const record = await checkPortablePaths({ cwd: repo, base, candidate });

    expect(record.status).toBe("fail");
    expect(record.evidence).toHaveLength(1);
    expect(record.evidence[0]).toContain("docs/aux.md");
    expect(record.evidence[0]).toContain("[reserved]");
  });

  it("fails a rename whose destination collides in case with a name the base holds", async () => {
    await git(repo, ["mv", "docs/guide.md", "readme.md"]);
    await git(repo, ["commit", "--quiet", "-m", "rename"]);
    const candidate = await git(repo, ["rev-parse", "HEAD"]);

    const record = await checkPortablePaths({ cwd: repo, base, candidate });

    expect(record.status).toBe("fail");
    expect(record.evidence.join("\n")).toContain("[case]");
  });

  it("leaves alone a reserved name and a case pair the base already holds", async () => {
    const heldBase = await commitFiles(repo, ["aux.ts", "con/x.txt", "trail.", "Notes.md", "notes.md"], "legacy");
    const candidate = await commitFiles(repo, ["src/fine.ts"]);

    const record = await checkPortablePaths({ cwd: repo, base: heldBase, candidate });

    expect(record.status).toBe("pass");
  });

  it("reports a new spelling added beside a case pair the base already holds", async () => {
    const heldBase = await commitFiles(repo, ["Notes.md", "notes.md"], "legacy");
    const candidate = await commitFiles(repo, ["NOTES.md"]);

    const record = await checkPortablePaths({ cwd: repo, base: heldBase, candidate });

    expect(record.status).toBe("fail");
    expect(record.evidence).toHaveLength(1);
    expect(record.evidence[0]).toContain("NOTES.md");
    expect(record.evidence[0]).toContain("Notes.md");
    expect(record.evidence[0]).toContain("notes.md");
  });

  it("reads the trees from git, not from the working tree", async () => {
    const candidate = await commitFiles(repo, ["src/ok.ts"]);
    await writeFile(join(repo, "aux.ts"), "untracked\n");
    await writeFile(join(repo, "Readme.md"), "untracked\n");

    const record = await checkPortablePaths({ cwd: repo, base, candidate });

    expect(record.status).toBe("pass");
  });

  it("measures from the merge base when the base has moved on", async () => {
    await git(repo, ["checkout", "--quiet", "-b", "feature"]);
    const candidate = await commitFiles(repo, ["feature.ts"]);
    await git(repo, ["checkout", "--quiet", "main"]);
    const moved = await commitFiles(repo, ["aux.ts"], "main moves on");

    const record = await checkPortablePaths({ cwd: repo, base: moved, candidate });

    expect(record.status).toBe("pass");
  });

  it("fails closed on a revision that names no commit", async () => {
    const record = await checkPortablePaths({ cwd: repo, base: "no-such-revision", candidate: base });

    expect(record.name).toBe("RT-10");
    expect(record.status).toBe("fail");
    expect(record.evidence.join("\n")).toContain("no-such-revision");
  });

  it("fails closed on a candidate that names no commit, and on an empty or option-like revision", async () => {
    for (const bad of ["missing-candidate", "", "--all"]) {
      const record = await checkPortablePaths({ cwd: repo, base, candidate: bad });

      expect(record.status).toBe("fail");
      expect(record.evidence.join("\n")).toContain("names no commit");
    }
  });

  it("fails closed, without throwing, when git itself cannot run in the directory", async () => {
    const record = await checkPortablePaths({ cwd: join(repo, "does-not-exist"), base, candidate: base });

    expect(record.name).toBe("RT-10");
    expect(record.status).toBe("fail");
    expect(record.evidence.length).toBeGreaterThan(0);
  });

  it("fails closed when the two revisions share no history", async () => {
    await git(repo, ["checkout", "--quiet", "--orphan", "other"]);
    const candidate = await commitFiles(repo, ["other.ts"], "unrelated");

    const record = await checkPortablePaths({ cwd: repo, base, candidate });

    expect(record.status).toBe("fail");
    expect(record.evidence.join("\n")).toContain("merge base");
  });
});
