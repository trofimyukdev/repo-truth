/**
 * Weakened tests.
 *
 * The cheapest way to make a red suite green is to make it ask less: skip the
 * failing test, focus the run on the passing ones, delete the test or the
 * assertion that fails. Each of those leaves the build green, and each is
 * legitimate sometimes, so this check does not judge intent. It reports every
 * such move in `base..candidate` for a human to sanction, and fails while one
 * is unsanctioned.
 *
 * Only the DIFF is read. A marker that predates the range is never reported,
 * and a marker line the range removes and adds back unchanged is a move, not
 * a new marker. File contents are read by blob id through git, never from the
 * working tree, and the diff is taken from the merge base of the two
 * revisions, as in the portable-paths check.
 *
 * What counts as a test file, a marker, a test or an assertion lives in one
 * table, `WEAKENING_SPELLINGS`; a caller on another runner passes its own.
 */

import { execFile } from "node:child_process";

import type { CheckRecord } from "./index.js";

const NAME = "RT-04";

/** The kinds of move this version reports. */
export type WeakeningCategory = "skip" | "only" | "test-file-deleted" | "test-removed" | "assertion-removed";

/** The kinds of file a marker can apply to; `any` is every file. */
export type MarkerScope = "test" | "config" | "any";

/** One spelling of a marker that disables or narrows tests. */
export interface MarkerSpelling {
  /** `skip` for a test skipped or left todo, `only` for a focus marker. */
  readonly category: "skip" | "only";
  /** The kinds of file the marker counts in. */
  readonly scope: readonly MarkerScope[];
  /** Tested against each added or removed line, without the diff's sign. */
  readonly pattern: RegExp;
  /** A line `pattern` matches. */
  readonly example: string;
}

/**
 * The recognised spellings. A caller passes its own as the `spellings` option;
 * each key it gives replaces that key of this table, so extending one list is
 * `{ ...WEAKENING_SPELLINGS, markers: [...WEAKENING_SPELLINGS.markers, mine] }`.
 */
export interface WeakeningSpellings {
  /** Paths, relative to the repository root, that are test files. */
  readonly testFiles: readonly RegExp[];
  /** Paths that configure a test runner. */
  readonly configFiles: readonly RegExp[];
  readonly markers: readonly MarkerSpelling[];
  /**
   * A line of a test file that declares one test. The test's name is the
   * group named `name`, else the first group, else the whole line.
   */
  readonly tests: readonly RegExp[];
  /** A line of a test file that makes an assertion. */
  readonly assertions: readonly RegExp[];
}

const TEST_DECLARATION = "\\b[xf]?(?:it|test|specify)(?:\\s*\\.\\s*[A-Za-z]+)*\\s*\\(\\s*([\"'`])(?<name>.*?)\\1";

export const WEAKENING_SPELLINGS: WeakeningSpellings = Object.freeze({
  testFiles: Object.freeze([
    /\.(?:test|spec)\.[cm]?[jt]sx?$/,
    /(?:^|\/)__tests__\/.+\.[cm]?[jt]sx?$/,
    /(?:^|\/)test_[^/]*\.py$/,
    /_test\.(?:py|go)$/,
  ]),
  configFiles: Object.freeze([
    /(?:^|\/)(?:vitest|vite|jest|playwright|cypress|karma|ava)\.config\.[cm]?[jt]s$/,
    /(?:^|\/)\.mocharc\.[a-z]+$/,
    /(?:^|\/)(?:pytest\.ini|conftest\.py)$/,
  ]),
  markers: Object.freeze<MarkerSpelling[]>([
    {
      category: "skip",
      scope: ["test"],
      pattern: /\b(?:describe|suite|context|it|test|specify|bench)\s*\.\s*(?:skip|skipIf|todo|fixme)\b/,
      example: 'it.skip("parses the header", () => {});',
    },
    {
      category: "skip",
      scope: ["test"],
      pattern: /\bx(?:describe|context|it|test|specify)\s*\(/,
      example: 'xit("parses the header", () => {});',
    },
    {
      category: "skip",
      scope: ["test"],
      pattern: /\b(?:this|ctx|context)\s*\.\s*skip\s*\(/,
      example: "this.skip();",
    },
    {
      category: "skip",
      scope: ["test", "config"],
      pattern: /@(?:pytest\.mark\.(?:skip|skipif|xfail)|unittest\.skip)\b/,
      example: "@pytest.mark.skip(reason=\"flaky\")",
    },
    {
      category: "skip",
      scope: ["test"],
      pattern: /\bt\.Skip(?:f|Now)?\s*\(/,
      example: 't.Skip("flaky")',
    },
    {
      category: "only",
      scope: ["test"],
      pattern: /\b(?:describe|suite|context|it|test|specify|bench)\s*\.\s*only\b/,
      example: 'it.only("parses the header", () => {});',
    },
    {
      category: "only",
      scope: ["test"],
      pattern: /\bf(?:describe|it)\s*\(/,
      example: 'fit("parses the header", () => {});',
    },
    {
      category: "only",
      scope: ["config"],
      pattern: /\btestNamePattern\b/,
      example: 'testNamePattern: "header",',
    },
  ]),
  tests: Object.freeze([
    new RegExp(TEST_DECLARATION),
    /^\s*(?:async\s+)?def\s+(?<name>test\w*)\s*\(/,
    /^func\s+(?<name>Test\w*)\s*\(/,
  ]),
  assertions: Object.freeze([
    /\b(?:expect|assert)\w*(?:\s*\.\s*\w+)*\s*\(/,
    /^\s*assert\s/,
    /\.should\b/,
    /\bt\.(?:Error|Errorf|Fatal|Fatalf)\s*\(/,
  ]),
});

/** One move that lowers what the suite asserts. */
export interface WeakeningFinding {
  /** `<category>:<file>:<line>`. */
  readonly id: string;
  readonly category: WeakeningCategory;
  /** The path on `side`, relative to the repository root. */
  readonly file: string;
  /** The line on `side`; 0 for a deleted file that had no lines. */
  readonly line: number;
  /** `candidate` for a line the range added, `base` for one it removed. */
  readonly side: "base" | "candidate";
  readonly detail: string;
  /** The sanction's reason, or `null` while the finding is unsanctioned. */
  readonly sanction: string | null;
}

export interface WeakenedTestsRecord extends CheckRecord {
  readonly findings: readonly WeakeningFinding[];
}

export interface WeakenedTestsOptions {
  /** The git repository to run in. */
  readonly cwd: string;
  /** The revision the range starts after. */
  readonly base: string;
  /** The revision the range ends at. */
  readonly candidate: string;
  /** Replaces the keys of `WEAKENING_SPELLINGS` it gives. */
  readonly spellings?: Partial<WeakeningSpellings> | undefined;
  /** Keys are finding ids or `<category>:<file>`; values are the reasons. */
  readonly sanctions?: Readonly<Record<string, string>> | undefined;
}

/** The key that sanctions a finding in a commit message of the range. */
export const SANCTION_KEY = "Sanctioned-Weakening";

function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args as string[],
      { cwd, maxBuffer: 1024 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** Escape everything outside printable ASCII, so evidence cannot replay a control sequence. */
function escapeText(text: string): string {
  let escaped = "";
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    escaped += codePoint >= 0x20 && codePoint <= 0x7e ? char : `\\u{${codePoint.toString(16).padStart(4, "0")}}`;
  }
  return escaped;
}

function quote(text: string): string {
  return `"${escapeText(text)}"`;
}

async function resolveCommit(cwd: string, revision: string): Promise<string> {
  // A revision that begins with a dash would be read as an option.
  if (typeof revision !== "string" || revision.length === 0 || revision.startsWith("-")) {
    throw new Error(`revision ${quote(String(revision))} does not name a commit`);
  }
  let hash = "";
  try {
    hash = (await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`])).trim();
  } catch (error) {
    throw new Error(`revision ${quote(revision)} does not name a commit: ${(error as Error).message}`);
  }
  if (hash.length === 0) {
    throw new Error(`revision ${quote(revision)} does not name a commit`);
  }
  return hash;
}

interface Line {
  readonly number: number;
  readonly text: string;
}

/** One file pair of the diff, with the lines it removed and added. */
interface Change {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly oldBlob: string | null;
  readonly newBlob: string | null;
  readonly removed: Line[];
  readonly added: Line[];
}

function toLines(text: string): string[] {
  if (text.includes("\0")) {
    return [];
  }
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.map((line) => line.replace(/\r$/, ""));
}

async function readBlob(cwd: string, blob: string | null): Promise<string[]> {
  return blob === null ? [] : toLines(await runGit(cwd, ["cat-file", "blob", blob]));
}

/** The removed and added lines of a blob-to-blob diff, numbered on their own side. */
async function diffBlobs(cwd: string, oldBlob: string, newBlob: string): Promise<{ removed: Line[]; added: Line[] }> {
  const out = await runGit(cwd, ["diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", oldBlob, newBlob]);
  const removed: Line[] = [];
  const added: Line[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const raw of out.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk !== null) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
    } else if (inHunk && raw.startsWith("-")) {
      removed.push({ number: oldLine, text: raw.slice(1).replace(/\r$/, "") });
      oldLine += 1;
    } else if (inHunk && raw.startsWith("+")) {
      added.push({ number: newLine, text: raw.slice(1).replace(/\r$/, "") });
      newLine += 1;
    }
  }
  return { removed, added };
}

function numbered(lines: readonly string[]): Line[] {
  return lines.map((text, index) => ({ number: index + 1, text }));
}

/** Every file pair between two commits, from git's raw diff, with its lines. */
async function readChanges(cwd: string, from: string, to: string): Promise<Change[]> {
  const out = await runGit(cwd, ["diff", "--raw", "-z", "--no-abbrev", "--find-renames", "--no-relative", from, to, "--"]);
  const fields = out.split("\0");
  const changes: Change[] = [];
  let i = 0;
  while (i < fields.length) {
    const head = fields[i] ?? "";
    i += 1;
    if (!head.startsWith(":")) {
      continue;
    }
    const [oldMode = "", newMode = "", oldSha = "", newSha = "", status = ""] = head.slice(1).split(" ");
    const first = fields[i] ?? "";
    i += 1;
    let second = first;
    if (status.startsWith("R") || status.startsWith("C")) {
      second = fields[i] ?? "";
      i += 1;
    }
    const regular = (mode: string, sha: string): string | null =>
      mode.startsWith("100") && !/^0+$/.test(sha) ? sha : null;
    const oldBlob = regular(oldMode, oldSha);
    const newBlob = regular(newMode, newSha);
    let lines: { removed: Line[]; added: Line[] };
    if (oldBlob !== null && newBlob !== null) {
      lines = await diffBlobs(cwd, oldBlob, newBlob);
    } else {
      lines = { removed: numbered(await readBlob(cwd, oldBlob)), added: numbered(await readBlob(cwd, newBlob)) };
    }
    changes.push({
      oldPath: status.startsWith("A") ? null : first,
      newPath: status.startsWith("D") ? null : second,
      oldBlob,
      newBlob,
      ...lines,
    });
  }
  return changes;
}

function matches(pattern: RegExp, text: string): RegExpExecArray | null {
  pattern.lastIndex = 0;
  return pattern.exec(text);
}

function kindsOf(path: string, spellings: WeakeningSpellings): Set<MarkerScope> {
  const kinds = new Set<MarkerScope>(["any"]);
  if (spellings.testFiles.some((pattern) => matches(pattern, path) !== null)) {
    kinds.add("test");
  }
  if (spellings.configFiles.some((pattern) => matches(pattern, path) !== null)) {
    kinds.add("config");
  }
  return kinds;
}

function markersOn(text: string, kinds: ReadonlySet<MarkerScope>, spellings: WeakeningSpellings): Set<"skip" | "only"> {
  const categories = new Set<"skip" | "only">();
  for (const marker of spellings.markers) {
    if (marker.scope.some((scope) => kinds.has(scope)) && matches(marker.pattern, text) !== null) {
      categories.add(marker.category);
    }
  }
  return categories;
}

type Draft = Omit<WeakeningFinding, "id" | "sanction">;

/** Skip and focus markers the range adds, less the ones it only moves. */
function markerFindings(changes: readonly Change[], spellings: WeakeningSpellings): Draft[] {
  const moved = new Map<string, number>();
  for (const change of changes) {
    if (change.oldPath === null) {
      continue;
    }
    const kinds = kindsOf(change.oldPath, spellings);
    for (const line of change.removed) {
      if (markersOn(line.text, kinds, spellings).size > 0) {
        const key = line.text.trim();
        moved.set(key, (moved.get(key) ?? 0) + 1);
      }
    }
  }
  const drafts: Draft[] = [];
  for (const change of changes) {
    if (change.newPath === null) {
      continue;
    }
    const kinds = kindsOf(change.newPath, spellings);
    for (const line of change.added) {
      const categories = markersOn(line.text, kinds, spellings);
      if (categories.size === 0) {
        continue;
      }
      const key = line.text.trim();
      const count = moved.get(key) ?? 0;
      if (count > 0) {
        moved.set(key, count - 1);
        continue;
      }
      for (const category of categories) {
        const what = category === "skip" ? "test newly skipped" : "run newly focused";
        drafts.push({ category, file: change.newPath, line: line.number, side: "candidate", detail: `${what}: ${key}` });
      }
    }
  }
  return drafts;
}

interface Declaration {
  readonly line: number;
  readonly name: string;
}

function declarations(lines: readonly string[], spellings: WeakeningSpellings): Declaration[] {
  const found: Declaration[] = [];
  lines.forEach((text, index) => {
    for (const pattern of spellings.tests) {
      const match = matches(pattern, text);
      if (match !== null) {
        found.push({ line: index + 1, name: match.groups?.["name"] ?? match[1] ?? text.trim() });
        return;
      }
    }
  });
  return found;
}

function countNames(found: readonly Declaration[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { name } of found) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

/** The test a line falls in: the nearest declaration at or above it. */
function enclosing(found: readonly Declaration[], line: number): Declaration | null {
  let within: Declaration | null = null;
  for (const declaration of found) {
    if (declaration.line > line) {
      break;
    }
    within = declaration;
  }
  return within;
}

function isAssertion(text: string, spellings: WeakeningSpellings): boolean {
  return spellings.assertions.some((pattern) => matches(pattern, text) !== null);
}

/** Lines grouped by the name of the test they fall in, leaving out the tests in `dropped`. */
function byTest(
  lines: readonly Line[],
  found: readonly Declaration[],
  dropped: ReadonlySet<Declaration> = new Set(),
): Map<string | null, Line[]> {
  const groups = new Map<string | null, Line[]>();
  for (const line of lines) {
    const within = enclosing(found, line.number);
    if (within !== null && dropped.has(within)) {
      continue; // the whole test went, and `test-removed` says so
    }
    const name = within?.name ?? null;
    groups.set(name, [...(groups.get(name) ?? []), line]);
  }
  return groups;
}

/** Tests removed from a test file that still exists, and assertions removed from tests that remain. */
async function testFindings(cwd: string, change: Change, file: string, spellings: WeakeningSpellings): Promise<Draft[]> {
  const before = declarations(await readBlob(cwd, change.oldBlob), spellings);
  const after = declarations(await readBlob(cwd, change.newBlob), spellings);
  const beforeCounts = countNames(before);
  const afterCounts = countNames(after);
  const removedLines = new Set(change.removed.map((line) => line.number));
  const drafts: Draft[] = [];
  const dropped = new Set<Declaration>();

  for (const [name, count] of beforeCounts) {
    const deficit = count - (afterCounts.get(name) ?? 0);
    const gone = before.filter((declaration) => declaration.name === name && removedLines.has(declaration.line));
    for (const declaration of gone.slice(0, Math.max(deficit, 0))) {
      dropped.add(declaration);
      drafts.push({ category: "test-removed", file, line: declaration.line, side: "base", detail: `test ${quote(name)} removed` });
    }
  }

  const removed = byTest(change.removed.filter((line) => isAssertion(line.text, spellings)), before, dropped);
  const added = byTest(change.added.filter((line) => isAssertion(line.text, spellings)), after);
  for (const [name, lines] of removed) {
    const replacements = (added.get(name) ?? []).map((line) => line.text.trim());
    const left = lines.filter((line) => {
      const at = replacements.indexOf(line.text.trim());
      if (at === -1) {
        return true;
      }
      replacements.splice(at, 1);
      return false;
    });
    const where = name === null ? "outside any test" : `from test ${quote(name)}`;
    for (const line of left.slice(0, Math.max(left.length - replacements.length, 0))) {
      drafts.push({
        category: "assertion-removed",
        file,
        line: line.number,
        side: "base",
        detail: `assertion removed ${where}: ${line.text.trim()}`,
      });
    }
  }
  return drafts;
}

/** The text after the sanction key on every such line of the range's commit messages. */
async function readSanctionLines(cwd: string, from: string, to: string): Promise<string[]> {
  const out = await runGit(cwd, ["log", "--format=%B%x00", `${from}..${to}`, "--"]);
  const prefix = `${SANCTION_KEY}:`;
  return out
    .split(/[\n\0]/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length).trim());
}

function sanctionFor(
  draft: Draft,
  id: string,
  lines: readonly string[],
  given: Readonly<Record<string, string>>,
): string | null {
  for (const key of [id, `${draft.category}:${draft.file}`]) {
    const reason = Object.hasOwn(given, key) ? given[key] : undefined;
    if (typeof reason === "string" && reason.trim().length > 0) {
      return reason.trim();
    }
    for (const line of lines) {
      const rest = line.slice(key.length);
      if (line.startsWith(key) && /^\s+\S/.test(rest)) {
        return rest.trim();
      }
    }
  }
  return null;
}

function failed(evidence: string[]): WeakenedTestsRecord {
  return { name: NAME, status: "fail", evidence, findings: [] };
}

/**
 * Report the moves of `base..candidate` that lower what the suite asserts.
 * Fails while any finding is unsanctioned, and fails closed: a revision that
 * names no commit, or any git invocation that fails, is a `fail` record naming
 * the cause - never a `pass`, and never a thrown error.
 */
export async function checkWeakenedTests(options: WeakenedTestsOptions): Promise<WeakenedTestsRecord> {
  try {
    const { cwd, base, candidate } = options;
    const spellings: WeakeningSpellings = { ...WEAKENING_SPELLINGS, ...options.spellings };
    const baseCommit = await resolveCommit(cwd, base);
    const candidateCommit = await resolveCommit(cwd, candidate);
    let ancestor: string;
    try {
      ancestor = (await runGit(cwd, ["merge-base", baseCommit, candidateCommit])).trim();
    } catch (error) {
      throw new Error(`no merge base of ${quote(base)} and ${quote(candidate)}: ${(error as Error).message}`);
    }

    const changes = await readChanges(cwd, ancestor, candidateCommit);
    const drafts = markerFindings(changes, spellings);
    for (const change of changes) {
      if (change.oldPath === null || !kindsOf(change.oldPath, spellings).has("test")) {
        continue;
      }
      if (change.newPath === null || !kindsOf(change.newPath, spellings).has("test")) {
        const lines = await readBlob(cwd, change.oldBlob);
        const detail = change.newPath === null ? "test file deleted" : `test file renamed to ${quote(change.newPath)}, which is not a test file`;
        drafts.push({ category: "test-file-deleted", file: change.oldPath, line: lines.length > 0 ? 1 : 0, side: "base", detail });
      } else {
        drafts.push(...(await testFindings(cwd, change, change.oldPath, spellings)));
      }
    }

    const lines = await readSanctionLines(cwd, baseCommit, candidateCommit);
    const findings: WeakeningFinding[] = drafts.map((draft) => {
      const id = `${draft.category}:${draft.file}:${draft.line}`;
      return { id, ...draft, sanction: sanctionFor(draft, id, lines, options.sanctions ?? {}) };
    });

    const range = `${quote(base)}..${quote(candidate)}`;
    if (findings.length === 0) {
      return { name: NAME, status: "pass", evidence: [`no move in ${range} lowers what the suite asserts`], findings };
    }
    const evidence = findings.map(
      (finding) =>
        `${escapeText(finding.id)} [${finding.category}] ${escapeText(finding.detail)} - ` +
        (finding.sanction === null ? "not sanctioned" : `sanctioned: ${escapeText(finding.sanction)}`),
    );
    const open = findings.filter((finding) => finding.sanction === null).length;
    return { name: NAME, status: open > 0 ? "fail" : "pass", evidence, findings };
  } catch (error) {
    return failed([escapeText(error instanceof Error ? error.message : String(error))]);
  }
}
