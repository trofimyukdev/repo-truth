import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as mod from "../../src/checks/workflow-permissions.js";
import { check, name } from "../../src/checks/workflow-permissions.js";

const execFileAsync = promisify(execFile);

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "Test Committer",
  GIT_COMMITTER_EMAIL: "committer@example.com",
};

type Files = Record<string, string | null>;

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args as string[], { cwd, env: ENV });
  return stdout.trim();
}

async function commit(cwd: string, files: Files, message = "change"): Promise<string> {
  for (const [file, content] of Object.entries(files)) {
    if (content === null) await rm(join(cwd, file));
    else {
      await mkdir(dirname(join(cwd, file)), { recursive: true });
      await writeFile(join(cwd, file), content);
    }
  }
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "--quiet", "--allow-empty", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

const W = ".github/workflows/ci.yml";
const body = (...extra: string[]): string =>
  ["name: ci", "on: push", "jobs:", "  test:", "    runs-on: ubuntu-latest", "    steps:", "      - run: npm test", ...extra, ""].join("\n");

const SCOPES = [
  "actions", "attestations", "checks", "contents", "deployments", "discussions", "id-token", "issues",
  "models", "packages", "pages", "pull-requests", "repository-projects", "security-events", "statuses",
];
const PASS = { name: "RT-91", status: "pass", evidence: ["no workflow permission raised"] };

describe("RT-91 raised workflow permissions", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "repo-truth-workflow-permissions-"));
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function run(
    before: Files,
    after: Files,
    extra: { message?: string; sanctions?: Record<string, string> } = {},
  ) {
    const base = await commit(repo, { "keep.txt": "keep\n", ...before }, "base");
    const candidate = await commit(repo, after, extra.message ?? "change");
    return check({ cwd: repo, base, candidate, sanctions: extra.sanctions });
  }

  const added = (line: string) => run({ [W]: body() }, { [W]: body(line) });
  const addedAll = (lines: string[]) => run({ [W]: body() }, { [W]: body(...lines.map((line) => `  ${line}`)) });
  const failingAll = (category: string, texts: string[]) => ({
    name: "RT-91",
    status: "fail",
    evidence: texts.map((text) => `${W}: ${category} "${text}"`).sort(),
  });
  const sorted = <T extends { evidence: readonly string[] }>(record: T) => ({ ...record, evidence: [...record.evidence].sort() });
  const failing = (category: string, text: string, file = W) => ({
    name: "RT-91",
    status: "fail",
    evidence: [`${file}: ${category} "${text}"`],
  });

  it("exports its name and check, and no optionKinds", () => {
    expect(name).toBe("RT-91");
    expect(typeof check).toBe("function");
    expect("optionKinds" in mod).toBe(false);
  });

  it("fails permissions: write-all, plain, quoted, commented, as a list item", async () => {
    const texts = [
      "permissions: write-all",
      'permissions: "write-all"',
      "permissions: 'write-all'",
      "permissions : write-all",
      "permissions: write-all # all of it",
      "- permissions: write-all",
    ];
    expect(sorted(await addedAll(texts))).toEqual(failingAll("write-all", texts));
  });

  it("fails a write scope for each of the fifteen scopes, in every spelling", async () => {
    const texts = SCOPES.flatMap((scope) => [
      `${scope}: write`,
      `${scope}: "write"`,
      `${scope}: 'write'`,
      `${scope} : write`,
      `${scope}: write # why`,
      `- ${scope}: write`,
      `permissions: { ${scope}: write }`,
      `permissions: {${scope}: "write", issues: read}`,
      `- permissions: { ${scope}: 'write' } # note`,
    ]);
    const record = await run({ [W]: body() }, { [W]: body(...texts.map((text) => `  ${text}`)) });
    expect(record.status).toBe("fail");
    expect([...record.evidence].sort()).toEqual(texts.map((text) => `${W}: write-permission "${text}"`).sort());
  });

  it("fails each pull_request_target form", async () => {
    const texts = [
      "pull_request_target:",
      "pull_request_target: # trigger",
      "pull_request_target: { types: [opened] }",
      "- pull_request_target",
      '- "pull_request_target"',
      "on: pull_request_target",
      "on: 'pull_request_target'",
      "on: [push, pull_request_target]",
      'on: ["push", "pull_request_target"] # both',
    ];
    expect(sorted(await addedAll(texts))).toEqual(failingAll("pull-request-target", texts));
  });

  it("passes what is not a finding", async () => {
    expect(await addedAll([
      "permissions: read-all",
      "permissions: {}",
      "permissions: { contents: read }",
      "permissions: { contents: none }",
      "contents: read",
      "contents: none",
      "unknown-scope: write",
      "permissions: { unknown-scope: write }",
      "pull_request:",
      "on: pull_request",
      "on: [push, pull_request]",
      "- workflow_run",
      "workflow_run:",
      "# contents: write",
      "# pull_request_target:",
      "# permissions: write-all",
      "- run: echo pull_request_target",
      "- run: echo permissions write-all contents: write",
      "run: echo 'contents: write'",
      "- name: contents: write",
    ])).toEqual(PASS);
  });

  it("reads only files directly in .github/workflows", async () => {
    const text = "permissions: write-all\n";
    expect(await run({}, { "ci.yml": text, "other/ci.yaml": text, ".github/ci.yml": text, ".github/workflows/sub/ci.yml": text, ".github/workflows/ci.txt": text })).toEqual(PASS);
  });

  it("reads a .yaml workflow", async () => {
    const file = ".github/workflows/deploy.yaml";
    expect(await run({}, { [file]: "on: push\npermissions: write-all\n" })).toEqual(failing("write-all", "permissions: write-all", file));
  });

  it("does not count a line the merge base already holds, moved or re-indented", async () => {
    const before = body("permissions:", "  contents: write", "  pull_request_target:");
    const after = ["name: ci", "on: push", "permissions:", "      contents: write", "pull_request_target:", "jobs:", "  test:", "    runs-on: x", ""].join("\n");
    expect(await run({ [W]: before }, { [W]: after })).toEqual(PASS);
  });

  it("counts a line held fewer times at the merge base", async () => {
    const before = body("  contents: write");
    const after = body("  contents: write", "    contents: write");
    expect(await run({ [W]: before }, { [W]: after })).toEqual(failing("write-permission", "contents: write"));
  });

  it("reports a text added twice once", async () => {
    const record = await added("  contents: write\n  contents: write");
    expect(record).toEqual(failing("write-permission", "contents: write"));
  });

  it("reads a workflow added whole", async () => {
    const file = ".github/workflows/new.yml";
    expect(await run({}, { [file]: body("pull_request_target:") })).toEqual(failing("pull-request-target", "pull_request_target:", file));
  });

  it("reads a rename against its source", async () => {
    const renamed = ".github/workflows/renamed.yml";
    const text = body("contents: write", "pull_request_target:");
    expect(await run({ [W]: text }, { [W]: null, [renamed]: text })).toEqual(PASS);
    const record = await run({ [W]: text }, { [W]: null, [renamed]: text + "permissions: write-all\n" });
    expect(record).toEqual(failing("write-all", "permissions: write-all", renamed));
  });

  it("reads a rename onto a workflow path from outside it against its source", async () => {
    const text = body("contents: write");
    expect(await run({ "old.yml": text }, { "old.yml": null, [W]: text })).toEqual(PASS);
  });

  it("passes a finding a commit message sanctions, with the reason", async () => {
    const message = `raise\n\nSanctioned-Weakening: write-permission:${W} the release job pushes tags\n`;
    expect(await run({ [W]: body() }, { [W]: body("contents: write") }, { message })).toEqual({
      name: "RT-91",
      status: "pass",
      evidence: [`${W}: write-permission "contents: write" - sanctioned: the release job pushes tags`],
    });
  });

  it("passes a finding the caller's sanctions cover", async () => {
    const sanctions = { [`pull-request-target:${W}`]: "labels only" };
    expect(await run({ [W]: body() }, { [W]: body("pull_request_target:") }, { sanctions })).toEqual({
      name: "RT-91",
      status: "pass",
      evidence: [`${W}: pull-request-target "pull_request_target:" - sanctioned: labels only`],
    });
  });

  it("is not sanctioned by another category, another file, or no reason", async () => {
    for (const line of [
      `write-all:${W} some reason`,
      `write-permission:.github/workflows/other.yml some reason`,
      `write-permission:${W}`,
      `write-permission:${W}   `,
    ]) {
      const message = `raise\n\nSanctioned-Weakening: ${line}\n`;
      const record = await run({ [W]: body() }, { [W]: body("contents: write") }, { message });
      expect(record).toEqual(failing("write-permission", "contents: write"));
    }
  });

  it("marks only the sanctioned finding of several", async () => {
    const sanctions = { [`write-permission:${W}`]: "ok" };
    const record = await run({ [W]: body() }, { [W]: body("contents: write", "permissions: write-all") }, { sanctions });
    expect(record.status).toBe("fail");
    expect([...record.evidence].sort()).toEqual(
      [`${W}: write-all "permissions: write-all"`, `${W}: write-permission "contents: write" - sanctioned: ok`].sort(),
    );
  });

  it("does not count a line the other side added after the merge base", async () => {
    const base = await commit(repo, { "keep.txt": "keep\n", [W]: body() }, "base");
    await git(repo, ["checkout", "--quiet", "-b", "side"]);
    const side = await commit(repo, { [W]: body("contents: write") }, "side");
    await git(repo, ["checkout", "--quiet", "main"]);
    const candidate = await commit(repo, { "other.txt": "x\n" }, "main work");
    expect(await check({ cwd: repo, base: side, candidate })).toEqual(PASS);
    expect(await check({ cwd: repo, base, candidate: side })).toEqual(failing("write-permission", "contents: write"));
  });

  it("never reads the working tree", async () => {
    const base = await commit(repo, { [W]: body() }, "base");
    const candidate = await commit(repo, { "a.txt": "a\n" }, "next");
    await writeFile(join(repo, W), body("permissions: write-all"));
    expect(await check({ cwd: repo, base, candidate })).toEqual(PASS);
  });

  it("fails, naming the cause, for a revision that names no commit", async () => {
    const head = await commit(repo, { "keep.txt": "keep\n" }, "base");
    for (const [base, candidate] of [["no-such-revision", head], [head, "no-such-revision"], ["--help", head], ["", head]]) {
      const record = await check({ cwd: repo, base: base as string, candidate: candidate as string });
      expect(record.name).toBe("RT-91");
      expect(record.status).toBe("fail");
      expect(record.evidence).toHaveLength(1);
      expect(record.evidence[0]).toMatch(/does not name a commit/);
    }
  });

  it("fails rather than throws when git fails", async () => {
    const record = await check({ cwd: join(repo, "missing"), base: "HEAD", candidate: "HEAD" });
    expect(record.status).toBe("fail");
    expect(record.evidence).toHaveLength(1);
  });
});
