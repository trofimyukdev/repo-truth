import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TASK_ID_PATTERN, TASK_TRAILER_KEY, checkTrailers } from "../../src/trailers.js";

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

let counter = 0;
async function commit(cwd: string, message: string): Promise<string> {
  counter += 1;
  await writeFile(join(cwd, `f${counter}.txt`), `${counter}\n`);
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "--quiet", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

describe("checkTrailers", () => {
  let repo: string;
  let base: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "repo-truth-trailers-"));
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
    base = await commit(repo, "initial");
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const run = (candidate = "HEAD") => checkTrailers({ cwd: repo, base, candidate });

  it("exports the key and the id shape", () => {
    expect(TASK_TRAILER_KEY).toBe("Task-Id");
    expect(TASK_ID_PATTERN.test("RT-03")).toBe(true);
    expect(TASK_ID_PATTERN.test("RT03")).toBe(false);
    expect(TASK_ID_PATTERN.test("3-03")).toBe(false);
    expect(TASK_ID_PATTERN.test("RT-")).toBe(false);
  });

  it("passes an empty range", async () => {
    const record = await run();
    expect(record.name).toBe("RT-03");
    expect(record.status).toBe("pass");
  });

  it("passes one trailered landing over several intermediate commits", async () => {
    await commit(repo, "wip one");
    await commit(repo, "fix two");
    await commit(repo, "feat: done\n\nbody\n\nTask-Id: RT-03");
    expect((await run()).status).toBe("pass");
  });

  it("fails a landing with no trailer, naming sha, subject and the words", async () => {
    await commit(repo, "wip\n\nTask-Id: RT-03");
    const landing = await commit(repo, "feat: landing");
    const record = await run();
    expect(record.status).toBe("fail");
    const text = record.evidence.join("\n");
    expect(text).toContain(landing.slice(0, 12));
    expect(text).toContain("feat: landing");
    expect(text).toContain("no Task-Id trailer");
  });

  it("does not count a task id in prose", async () => {
    await commit(repo, "feat: landing\n\nThis closes Task-Id: RT-03 as discussed.\n\nMore prose.");
    const record = await run();
    expect(record.status).toBe("fail");
    expect(record.evidence.join("\n")).toContain("no Task-Id trailer");
  });

  it("reads a block that follows prose", async () => {
    await commit(repo, "feat: landing\n\nprose\n\nSigned-off-by: A <a@b.c>\nTask-Id: RT-03\n");
    expect((await run()).status).toBe("pass");
  });

  it("reads a folded value", async () => {
    await commit(repo, "feat: landing\n\nTask-Id: RT-03\nNote: one\n two");
    expect((await run()).status).toBe("pass");
  });

  it("fails a message with no blank line before its trailer", async () => {
    await commit(repo, "feat: landing\nTask-Id: RT-03");
    expect((await run()).status).toBe("fail");
  });

  it("reports a malformed value as does not parse, not as absent", async () => {
    await commit(repo, "feat: landing\n\nTask-Id: nonsense");
    const record = await run();
    expect(record.status).toBe("fail");
    const text = record.evidence.join("\n");
    expect(text).toContain("nonsense");
    expect(text).toContain("does not parse");
    expect(text).not.toContain("no Task-Id trailer");
  });

  it("reports an empty value as does not parse", async () => {
    await commit(repo, "feat: landing\n\nTask-Id:\nOther: x");
    const record = await run();
    expect(record.status).toBe("fail");
    const text = record.evidence.join("\n");
    expect(text).toContain("does not parse");
    expect(text).not.toContain("no Task-Id trailer");
  });

  it("fails closed on an unknown candidate", async () => {
    const record = await run("no-such-rev");
    expect(record.status).toBe("fail");
    expect(record.evidence.join("\n")).toContain("no-such-rev");
  });

  it("fails closed on an unknown base", async () => {
    const record = await checkTrailers({ cwd: repo, base: "nope-base", candidate: "HEAD" });
    expect(record.status).toBe("fail");
    expect(record.evidence.join("\n")).toContain("nope-base");
  });

  it("fails closed outside a repository", async () => {
    const record = await checkTrailers({ cwd: tmpdir(), base: "a", candidate: "b" });
    expect(record.status).toBe("fail");
  });
});
