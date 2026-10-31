import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SECRET_FILE_NAMES, check, name } from "../../src/checks/secret-files.js";
import * as module from "../../src/checks/secret-files.js";

const execFileAsync = promisify(execFile);

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "Test Committer",
  GIT_COMMITTER_EMAIL: "committer@example.com",
};

const BODY = "SETTING=plainword\nOTHER=anotherword\n";
const NONE = ["no secret file added or changed"];

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args as string[], { cwd, env: ENV });
  return stdout.trim();
}

async function commit(cwd: string, files: Record<string, string | null>, message = "change"): Promise<string> {
  for (const [file, content] of Object.entries(files)) {
    if (content === null) await rm(join(cwd, file), { force: true });
    else {
      await mkdir(dirname(join(cwd, file)), { recursive: true });
      await rm(join(cwd, file), { force: true });
      await writeFile(join(cwd, file), content);
    }
  }
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "--quiet", "--allow-empty", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

const SHIPPED = [
  ".env",
  ".env.local",
  ".env.production",
  ".netrc",
  "_netrc",
  ".pgpass",
  ".git-credentials",
  ".htpasswd",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "terraform.tfstate",
  "prod.tfstate.backup",
];

const LEFT_ALONE = [".env.example", ".env.sample", ".env.template", ".env.dist", ".env.local.example", "id_rsa.pub", ".ENV", "env", "my.env", ".envrc"];

describe("RT-89 secret files", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "repo-truth-secret-files-"));
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function run(before: Record<string, string | null>, after: Record<string, string | null>, extra: { message?: string; sanctions?: Record<string, string> } = {}) {
    const base = await commit(repo, { "keep.txt": "keep\n", ...before }, "base");
    const candidate = await commit(repo, after, extra.message ?? "change");
    const record = await check({ cwd: repo, base, candidate, sanctions: extra.sanctions });
    expect(JSON.stringify(record)).not.toContain("plainword");
    expect(JSON.stringify(record)).not.toContain("anotherword");
    return record;
  }

  it("is a module of the check directory with no options", () => {
    expect(name).toBe("RT-89");
    expect("optionKinds" in module).toBe(false);
    expect(Array.isArray(SECRET_FILE_NAMES)).toBe(true);
  });

  for (const file of SHIPPED) {
    for (const path of [file, `deep/er/${file}`]) {
      it(`fails a range that adds ${path}`, async () => {
        const record = await run({}, { [path]: BODY });
        expect(record).toEqual({
          name: "RT-89",
          status: "fail",
          evidence: [`${path}: secret-file-added`],
          findings: [{ id: `secret-file-added:${path}`, category: "secret-file-added", path, from: null, sanction: null }],
        });
      });
    }
  }

  it("fails a range that modifies a .env", async () => {
    const record = await run({ "app/.env": BODY }, { "app/.env": "SETTING=otherword\n" });
    expect(record.status).toBe("fail");
    expect(record.evidence).toEqual(["app/.env: secret-file-changed"]);
  });

  it("passes names it leaves alone", async () => {
    const files: Record<string, string> = {};
    for (const file of LEFT_ALONE) files[file] = BODY;
    const record = await run({}, files);
    expect(record).toEqual({ name: "RT-89", status: "pass", evidence: NONE, findings: [] });
  });

  it("passes an empty range", async () => {
    const record = await run({}, {});
    expect(record).toEqual({ name: "RT-89", status: "pass", evidence: NONE, findings: [] });
  });

  it("reports a rename onto a matching name with its source", async () => {
    const record = await run({ "config.txt": BODY.repeat(5) }, { "config.txt": null, ".env": BODY.repeat(5) });
    expect(record.status).toBe("fail");
    expect(record.evidence).toEqual([".env: secret-file-added from config.txt"]);
  });

  it("reports a copy onto a matching name as added", async () => {
    const record = await run({ "config.txt": BODY.repeat(5) }, { ".env": BODY.repeat(5) });
    expect(record.status).toBe("fail");
    expect(record.evidence).toHaveLength(1);
    expect(record.evidence[0]?.startsWith(".env: secret-file-added")).toBe(true);
  });

  it("reports a symbolic link turned into a .env as added", async () => {
    const base = await commit(repo, { "keep.txt": "keep\n" }, "base");
    await symlink("keep.txt", join(repo, ".env"));
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "--quiet", "-m", "link"]);
    const candidate = await commit(repo, { ".env": BODY });
    const record = await check({ cwd: repo, base, candidate });
    expect(record.evidence).toEqual([".env: secret-file-added"]);
    const linkOnly = await check({ cwd: repo, base, candidate: await git(repo, ["rev-parse", "HEAD~1"]) });
    expect(linkOnly).toEqual({ name: "RT-89", status: "pass", evidence: NONE, findings: [] });
  });

  it("does not report a deleted .env or one renamed away", async () => {
    const deleted = await run({ ".env": BODY }, { ".env": null });
    expect(deleted.status).toBe("pass");
    expect(deleted.evidence).toEqual(NONE);
  });

  it("does not report a .env renamed to a name that does not match", async () => {
    const record = await run({ ".env": BODY.repeat(5) }, { ".env": null, "settings.txt": BODY.repeat(5) });
    expect(record).toEqual({ name: "RT-89", status: "pass", evidence: NONE, findings: [] });
  });

  it("reads SECRET_FILE_NAMES on every run", async () => {
    const entry = /^vault\.key$/;
    SECRET_FILE_NAMES.push(entry);
    try {
      const record = await run({}, { "x/vault.key": BODY });
      expect(record.evidence).toEqual(["x/vault.key: secret-file-added"]);
    } finally {
      SECRET_FILE_NAMES.splice(SECRET_FILE_NAMES.indexOf(entry), 1);
    }
  });

  it("is sanctioned by a commit message line", async () => {
    const record = await run({}, { ".env": BODY }, { message: "add\n\nSanctioned-Weakening: secret-file-added:.env fixture values only" });
    expect(record.status).toBe("pass");
    expect(record.evidence).toEqual([".env: secret-file-added - sanctioned: fixture values only"]);
  });

  it("is sanctioned by the caller", async () => {
    const record = await run({}, { ".env": BODY }, { sanctions: { "secret-file-added:.env": "reviewed" } });
    expect(record.status).toBe("pass");
    expect(record.evidence).toEqual([".env: secret-file-added - sanctioned: reviewed"]);
  });

  it("is not sanctioned by another path, another category or a missing reason", async () => {
    for (const message of [
      "add\n\nSanctioned-Weakening: secret-file-added:other/.env reason",
      "add\n\nSanctioned-Weakening: secret-file-changed:.env reason",
      "add\n\nSanctioned-Weakening: secret-file-added:.env",
    ]) {
      const record = await run({}, { [`n${message.length}/.env`]: BODY, ".env": BODY }, { message });
      expect(record.status).toBe("fail");
    }
  });

  it("ignores a file the other side added after the merge base", async () => {
    await commit(repo, { "keep.txt": "keep\n" }, "root");
    const fork = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["checkout", "--quiet", "-b", "other"]);
    await commit(repo, { ".env": BODY }, "other side");
    const base = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["checkout", "--quiet", "-b", "mine", fork]);
    const candidate = await commit(repo, { "mine.txt": "mine\n" }, "mine");
    const record = await check({ cwd: repo, base, candidate });
    expect(record).toEqual({ name: "RT-89", status: "pass", evidence: NONE, findings: [] });
  });

  it("fails on a revision that names no commit", async () => {
    await commit(repo, { "keep.txt": "keep\n" }, "base");
    const record = await check({ cwd: repo, base: "no-such-revision", candidate: "HEAD" });
    expect(record.status).toBe("fail");
    expect(record.evidence).toHaveLength(1);
    expect(record.evidence[0]).toContain("no-such-revision");
    expect(record.findings).toEqual([]);
  });
});
