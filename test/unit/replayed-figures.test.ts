import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readFigureClaims } from "../../src/figure-claims.js";
import { REGISTRY } from "../../src/registry.js";
import {
  checkReplayedFigures,
  DEFAULT_REPLAY_TIMEOUT_MS,
  SHOWN_OUTPUT_LENGTH,
} from "../../src/replayed-figures.js";

const execFileAsync = promisify(execFile);

const ONE_MS = 1;
const OVERLONG_BY = 1;

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

async function commit(cwd: string, files: Record<string, string>, message = "change"): Promise<string> {
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(cwd, name), content);
  }
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "--quiet", "--allow-empty", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("checkReplayedFigures", () => {
  let repo: string;
  let base: string;
  let id: string;
  const originalPath = process.env.PATH;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "repo-truth-replayed-figures-"));
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
    await commit(repo, { "README.md": "# Title\n" }, "first");
    base = await commit(repo, { "a.txt": "needle\nhay\nneedle\n" }, "second");
    id = base.slice(0, 12);
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    await rm(repo, { recursive: true, force: true });
  });

  /** A candidate adding a page whose lines are `lines`, the claimed outputs on lines 3, 5, ... */
  async function pageCandidate(...lines: string[]): Promise<string> {
    return commit(repo, { "docs.md": ["# Figures", "", ...lines.flatMap((line) => [line, ""])].join("\n") });
  }

  /** A directory holding a `git` that runs `script` before the real git, put first on PATH. */
  async function gitFirstOnPath(script: string): Promise<void> {
    const realGit = join(await git(repo, ["--exec-path"]), "git");
    const dir = join(repo, ".fake-bin");
    await mkdir(dir);
    await writeFile(join(dir, "git"), `#!/bin/sh\n${script}\nexec "${realGit}" "$@"\n`);
    await chmod(join(dir, "git"), 0o755);
    process.env.PATH = dir + delimiter + (originalPath ?? "");
  }

  it("states a default bound of at most thirty seconds and a shown length", () => {
    expect(DEFAULT_REPLAY_TIMEOUT_MS).toBe(10000);
    expect(SHOWN_OUTPUT_LENGTH).toBe(120);
  });

  it("reproduces a claim by each subcommand and by `| wc -l`, and counts a shell example as not replayable", async () => {
    const candidate = await pageCandidate(
      `\`git rev-list --count ${id}\` printed \`2\` on 2026-10-11.`,
      `\`git log --oneline ${id} | wc -l\` printed \`2\` on 2026-10-11.`,
      `\`git log -1 --format=%s ${id}\` printed \`second\`.`,
      `\`git grep -c needle ${id} -- a.txt\` printed \`${id}:a.txt:2\`.`,
      `\`git ls-tree --name-only ${id} -- a.txt\` printed \`a.txt\`.`,
      `\`git ls-tree -r --name-only ${id} | wc -l\` printed \`2\`.`,
      "`git status --short` printed `M a.txt`.",
    );
    const record = await checkReplayedFigures({ cwd: repo, base, candidate });
    expect(record).toEqual({ name: "RT-19", status: "pass", evidence: ["6 reproduced, 1 not replayable"] });
  });

  it("passes a range with no claims", async () => {
    const candidate = await pageCandidate("Nothing measured here.");
    const record = await checkReplayedFigures({ cwd: repo, base, candidate });
    expect(record).toEqual({ name: "RT-19", status: "pass", evidence: ["0 reproduced, 0 not replayable"] });
  });

  it("fails a wrong figure with a finding naming where it is, the command, the replay and the claim", async () => {
    const candidate = await pageCandidate(
      `\`git rev-list --count ${id}\` printed \`3\` on 2026-10-11.`,
      `\`git rev-list --count ${id}\` printed \`2\` on 2026-10-11.`,
      `\`git log --oneline ${id} | wc -l\` printed \`5\`.`,
    );
    const record = await checkReplayedFigures({ cwd: repo, base, candidate });
    expect(record).toEqual({
      name: "RT-19",
      status: "fail",
      evidence: [
        `docs.md:3: \`git rev-list --count ${id}\` printed \`2\` claims \`3\``,
        `docs.md:7: \`git log --oneline ${id} | wc -l\` printed \`2\` claims \`5\``,
      ],
    });
  });

  it("counts the newlines git wrote, not its lines, for `| wc -l`", async () => {
    const candidate = await pageCandidate(`\`git log -1 --format=%s%n%n ${id} | wc -l\` printed \`3\`.`);
    const record = await checkReplayedFigures({ cwd: repo, base, candidate });
    expect(record).toEqual({ name: "RT-19", status: "pass", evidence: ["1 reproduced, 0 not replayable"] });
  });

  it("drops only one final newline from what git printed", async () => {
    const candidate = await pageCandidate(`\`git log -1 --format=%s%n ${id}\` printed \`second\`.`);
    const record = await checkReplayedFigures({ cwd: repo, base, candidate });
    expect(record.status).toBe("fail");
    expect(record.evidence).toEqual([
      `docs.md:3: \`git log -1 --format=%s%n ${id}\` printed \`second\\u{000a}\` claims \`second\``,
    ]);
  });

  it("escapes characters outside printable ASCII and cuts a long output", async () => {
    const subject = "é" + "x".repeat(200);
    const target = await commit(repo, {}, subject);
    const short = target.slice(0, 12);
    const candidate = await pageCandidate(`\`git log -1 --format=%s ${short}\` printed \`café\`.`);
    const record = await checkReplayedFigures({ cwd: repo, base, candidate });
    expect(record.status).toBe("fail");
    expect(record.evidence).toEqual([
      `docs.md:3: \`git log -1 --format=%s ${short}\` printed \`\\u{00e9}${"x".repeat(119)}\`... claims \`caf\\u{00e9}\``,
    ]);
  });

  it("keeps every printable ASCII character, the tilde included, in a finding line", async () => {
    const target = await commit(repo, {}, "a~b");
    const short = target.slice(0, 12);
    const candidate = await pageCandidate(`\`git log -1 --format=%s ${short}\` printed \`x~y\`.`);
    const record = await checkReplayedFigures({ cwd: repo, base, candidate });
    expect(record.status).toBe("fail");
    expect(record.evidence).toEqual([
      `docs.md:3: \`git log -1 --format=%s ${short}\` printed \`a~b\` claims \`x~y\``,
    ]);
  });

  it("escapes the character just past printable ASCII and keeps the claimed tilde", async () => {
    const candidate = await pageCandidate(`\`git log -1 --format=%s ${id}\` printed \`a~b\`.`);
    const record = await checkReplayedFigures({ cwd: repo, base, candidate });
    expect(record.evidence).toEqual([`docs.md:3: \`git log -1 --format=%s ${id}\` printed \`second\` claims \`a~b\``]);
    const target = await commit(repo, {}, "p\u007fq");
    const short = target.slice(0, 12);
    const second = await pageCandidate(`\`git log -1 --format=%s ${short}\` printed \`pq\`.`);
    const other = await checkReplayedFigures({ cwd: repo, base, candidate: second });
    expect(other.evidence).toEqual([
      `docs.md:3: \`git log -1 --format=%s ${short}\` printed \`p\\u{007f}q\` claims \`pq\``,
    ]);
  });

  it("shows an output of exactly the shown length whole and one character longer cut", async () => {
    const whole = await commit(repo, {}, "y".repeat(SHOWN_OUTPUT_LENGTH));
    const longer = await commit(repo, {}, "z".repeat(SHOWN_OUTPUT_LENGTH + OVERLONG_BY));
    const wholeId = whole.slice(0, 12);
    const longerId = longer.slice(0, 12);
    const candidate = await pageCandidate(
      `\`git log -1 --format=%s ${wholeId}\` printed \`no\`.`,
      `\`git log -1 --format=%s ${longerId}\` printed \`no\`.`,
    );
    const record = await checkReplayedFigures({ cwd: repo, base, candidate });
    expect(record.status).toBe("fail");
    expect(record.evidence).toEqual([
      `docs.md:3: \`git log -1 --format=%s ${wholeId}\` printed \`${"y".repeat(SHOWN_OUTPUT_LENGTH)}\` claims \`no\``,
      `docs.md:5: \`git log -1 --format=%s ${longerId}\` printed \`${"z".repeat(SHOWN_OUTPUT_LENGTH)}\`... claims \`no\``,
    ]);
  });

  it("shows a claimed figure of exactly the shown length whole and one character longer cut", async () => {
    const exact = "c".repeat(SHOWN_OUTPUT_LENGTH);
    const over = "d".repeat(SHOWN_OUTPUT_LENGTH + OVERLONG_BY);
    const candidate = await pageCandidate(
      `\`git log -1 --format=%s ${id}\` printed \`${exact}\`.`,
      `\`git log -1 --format=%s ${id}\` printed \`${over}\`.`,
    );
    const record = await checkReplayedFigures({ cwd: repo, base, candidate });
    expect(record.status).toBe("fail");
    expect(record.evidence).toEqual([
      `docs.md:3: \`git log -1 --format=%s ${id}\` printed \`second\` claims \`${exact}\``,
      `docs.md:5: \`git log -1 --format=%s ${id}\` printed \`second\` claims \`${"d".repeat(SHOWN_OUTPUT_LENGTH)}\`...`,
    ]);
  });

  it("accepts a timeoutMs of one millisecond", async () => {
    const candidate = await pageCandidate("Nothing measured here.");
    const record = await checkReplayedFigures({ cwd: repo, base, candidate, timeoutMs: ONE_MS });
    expect(record).toEqual({ name: "RT-19", status: "pass", evidence: ["0 reproduced, 0 not replayable"] });
  });

  it("counts a claim with no pinned revision as not replayable", async () => {
    const candidate = await pageCandidate("`git rev-list --count HEAD` printed `99`.");
    const record = await checkReplayedFigures({ cwd: repo, base, candidate });
    expect(record).toEqual({ name: "RT-19", status: "pass", evidence: ["0 reproduced, 1 not replayable"] });
  });

  it("fails a claim naming a commit the repository does not hold", async () => {
    const candidate = await pageCandidate(
      `\`git log --oneline deadbee1..${id} | wc -l\` printed \`1\`.`,
      "`git rev-list --count deadbee1` printed `1`.",
    );
    const record = await checkReplayedFigures({ cwd: repo, base, candidate });
    expect(record).toEqual({
      name: "RT-19",
      status: "fail",
      evidence: [
        `docs.md:3: \`git log --oneline deadbee1..${id} | wc -l\` printed nothing: the repository does not hold deadbee1; claims \`1\``,
        "docs.md:5: `git rev-list --count deadbee1` printed nothing: the repository does not hold deadbee1; claims `1`",
      ],
    });
  });

  it("fails a claim naming an object that is not a commit", async () => {
    const tree = await git(repo, ["rev-parse", `${base}^{tree}`]);
    const candidate = await pageCandidate(`\`git ls-tree --name-only ${tree} -- a.txt\` printed \`a.txt\`.`);
    const record = await checkReplayedFigures({ cwd: repo, base, candidate });
    expect(record.status).toBe("fail");
    expect(record.evidence).toEqual([
      `docs.md:3: \`git ls-tree --name-only ${tree} -- a.txt\` printed nothing: the repository does not hold ${tree}; claims \`a.txt\``,
    ]);
  });

  it("reads a claim in a commit body and names the commit", async () => {
    const candidate = await commit(
      repo,
      {},
      `measure\n\n\`git rev-list --count ${id}\` printed \`7\` today.\n\`git rev-list --count ${id}\` printed \`2\` too.`,
    );
    const record = await checkReplayedFigures({ cwd: repo, base, candidate });
    expect(record).toEqual({
      name: "RT-19",
      status: "fail",
      evidence: [`${candidate}: \`git rev-list --count ${id}\` printed \`2\` claims \`7\``],
    });
  });

  it("fails a replay that exits non-zero", async () => {
    const candidate = await pageCandidate(`\`git grep -c absent ${id}\` printed \`0\`.`);
    const record = await checkReplayedFigures({ cwd: repo, base, candidate });
    expect(record).toEqual({
      name: "RT-19",
      status: "fail",
      evidence: [`docs.md:3: \`git grep -c absent ${id}\` printed nothing: exit code 1; claims \`0\``],
    });
  });

  it("stops a replay that cannot finish within its bound and reports it timed out", async () => {
    const candidate = await pageCandidate(`\`git rev-list --count ${id}\` printed \`2\`.`);
    await gitFirstOnPath('if [ "$1" = "--no-pager" ]; then sleep 20; fi');
    const started = Date.now();
    const record = await checkReplayedFigures({ cwd: repo, base, candidate, timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(10000);
    expect(record).toEqual({
      name: "RT-19",
      status: "fail",
      evidence: [`docs.md:3: \`git rev-list --count ${id}\` printed nothing: timed out after 300 ms; claims \`2\``],
    });
  }, 20000);

  it("runs a replay as `git --no-pager` and the plan's words", async () => {
    const log = join(repo, ".git", "argv.log");
    const candidate = await pageCandidate(`\`git rev-list --count ${id}\` printed \`2\`.`);
    await gitFirstOnPath(`printf '%s|' "$@" >> "${log}"; echo >> "${log}"`);
    const record = await checkReplayedFigures({ cwd: repo, base, candidate });
    expect(record.status).toBe("pass");
    const lines = (await readFile(log, "utf8")).split("\n");
    expect(lines).toContain(`--no-pager|rev-list|--count|${id}|`);
    expect(lines).toContain(`rev-parse|--verify|--quiet|${id}^{commit}|`);
  });

  it("fails closed when a git invocation other than a replay fails", async () => {
    const candidate = await pageCandidate("`git rev-list --count cafe123` printed `1`.");
    await gitFirstOnPath('case "$*" in *cafe123*) echo "boom" >&2; exit 128;; esac');
    const record = await checkReplayedFigures({ cwd: repo, base, candidate });
    expect(record).toEqual({
      name: "RT-19",
      status: "fail",
      evidence: ["replayed-figures check could not run: git rev-parse could not look up commit cafe123: boom"],
    });
  });

  it("fails closed in a directory that does not exist", async () => {
    const candidate = await pageCandidate(`\`git rev-list --count ${id}\` printed \`2\`.`);
    const record = await checkReplayedFigures({ cwd: join(repo, "absent"), base, candidate });
    expect(record.name).toBe("RT-19");
    expect(record.status).toBe("fail");
    expect(record.evidence).toHaveLength(1);
  });

  it("fails a revision that names no commit with the claim reader's failure", async () => {
    const read = await readFigureClaims({ cwd: repo, base: "no-such-revision", candidate: base });
    expect("failure" in read).toBe(true);
    const record = await checkReplayedFigures({ cwd: repo, base: "no-such-revision", candidate: base });
    expect(record).toEqual({ name: "RT-19", status: "fail", evidence: [(read as { failure: string }).failure] });
    expect(record.evidence[0]).toContain("no-such-revision");
  });

  it("fails a timeoutMs that is not a positive number", async () => {
    for (const timeoutMs of [0, -5, Number.NaN]) {
      const record = await checkReplayedFigures({ cwd: repo, base, candidate: base, timeoutMs });
      expect(record).toEqual({
        name: "RT-19",
        status: "fail",
        evidence: [`timeoutMs ${timeoutMs} is not a positive number of milliseconds`],
      });
    }
  });

  it("never runs a second command after `;`", async () => {
    const marker = join(repo, "semicolon-marker");
    const candidate = await pageCandidate(`\`git rev-list --count ${id}; touch ${marker}\` printed \`2\`.`);
    const record = await checkReplayedFigures({ cwd: repo, base, candidate });
    expect(record).toEqual({ name: "RT-19", status: "pass", evidence: ["0 reproduced, 1 not replayable"] });
    expect(await exists(marker)).toBe(false);
  });

  it("runs a single-quoted command substitution in a format word as text, never through a shell", async () => {
    const short = await git(repo, ["log", "-1", "--format=%h", base]);
    const candidate = await pageCandidate(
      `\`git log -1 --format='$(touch subst-marker)%h' ${id}\` printed \`$(touch subst-marker)${short}\`.`,
    );
    const record = await checkReplayedFigures({ cwd: repo, base, candidate });
    expect(record).toEqual({ name: "RT-19", status: "pass", evidence: ["1 reproduced, 0 not replayable"] });
    expect(await exists(join(repo, "subst-marker"))).toBe(false);
  });
});

describe("REGISTRY", () => {
  it("holds RT-19 running the replayed-figures check", async () => {
    const found = REGISTRY.filter((e) => e.name === "RT-19");
    expect(found).toHaveLength(1);
    const record = await found[0]!.run({ cwd: tmpdir() }, { base: "-x", candidate: "-y" });
    expect(record.name).toBe("RT-19");
    expect(record.status).toBe("fail");
  });
});
