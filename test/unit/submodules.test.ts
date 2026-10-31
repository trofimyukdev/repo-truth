import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as module from "../../src/checks/submodules.js";
import { check, name } from "../../src/checks/submodules.js";

const execFileAsync = promisify(execFile);

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "Test Committer",
  GIT_COMMITTER_EMAIL: "committer@example.com",
};

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const PASS = "no submodule added or moved, and no submodule URL changed";

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args as string[], { cwd, env: ENV });
  return stdout.trim();
}

describe("RT-87 submodules added or moved", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "repo-truth-submodules-"));
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  /** Replace the entry at `path` with a gitlink, or with nothing when `sha` is null, and write files. */
  async function commit(message: string, links: Record<string, string | null> = {}, files: Record<string, string> = {}): Promise<string> {
    for (const [file, content] of Object.entries(files)) {
      await writeFile(join(repo, file), content);
    }
    await git(repo, ["add", "-A"]);
    for (const [path, sha] of Object.entries(links)) {
      await git(repo, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", path]);
      if (sha !== null) await git(repo, ["update-index", "--add", "--cacheinfo", `160000,${sha},${path}`]);
    }
    await git(repo, ["commit", "--quiet", "--allow-empty", "-m", message]);
    return git(repo, ["rev-parse", "HEAD"]);
  }

  async function range(
    before: Parameters<typeof commit>[1],
    after: Parameters<typeof commit>[1],
    extra: { message?: string; sanctions?: Record<string, string>; beforeFiles?: Record<string, string>; afterFiles?: Record<string, string> } = {},
  ) {
    const base = await commit("base", before, { "keep.txt": "keep\n", ...extra.beforeFiles });
    const candidate = await commit(extra.message ?? "change", after, extra.afterFiles);
    return check({ cwd: repo, base, candidate, sanctions: extra.sanctions });
  }

  const passed = { name, status: "pass", evidence: [PASS], findings: [] };

  it("is named RT-87 and declares no options", () => {
    expect(name).toBe("RT-87");
    expect("optionKinds" in module).toBe(false);
  });

  it("passes a range that touches no submodule", async () => {
    expect(await range({}, {}, { afterFiles: { "other.txt": "x\n" } })).toEqual(passed);
  });

  it("fails a gitlink added at a new path", async () => {
    const record = await range({}, { "lib/dep": A });
    expect(record.status).toBe("fail");
    expect(record.evidence).toEqual([`lib/dep: submodule-added ${A}`]);
    expect(record.findings).toEqual([
      { id: "submodule-added:lib/dep", category: "submodule-added", path: "lib/dep", detail: A, sanction: null },
    ]);
  });

  it("fails a gitlink that replaces a file", async () => {
    const record = await range({}, { "keep.txt": A });
    expect(record.status).toBe("fail");
    expect(record.evidence).toEqual([`keep.txt: submodule-added ${A}`]);
  });

  it("fails a gitlink that moves to another commit", async () => {
    const record = await range({ "lib/dep": A }, { "lib/dep": B });
    expect(record.status).toBe("fail");
    expect(record.evidence).toEqual([`lib/dep: submodule-moved ${A} -> ${B}`]);
  });

  it("passes a gitlink the range removes", async () => {
    expect(await range({ "lib/dep": A }, { "lib/dep": null })).toEqual(passed);
  });

  it("passes a gitlink left at its commit", async () => {
    expect(await range({ "lib/dep": A }, {}, { afterFiles: { "other.txt": "x\n" } })).toEqual(passed);
  });

  it("fails a .gitmodules added with a url", async () => {
    const record = await range({}, {}, { afterFiles: { ".gitmodules": '[submodule "dep"]\n\tpath = lib/dep\n\turl = https://example.com/dep.git\n' } });
    expect(record.status).toBe("fail");
    expect(record.evidence).toEqual([".gitmodules: submodule-url https://example.com/dep.git"]);
    expect(record.findings.map((finding) => finding.id)).toEqual(["submodule-url:.gitmodules"]);
  });

  it("fails a .gitmodules whose url changes", async () => {
    const record = await range(
      {},
      {},
      {
        beforeFiles: { ".gitmodules": '[submodule "dep"]\n\tpath = lib/dep\n\turl = https://example.com/dep.git\n' },
        afterFiles: { ".gitmodules": '[submodule "dep"]\n\tpath = lib/dep\n\turl = https://example.org/other.git\n' },
      },
    );
    expect(record.status).toBe("fail");
    expect(record.evidence).toEqual([".gitmodules: submodule-url https://example.org/other.git"]);
  });

  it("passes a .gitmodules change that adds no url", async () => {
    const record = await range(
      {},
      {},
      {
        beforeFiles: { ".gitmodules": '[submodule "dep"]\n\tpath = lib/dep\n\turl = https://example.com/dep.git\n' },
        afterFiles: { ".gitmodules": '[submodule "dep"]\n\tpath = lib/other\n\turl = https://example.com/dep.git\n\tbranch = main\n' },
      },
    );
    expect(record).toEqual(passed);
  });

  it("passes a finding sanctioned by a commit message line", async () => {
    const record = await range({}, { "lib/dep": A }, { message: `add dep\n\n${"Sanctioned-Weakening"}: submodule-added:lib/dep vendored on purpose\n` });
    expect(record.status).toBe("pass");
    expect(record.evidence).toEqual([`lib/dep: submodule-added ${A} - sanctioned: vendored on purpose`]);
  });

  it("passes a finding sanctioned by the caller", async () => {
    const record = await range({ "lib/dep": A }, { "lib/dep": B }, { sanctions: { "submodule-moved:lib/dep": "bumped" } });
    expect(record.status).toBe("pass");
    expect(record.evidence).toEqual([`lib/dep: submodule-moved ${A} -> ${B} - sanctioned: bumped`]);
  });

  it("sanctions a url by the id of the file", async () => {
    const record = await range({}, {}, {
      afterFiles: { ".gitmodules": '[submodule "dep"]\n\turl = https://example.com/dep.git\n' },
      sanctions: { "submodule-url:.gitmodules": "mirror" },
    });
    expect(record.status).toBe("pass");
    expect(record.evidence).toEqual([".gitmodules: submodule-url https://example.com/dep.git - sanctioned: mirror"]);
  });

  it.each(["submodule-added:lib/other why", "submodule-moved:lib/dep why", "submodule-added:lib/dep"])(
    "fails a finding when the line is %j",
    async (line) => {
      const record = await range({}, { "lib/dep": A }, { message: `add\n\nSanctioned-Weakening: ${line}\n` });
      expect(record.status).toBe("fail");
      expect(record.evidence).toEqual([`lib/dep: submodule-added ${A}`]);
    },
  );

  it("is not quieted by diff.ignoreSubmodules or submodule.<name>.ignore set to all", async () => {
    await git(repo, ["config", "diff.ignoreSubmodules", "all"]);
    await git(repo, ["config", "submodule.dep.ignore", "all"]);
    const record = await range({ "lib/dep": A }, { "lib/dep": B, "lib/new": C }, {
      beforeFiles: { ".gitmodules": '[submodule "dep"]\n\tpath = lib/dep\n\turl = https://example.com/dep.git\n\tignore = all\n' },
    });
    expect(record.status).toBe("fail");
    expect(record.evidence).toEqual([`lib/dep: submodule-moved ${A} -> ${B}`, `lib/new: submodule-added ${C}`]);
  });

  it("reads the range from the merge base, not from the base tip", async () => {
    await commit("root", { "lib/dep": A }, { "keep.txt": "keep\n" });
    await git(repo, ["checkout", "--quiet", "-b", "feature"]);
    const candidate = await commit("feature", { "lib/dep": C });
    await git(repo, ["checkout", "--quiet", "main"]);
    const base = await commit("main moves", { "lib/dep": B });
    const record = await check({ cwd: repo, base, candidate });
    expect(record.status).toBe("fail");
    expect(record.evidence).toEqual([`lib/dep: submodule-moved ${A} -> ${C}`]);
  });

  it("fails a revision that names no commit, and does not throw", async () => {
    const base = await commit("base");
    const record = await check({ cwd: repo, base, candidate: "no-such-revision" });
    expect(record.status).toBe("fail");
    expect(record.evidence).toHaveLength(1);
    expect(record.evidence[0]).toContain("no-such-revision");
    expect(record.findings).toEqual([]);
  });
});
