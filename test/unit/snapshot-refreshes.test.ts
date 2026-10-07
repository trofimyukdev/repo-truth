import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { REGISTRY } from "../../src/registry.js";
import { checkSnapshotRefreshes, SNAPSHOT_PATHS } from "../../src/snapshot-refreshes.js";

const execFileAsync = promisify(execFile);

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "Test Committer",
  GIT_COMMITTER_EMAIL: "committer@example.com",
};

const BODY = "line one\nline two\nline three\nline four\nline five\n";
const CHANGED = "line one\nline two\nline THREE\nline four\nline five\n";

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args as string[], { cwd, env: ENV });
  return stdout.trim();
}

async function commit(cwd: string, files: Record<string, string | null>, message = "change"): Promise<string> {
  for (const [name, content] of Object.entries(files)) {
    if (content === null) {
      await rm(join(cwd, name));
    } else {
      await mkdir(dirname(join(cwd, name)), { recursive: true });
      await writeFile(join(cwd, name), content);
    }
  }
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "--quiet", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

describe("checkSnapshotRefreshes", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "repo-truth-snapshots-"));
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function run(
    before: Record<string, string>,
    after: Record<string, string | null>,
    extra: { message?: string; sanctions?: Record<string, string> } = {},
  ) {
    const base = await commit(repo, before, "base");
    const candidate = await commit(repo, after, extra.message ?? "change");
    return checkSnapshotRefreshes({ cwd: repo, base, candidate, sanctions: extra.sanctions });
  }

  it("passes with one line when nothing is a snapshot change", async () => {
    const record = await run({ "src/a.ts": "a\n" }, { "src/a.ts": "b\n" });
    expect(record).toEqual({ name: "RT-16", status: "pass", evidence: ["no snapshot refreshed or deleted"] });
  });

  it("does not report an added snapshot", async () => {
    const record = await run({ "a.txt": "a\n" }, { "__snapshots__/new.txt": BODY, "x.test.ts.snap": BODY, "y.ambr": BODY });
    expect(record.status).toBe("pass");
    expect(record.evidence).toEqual(["no snapshot refreshed or deleted"]);
  });

  it("fails a modified snapshot, in a commit that changed only tests", async () => {
    const record = await run({ "t/a.test.ts.snap": BODY }, { "t/a.test.ts.snap": CHANGED, "t/a.test.ts": "x\n" });
    expect(record.status).toBe("fail");
    expect(record.evidence).toHaveLength(1);
    const line = record.evidence[0] ?? "";
    expect(line.startsWith("t/a.test.ts.snap:")).toBe(true);
    expect(line).toContain("refreshed");
    expect(line).not.toContain("beside a code change");
  });

  it("says when the refreshing commit also changed code", async () => {
    const base = await commit(repo, { "a.snap": BODY, "src/a.ts": "a\n" }, "base");
    const candidate = await commit(repo, { "a.snap": CHANGED, "src/a.ts": "b\n" });
    const record = await checkSnapshotRefreshes({ cwd: repo, base, candidate });
    expect(record.status).toBe("fail");
    const line = record.evidence[0] ?? "";
    expect(line).toContain("beside a code change");
    expect(line).toContain(candidate.slice(0, 12));
  });

  it("does not blame a code commit that did not touch the snapshot", async () => {
    const base = await commit(repo, { "a.snap": BODY, "src/a.ts": "a\n" }, "base");
    await commit(repo, { "src/a.ts": "b\n" });
    const candidate = await commit(repo, { "a.snap": CHANGED });
    const record = await checkSnapshotRefreshes({ cwd: repo, base, candidate });
    expect(record.evidence[0]).not.toContain("beside a code change");
  });

  it("fails a deleted snapshot with its base path", async () => {
    const record = await run({ "__snapshots__/a.txt": BODY }, { "__snapshots__/a.txt": null });
    expect(record.status).toBe("fail");
    expect(record.evidence).toHaveLength(1);
    expect(record.evidence[0]?.startsWith("__snapshots__/a.txt:")).toBe(true);
    expect(record.evidence[0]).toContain("deleted");
  });

  it("does not report a rename with its content unchanged", async () => {
    const base = await commit(repo, { "a.snap": BODY }, "base");
    await git(repo, ["mv", "a.snap", "b.snap"]);
    const candidate = await commit(repo, {});
    const record = await checkSnapshotRefreshes({ cwd: repo, base, candidate });
    expect(record.status).toBe("pass");
  });

  it("does not report a snapshot renamed out of the snapshot shapes with its content unchanged", async () => {
    const base = await commit(repo, { "a.snap": BODY }, "base");
    await git(repo, ["mv", "a.snap", "a.txt"]);
    const candidate = await commit(repo, {});
    const record = await checkSnapshotRefreshes({ cwd: repo, base, candidate });
    expect(record.status).toBe("pass");
    expect(record.evidence[0]).toContain("no snapshot refreshed or deleted");
  });

  it("reports a rename with a change as refreshed, at the candidate path", async () => {
    const base = await commit(repo, { "a.snap": BODY }, "base");
    await git(repo, ["mv", "a.snap", "b.snap"]);
    const candidate = await commit(repo, { "b.snap": CHANGED });
    const record = await checkSnapshotRefreshes({ cwd: repo, base, candidate });
    expect(record.status).toBe("fail");
    expect(record.evidence).toHaveLength(1);
    expect(record.evidence[0]?.startsWith("b.snap:")).toBe(true);
    expect(record.evidence[0]).toContain("refreshed");
  });

  it("does not report a snapshot the base changed before the range", async () => {
    await commit(repo, { "a.snap": BODY }, "first");
    const base = await commit(repo, { "a.snap": CHANGED }, "second");
    const candidate = await commit(repo, { "src/a.ts": "a\n" });
    const record = await checkSnapshotRefreshes({ cwd: repo, base, candidate });
    expect(record.status).toBe("pass");
  });

  it("reads the range's changes, not the candidate's tree", async () => {
    const base = await commit(repo, { "a.snap": BODY }, "base");
    await commit(repo, { "a.snap": CHANGED });
    const candidate = await commit(repo, { "a.snap": BODY });
    const record = await checkSnapshotRefreshes({ cwd: repo, base, candidate });
    expect(record.status).toBe("pass");
  });

  it("holds the three shapes", async () => {
    for (const path of ["x/__snapshots__/deep/a.txt", "a.snap", "d/a.test.ts.snap", "a.ambr", "d/b.ambr"]) {
      expect(SNAPSHOT_PATHS.some((pattern) => pattern.test(path)), path).toBe(true);
    }
  });

  it("applies a shape appended to SNAPSHOT_PATHS", async () => {
    const shape = /\.golden$/;
    SNAPSHOT_PATHS.push(shape);
    try {
      const record = await run({ "out/a.golden": BODY }, { "out/a.golden": CHANGED });
      expect(record.status).toBe("fail");
      expect(record.evidence[0]).toContain("out/a.golden:");
    } finally {
      SNAPSHOT_PATHS.splice(SNAPSHOT_PATHS.indexOf(shape), 1);
    }
  });

  it("is sanctioned by a line of a commit message, and still lists the finding", async () => {
    const record = await run(
      { "a.snap": BODY },
      { "a.snap": CHANGED },
      { message: "refresh\n\nSanctioned-Weakening: snapshot-refreshed:a.snap output was meant to change" },
    );
    expect(record.status).toBe("pass");
    expect(record.evidence).toHaveLength(1);
    expect(record.evidence[0]).toContain("sanctioned");
    expect(record.evidence[0]).toContain("output was meant to change");
  });

  it("is sanctioned by the caller's option", async () => {
    const record = await run(
      { "a.snap": BODY },
      { "a.snap": null },
      { sanctions: { "snapshot-deleted:a.snap": "test removed" } },
    );
    expect(record.status).toBe("pass");
    expect(record.evidence[0]).toContain("sanctioned");
    expect(record.evidence[0]).toContain("test removed");
  });

  it("stays failed while one finding is unsanctioned", async () => {
    const record = await run(
      { "a.snap": BODY, "b.snap": BODY },
      { "a.snap": CHANGED, "b.snap": CHANGED },
      { sanctions: { "snapshot-refreshed:a.snap": "ok" } },
    );
    expect(record.status).toBe("fail");
    expect(record.evidence).toHaveLength(2);
  });

  it("escapes control characters in a path", async () => {
    const record = await run({ "a\u001b[2Jb.snap": BODY }, { "a\u001b[2Jb.snap": CHANGED });
    expect(record.evidence[0]).not.toContain("\u001b");
    expect(record.evidence[0]).toContain("\\u{001b}");
  });

  it("fails closed on a revision that names no commit", async () => {
    const base = await commit(repo, { "a.txt": "a\n" }, "base");
    const record = await checkSnapshotRefreshes({ cwd: repo, base, candidate: "no-such-revision" });
    expect(record.status).toBe("fail");
    expect(record.evidence.join("\n")).toContain("no-such-revision");
  });

  it("fails closed when git fails", async () => {
    const record = await checkSnapshotRefreshes({ cwd: join(repo, "missing"), base: "HEAD", candidate: "HEAD" });
    expect(record.status).toBe("fail");
    expect(record.evidence.length).toBeGreaterThan(0);
  });

  it("is registered as RT-16", () => {
    expect(REGISTRY.map((entry) => entry.name)).toContain("RT-16");
  });
});
