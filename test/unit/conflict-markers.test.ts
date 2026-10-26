import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkConflictMarkers } from "../../src/conflict-markers.js";

const execFileAsync = promisify(execFile);

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "Test Committer",
  GIT_COMMITTER_EMAIL: "committer@example.com",
};

// Built, not spelled out, so this file holds no marker of its own.
const OPEN = "<".repeat(7);
const ANCESTOR = "|".repeat(7);
const SEP = "=".repeat(7);
const CLOSE = ">".repeat(7);

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args as string[], { cwd, env: ENV });
  return stdout.trim();
}

async function commit(cwd: string, files: Record<string, string | null>): Promise<string> {
  for (const [name, content] of Object.entries(files)) {
    if (content === null) {
      await rm(join(cwd, name));
    } else {
      await mkdir(dirname(join(cwd, name)), { recursive: true });
      await writeFile(join(cwd, name), content);
    }
  }
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "--quiet", "-m", "change"]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

const lines = (...rows: string[]): string => `${rows.join("\n")}\n`;

describe("checkConflictMarkers", () => {
  let repo: string;
  let base: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "repo-truth-conflict-markers-"));
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
    base = await commit(repo, { "README.md": lines("# Title", "text") });
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("passes a range with no marker", async () => {
    const candidate = await commit(repo, { "src/a.ts": lines("export const a = 1;") });
    const record = await checkConflictMarkers({ cwd: repo, base, candidate });
    expect(record.name).toBe("RT-09");
    expect(record.status).toBe("pass");
  });

  it("reports every marker of an added conflict block with file, line and kind", async () => {
    const candidate = await commit(repo, {
      "notes.md": lines(
        "intro",
        `${OPEN} HEAD`,
        "ours",
        `${ANCESTOR} abc123`,
        "original",
        SEP,
        "theirs",
        `${CLOSE} feature`,
        "outro",
      ),
    });
    const record = await checkConflictMarkers({ cwd: repo, base, candidate });
    expect(record.status).toBe("fail");
    expect(record.evidence).toHaveLength(4);
    expect(record.evidence[0]).toMatch(/^notes\.md:2: .*opening/);
    expect(record.evidence[1]).toMatch(/^notes\.md:4: .*base/);
    expect(record.evidence[2]).toMatch(/^notes\.md:6: .*separator/);
    expect(record.evidence[3]).toMatch(/^notes\.md:8: .*closing/);
  });

  it("numbers lines in the candidate's version of a modified file", async () => {
    const before = await commit(repo, { "data.yaml": lines("a: 1", "b: 2", "c: 3") });
    const candidate = await commit(repo, {
      "data.yaml": lines("new: 0", "a: 1", "b: 2", `${OPEN} HEAD`, "c: 3", SEP, "c: 4", `${CLOSE} x`),
    });
    const record = await checkConflictMarkers({ cwd: repo, base: before, candidate });
    expect(record.evidence.map((line) => line.split(": ")[0])).toEqual([
      "data.yaml:4",
      "data.yaml:6",
      "data.yaml:8",
    ]);
  });

  it("reports a closing marker with no end-of-line text and a path holding a space", async () => {
    const candidate = await commit(repo, { "my dir/my file.json": lines("{}", CLOSE) });
    const record = await checkConflictMarkers({ cwd: repo, base, candidate });
    expect(record.status).toBe("fail");
    expect(record.evidence).toHaveLength(1);
    expect(record.evidence[0]).toMatch(/^my dir\/my file\.json:2: .*closing/);
  });

  it("finds markers in every file of the range", async () => {
    const candidate = await commit(repo, {
      "a.txt": lines(`${OPEN} HEAD`),
      "b.txt": lines("fine", `${CLOSE} other`),
    });
    const record = await checkConflictMarkers({ cwd: repo, base, candidate });
    expect(record.evidence).toHaveLength(2);
    expect(record.evidence[0]).toMatch(/^a\.txt:1:/);
    expect(record.evidence[1]).toMatch(/^b\.txt:2:/);
  });

  it("does not report the commit that removes a leftover marker", async () => {
    const dirty = await commit(repo, {
      "notes.md": lines(`${OPEN} HEAD`, "ours", SEP, "theirs", `${CLOSE} feature`),
    });
    const candidate = await commit(repo, { "notes.md": lines("resolved") });
    const record = await checkConflictMarkers({ cwd: repo, base: dirty, candidate });
    expect(record.status).toBe("pass");
    const deleted = await commit(repo, { "notes.md": null });
    expect((await checkConflictMarkers({ cwd: repo, base: candidate, candidate: deleted })).status).toBe("pass");
  });

  it("does not report a Markdown heading underlined with seven equals signs", async () => {
    const candidate = await commit(repo, { "doc.md": lines("Heading", SEP, "", "Another", `${SEP}  `, "body") });
    const record = await checkConflictMarkers({ cwd: repo, base, candidate });
    expect(record.status).toBe("pass");
  });

  it("does not report a separator after a closed conflict block", async () => {
    const candidate = await commit(repo, {
      "doc.md": lines(`${OPEN} a`, SEP, `${CLOSE} b`, "Heading", SEP),
    });
    const record = await checkConflictMarkers({ cwd: repo, base, candidate });
    expect(record.evidence).toHaveLength(3);
    expect(record.evidence.some((line) => line.startsWith("doc.md:5:"))).toBe(false);
  });

  it("does not report a marker the base already holds", async () => {
    const dirty = await commit(repo, {
      "fixture.md": lines(`${OPEN} HEAD`, "ours", SEP, "theirs", `${CLOSE} feature`),
    });
    const candidate = await commit(repo, { "other.ts": lines("export {};") });
    const record = await checkConflictMarkers({ cwd: repo, base: dirty, candidate });
    expect(record.status).toBe("pass");
    // An edit elsewhere in the same file does not make the old marker new.
    const edited = await commit(repo, {
      "fixture.md": lines("intro", `${OPEN} HEAD`, "ours", SEP, "theirs", `${CLOSE} feature`),
    });
    const second = await checkConflictMarkers({ cwd: repo, base: candidate, candidate: edited });
    expect(second.status).toBe("pass");
  });

  it("does not report text that only starts like a marker", async () => {
    const candidate = await commit(repo, {
      "text.md": lines(
        `${OPEN}<`,
        `${CLOSE}>`,
        `${ANCESTOR}|`,
        `${OPEN}text`,
        `${CLOSE}x`,
        `${ANCESTOR}x`,
        `${"<".repeat(6)} six`,
        ` ${OPEN}`,
        `${OPEN}à`,
      ),
    });
    const record = await checkConflictMarkers({ cwd: repo, base, candidate });
    expect(record.status).toBe("pass");
  });

  it("reports a marker with CRLF line endings", async () => {
    const candidate = await commit(repo, { "win.txt": `${OPEN}\r\nx\r\n${CLOSE}\r\n` });
    const record = await checkConflictMarkers({ cwd: repo, base, candidate });
    expect(record.evidence).toHaveLength(2);
  });

  it("reads the range, not the working tree", async () => {
    const candidate = await commit(repo, { "clean.ts": lines("export {};") });
    await writeFile(join(repo, "clean.ts"), lines(OPEN, CLOSE));
    const record = await checkConflictMarkers({ cwd: repo, base, candidate });
    expect(record.status).toBe("pass");
  });

  it("reads only what the candidate adds since the merge base", async () => {
    await git(repo, ["checkout", "--quiet", "-b", "side"]);
    const candidate = await commit(repo, { "side.md": lines(`${OPEN} HEAD`) });
    await git(repo, ["checkout", "--quiet", "main"]);
    const moved = await commit(repo, { "main.md": lines(`${CLOSE} main`) });
    const record = await checkConflictMarkers({ cwd: repo, base: moved, candidate });
    expect(record.evidence).toHaveLength(1);
    expect(record.evidence[0]).toMatch(/^side\.md:1:/);
  });

  it("fails naming a revision that names no commit", async () => {
    const candidate = await commit(repo, { "a.ts": lines("export {};") });
    for (const [b, c, named] of [
      ["no-such-branch", candidate, "no-such-branch"],
      [base, "deadbeef-nothing", "deadbeef-nothing"],
      ["", candidate, '""'],
      ["--output=x", candidate, "--output=x"],
    ] as const) {
      const record = await checkConflictMarkers({ cwd: repo, base: b, candidate: c });
      expect(record.name).toBe("RT-09");
      expect(record.status).toBe("fail");
      expect(record.evidence).toHaveLength(1);
      expect(record.evidence[0]).toContain(named);
    }
  });

  it("fails rather than throws when git cannot run in the directory", async () => {
    const record = await checkConflictMarkers({ cwd: join(repo, "missing"), base, candidate: base });
    expect(record.status).toBe("fail");
    expect(record.evidence.length).toBeGreaterThan(0);
  });

  it("fails when the revisions share no history", async () => {
    await git(repo, ["checkout", "--quiet", "--orphan", "other"]);
    const candidate = await commit(repo, { "o.txt": lines("x") });
    const record = await checkConflictMarkers({ cwd: repo, base, candidate });
    expect(record.status).toBe("fail");
    expect(record.evidence).toHaveLength(1);
  });

  it("reports git's own complaint when the directory is not a repository", async () => {
    const plain = await mkdtemp(join(tmpdir(), "repo-truth-conflict-markers-plain-"));
    try {
      const record = await checkConflictMarkers({ cwd: plain, base: "main", candidate: "main" });
      expect(record.status).toBe("fail");
      expect(record.evidence).toHaveLength(1);
      expect(record.evidence[0]).toMatch(/not a git repository/i);
      expect(record.evidence[0]).not.toMatch(/Command failed/);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it("names the failed git command when git exits without a word", async () => {
    const candidate = await commit(repo, { "a.ts": lines("export {};") });
    const missing = await checkConflictMarkers({ cwd: repo, base: "no-such-branch", candidate });
    expect(missing.status).toBe("fail");
    expect(missing.evidence).toHaveLength(1);
    expect(missing.evidence[0]?.startsWith('revision "no-such-branch" names no commit: ')).toBe(true);
    expect(missing.evidence[0]).toContain("no-such-branch^{commit}");
    const other = await checkConflictMarkers({ cwd: repo, base, candidate: "gone-too" });
    expect(other.evidence[0]?.startsWith('revision "gone-too" names no commit: ')).toBe(true);
    expect(other.evidence[0]).toContain("gone-too^{commit}");
  });

  it("refuses an empty revision or one beginning with a minus before git runs", async () => {
    const candidate = await commit(repo, { "a.ts": lines("export {};") });
    const cases = [
      { b: "", c: candidate, text: 'revision "" names no commit' },
      { b: base, c: "", text: 'revision "" names no commit' },
      { b: "-x", c: candidate, text: 'revision "-x" names no commit' },
      { b: base, c: "--output=x", text: 'revision "--output=x" names no commit' },
      { b: "-", c: candidate, text: 'revision "-" names no commit' },
    ];
    for (const { b, c, text } of cases) {
      const record = await checkConflictMarkers({ cwd: repo, base: b, candidate: c });
      expect(record.status).toBe("fail");
      expect(record.evidence).toEqual([text]);
    }
  });

  it("resolves a revision one character long that names a commit", async () => {
    const dirty = await commit(repo, { "m.md": lines(`${OPEN} HEAD`) });
    const failing = await checkConflictMarkers({ cwd: repo, base, candidate: "@" });
    expect(failing.status).toBe("fail");
    expect(failing.evidence).toEqual(["m.md:1: opening marker"]);
    const passing = await checkConflictMarkers({ cwd: repo, base: "@", candidate: dirty });
    expect(passing.status).toBe("pass");
    expect(passing.evidence).toEqual([`0 added line(s) in "@"..."${dirty}" hold no conflict marker`]);
  });

  it("escapes control characters in a path and prints every other character as it is", async () => {
    const escaped = new Set<number>();
    for (let code = 0x01; code < 0x20; code += 1) escaped.add(code);
    escaped.add(0x7f);
    for (let code = 0x80; code < 0xa0; code += 1) escaped.add(code);
    const plain = [0x20, 0x7e, 0xa0, 0xa1, 0xe9, 0x4e2d];
    const files: Record<string, string> = {};
    const expected: string[] = [];
    for (const code of [...escaped, ...plain]) {
      const char = String.fromCodePoint(code);
      const label = escaped.has(code) ? `\\u{${code.toString(16).padStart(4, "0")}}` : char;
      files[`p${char}q.txt`] = lines(`${OPEN} HEAD`);
      expected.push(`p${label}q.txt:1: opening marker`);
    }
    const candidate = await commit(repo, files);
    const record = await checkConflictMarkers({ cwd: repo, base, candidate });
    expect(record.status).toBe("fail");
    expect([...record.evidence].sort()).toEqual([...expected].sort());
    expect(record.evidence).toContain("p\\u{0009}q.txt:1: opening marker");
    expect(record.evidence).toContain("péq.txt:1: opening marker");
  });

  it("still reads the files after one whose change removes lines", async () => {
    const deleteRows = 6;
    const old = await commit(repo, {
      "a-replace.txt": lines("keep", `${OPEN} old`, "tail"),
      "b-delete.txt": lines(...Array.from({ length: deleteRows }, (_, i) => `row ${i}`)),
      "c-single.txt": lines("one", "two", "three"),
      "d-both.txt": lines("p", "q", "r", "s"),
    });
    const candidate = await commit(repo, {
      "a-replace.txt": lines("keep", "new", "tail"),
      "b-delete.txt": lines("row 0", "row 1", "row 5"),
      "c-single.txt": lines("one", "three"),
      "d-both.txt": lines("p", "x", "r", "y"),
      "e-block.txt": lines("intro", `${OPEN} HEAD`, "ours", SEP, "theirs", `${CLOSE} x`),
    });
    const record = await checkConflictMarkers({ cwd: repo, base: old, candidate });
    expect(record.status).toBe("fail");
    expect(record.evidence).toEqual([
      "e-block.txt:2: opening marker",
      "e-block.txt:4: separator marker",
      "e-block.txt:6: closing marker",
    ]);
  });

  it("states the number of lines the range adds when it passes", async () => {
    const fileCount = 3;
    const rowsPerFile = 4;
    const files: Record<string, string> = {};
    let written = 0;
    for (let f = 0; f < fileCount; f += 1) {
      const rows = Array.from({ length: rowsPerFile + f }, (_, i) => `file ${f} row ${i}`);
      written += rows.length;
      files[`n${f}.txt`] = lines(...rows);
    }
    const candidate = await commit(repo, files);
    const record = await checkConflictMarkers({ cwd: repo, base, candidate });
    expect(record.status).toBe("pass");
    expect(record.evidence).toEqual([`${written} added line(s) in "${base}"..."${candidate}" hold no conflict marker`]);
  });

  it("reads a path that is not valid UTF-8 byte for byte, each byte one character", async () => {
    const lead = 0xc9;
    const name = Buffer.concat([Buffer.from([lead]), Buffer.from(".txt")]);
    await writeFile(Buffer.concat([Buffer.from(`${repo}/`), name]), lines(`${OPEN} HEAD`));
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "--quiet", "-m", "odd name"]);
    const candidate = await git(repo, ["rev-parse", "HEAD"]);
    const record = await checkConflictMarkers({ cwd: repo, base, candidate });
    expect(record.status).toBe("fail");
    expect(record.evidence).toEqual(["É.txt:1: opening marker"]);
  });
});
