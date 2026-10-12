/**
 * Suppression directives.
 *
 * A line that no longer type-checks, a rule the change breaks, a branch no test
 * reaches: each passes once a comment tells the gate not to look. This check
 * reads the lines `base..candidate` removes and adds in source files, pairs each
 * directive the range removes with one it adds in the same file, and reports an
 * added directive left without a pair (`suppression-added`) for a human to
 * sanction. Only the diff is read, through git.
 *
 * Which files and directives count lives in the exported
 * `SUPPRESSION_DIRECTIVES`, read each time the check runs: a consumer appends
 * its own entry. A directive only counts right after a comment opener.
 */

import { execFile } from "node:child_process";

import type { CheckRecord } from "../index.js";
import { SANCTION_KEY } from "../weakened-tests.js";

export const name = "RT-31";

/** One directive. */
export interface SuppressionDirective {
  /** The directive a finding names. */
  readonly name: string;
  /** Tested against a changed path. */
  readonly files: RegExp;
  /** Tested against each line the range removes or adds in such a file. */
  readonly pattern: RegExp;
}

const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
/** A line comment opener, or a block one with any further asterisks, then white space. */
const OPENER = "(?:\\/\\/|\\/\\*+)\\s*";

function directive(label: string, words: string): SuppressionDirective {
  return { name: label, files: SOURCE_FILE, pattern: new RegExp(`${OPENER}${words}(?![\\w-])`) };
}

export const SUPPRESSION_DIRECTIVES: SuppressionDirective[] = [
  directive("@ts-ignore", "@ts-ignore"),
  directive("@ts-nocheck", "@ts-nocheck"),
  directive("@ts-expect-error", "@ts-expect-error"),
  directive("eslint-disable", "eslint-disable(?:-next-line|-line)?"),
  directive("istanbul ignore", "istanbul\\s+ignore"),
  directive("c8 ignore", "c8\\s+ignore"),
  directive("v8 ignore", "v8\\s+ignore"),
];

/** One directive the range added without a pair; `id` is `suppression-added:<file>:<line>`, the line in the candidate. */
export interface SuppressionFinding {
  readonly id: string;
  readonly category: "suppression-added";
  readonly file: string;
  readonly line: number;
  readonly name: string;
  /** The sanction's reason, or `null` while unsanctioned. */
  readonly sanction: string | null;
}

export interface SuppressionsRecord extends CheckRecord {
  readonly findings: readonly SuppressionFinding[];
}

/** `sanctions` keys are finding ids or `suppression-added:<file>`; values are the reasons. */
export interface SuppressionsOptions {
  readonly cwd: string;
  readonly base: string;
  readonly candidate: string;
  readonly sanctions?: Readonly<Record<string, string>> | undefined;
}

function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args as string[], { cwd, maxBuffer: 1024 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    });
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

async function resolveCommit(cwd: string, revision: string): Promise<string> {
  const fail = (cause: string): Error => new Error(`revision "${escapeText(String(revision))}" does not name a commit${cause}`);
  // A revision that begins with a dash would be read as an option.
  if (typeof revision !== "string" || revision.length === 0 || revision.startsWith("-")) throw fail("");
  let hash = "";
  try {
    hash = (await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`])).trim();
  } catch (error) {
    throw fail(`: ${(error as Error).message}`);
  }
  if (hash.length === 0) throw fail("");
  return hash;
}

interface Line {
  readonly number: number;
  readonly text: string;
}

interface Change {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly removed: Line[];
  readonly added: Line[];
}

const NO_LINES = { removed: [] as Line[], added: [] as Line[] };

function wholeFile(text: string): Line[] {
  return text.replace(/\n$/, "").split("\n").map((t, i) => ({ number: i + 1, text: t.replace(/\r$/, "") }));
}

/** The lines changed between two blobs; a missing side (`null`) is a file that is not there. */
async function diffBlobs(cwd: string, oldBlob: string | null, newBlob: string | null): Promise<{ removed: Line[]; added: Line[] }> {
  const blobs = new Map<string, string>();
  for (const blob of [oldBlob, newBlob]) if (blob !== null) blobs.set(blob, await runGit(cwd, ["cat-file", "blob", blob]));
  if ([...blobs.values()].some((text) => text.includes("\0"))) return NO_LINES;
  if (oldBlob === null || newBlob === null) {
    const only = oldBlob ?? newBlob;
    const lines = only === null ? [] : wholeFile(blobs.get(only) ?? "");
    return oldBlob === null ? { removed: [], added: lines } : { removed: lines, added: [] };
  }
  const out = await runGit(cwd, ["diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", oldBlob, newBlob]);
  const removed: Line[] = [];
  const added: Line[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const raw of out.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    const text = raw.slice(1).replace(/\r$/, "");
    if (hunk !== null) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
    } else if (inHunk && raw.startsWith("-")) removed.push({ number: oldLine++, text });
    else if (inHunk && raw.startsWith("+")) added.push({ number: newLine++, text });
  }
  return { removed, added };
}

async function readChanges(cwd: string, from: string, to: string): Promise<Change[]> {
  const out = await runGit(cwd, ["diff", "--raw", "-z", "--no-abbrev", "--find-renames", "--no-relative", from, to, "--"]);
  const fields = out.split("\0");
  const changes: Change[] = [];
  for (let i = 0; i < fields.length; i++) {
    const head = fields[i] ?? "";
    if (!head.startsWith(":")) continue;
    const [oldMode = "", newMode = "", oldSha = "", newSha = "", status = ""] = head.slice(1).split(" ");
    const first = fields[++i] ?? "";
    const second = status.startsWith("R") || status.startsWith("C") ? (fields[++i] ?? "") : first;
    const blob = (mode: string, sha: string): string | null => (mode.startsWith("100") ? sha : null);
    const lines = await diffBlobs(cwd, blob(oldMode, oldSha), blob(newMode, newSha));
    changes.push({ oldPath: status.startsWith("A") ? null : first, newPath: status.startsWith("D") ? null : second, ...lines });
  }
  return changes;
}

/** The line number of every match the entry finds in the lines, one per match. */
function hitsOf(entry: SuppressionDirective, path: string | null, lines: readonly Line[]): number[] {
  if (path === null || !new RegExp(entry.files.source, entry.files.flags.replace(/[gy]/g, "")).test(path)) return [];
  const pattern = new RegExp(entry.pattern.source, entry.pattern.flags.replace("g", "") + "g");
  return lines.flatMap((line) => [...line.text.matchAll(pattern)].map(() => line.number));
}

type Draft = Omit<SuppressionFinding, "id" | "sanction">;

function draftsOf(changes: readonly Change[], entries: readonly SuppressionDirective[]): Draft[] {
  const drafts: Draft[] = [];
  for (const change of changes) {
    for (const entry of entries) {
      const removed = hitsOf(entry, change.oldPath, change.removed);
      const added = hitsOf(entry, change.newPath, change.added);
      for (const line of added.slice(removed.length)) {
        drafts.push({ category: "suppression-added", file: change.newPath ?? "", line, name: entry.name });
      }
    }
  }
  return drafts.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
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

function sanctionFor(draft: Draft, id: string, lines: readonly string[], given: Readonly<Record<string, string>>): string | null {
  for (const key of [id, `${draft.category}:${draft.file}`]) {
    const reason = Object.hasOwn(given, key) ? given[key] : undefined;
    if (typeof reason === "string" && reason.trim().length > 0) return reason.trim();
    for (const line of lines) {
      const rest = line.slice(key.length);
      if (line.startsWith(key) && /^\s+\S/.test(rest)) return rest.trim();
    }
  }
  return null;
}

function describeFinding(finding: SuppressionFinding): string {
  const tail = finding.sanction === null ? "" : ` - sanctioned: ${finding.sanction}`;
  return `${escapeText(finding.file)}:${finding.line}: ${escapeText(`added ${finding.name}${tail}`)}`;
}

/**
 * Report the suppression directives `base..candidate` adds without a pair.
 * Fails while any finding is unsanctioned, and fails closed: a revision that
 * names no commit, or any git invocation that fails, is a `fail` record naming
 * the cause - never a `pass`, and never a thrown error.
 */
export async function check(options: SuppressionsOptions): Promise<SuppressionsRecord> {
  try {
    const { cwd, base, candidate } = options;
    const baseCommit = await resolveCommit(cwd, base);
    const candidateCommit = await resolveCommit(cwd, candidate);
    let ancestor: string;
    try {
      ancestor = (await runGit(cwd, ["merge-base", baseCommit, candidateCommit])).trim();
    } catch (error) {
      throw new Error(`no merge base of "${escapeText(base)}" and "${escapeText(candidate)}": ${(error as Error).message}`);
    }
    const drafts = draftsOf(await readChanges(cwd, ancestor, candidateCommit), SUPPRESSION_DIRECTIVES);
    const lines = drafts.length === 0 ? [] : await readSanctionLines(cwd, baseCommit, candidateCommit);
    const findings: SuppressionFinding[] = drafts.map((draft) => {
      const id = `${draft.category}:${draft.file}:${draft.line}`;
      return { id, ...draft, sanction: sanctionFor(draft, id, lines, options.sanctions ?? {}) };
    });
    if (findings.length === 0) return { name, status: "pass", evidence: ["no suppression directive added"], findings };
    const open = findings.some((finding) => finding.sanction === null);
    return { name, status: open ? "fail" : "pass", evidence: findings.map(describeFinding), findings };
  } catch (error) {
    return { name, status: "fail", evidence: [escapeText(error instanceof Error ? error.message : String(error))], findings: [] };
  }
}
