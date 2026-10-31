/**
 * Bidirectional controls.
 *
 * Nine Unicode characters - U+202A, U+202B, U+202C, U+202D, U+202E (the
 * embeddings and overrides) and U+2066, U+2067, U+2068, U+2069 (the isolates) -
 * reorder the text around them when it is shown and do nothing when a compiler
 * reads it, so a line holding them reads one way to a reviewer and runs another
 * (CVE-2021-42574, "Trojan Source"). This check reads every path
 * `base..candidate` adds, changes or renames onto whose entry at the candidate
 * is a regular file (mode 100644 or 100755), whole through git at the merge
 * base of `base` and `candidate` and at the candidate, renames detected, never
 * from the working tree. A symbolic link or a gitlink is never read, and a file
 * holding a NUL byte is not text: such a candidate yields nothing and such a
 * source counts as none.
 *
 * Text is read as UTF-8 and split at line feeds, one carriage return at a
 * line's end dropped. A line is added when the candidate's file holds its text,
 * white space at both ends removed, more often than the source file held it -
 * the file at the merge base, the one a rename came from, or none for a file
 * the range adds. A moved or re-indented line is not added, and a text added
 * more than once counts once.
 *
 * A file whose added lines hold at least one of the nine is one finding
 * `bidi-control`, its evidence line `<file>: bidi-control <characters>`: each
 * distinct character, `U+` and four upper-case hexadecimal digits, ascending,
 * joined by a comma. The finding's id is `bidi-control:<file>`, sanctioned by a
 * `Sanctioned-Weakening: <id> <reason>` line in a commit message of the range
 * or by the caller's `sanctions`; the reason ends the evidence line.
 */

import { execFile } from "node:child_process";

import type { CheckRecord } from "../index.js";
import { SANCTION_KEY } from "../weakened-tests.js";

export const name = "RT-93";

const CONTROLS = /[\u202a-\u202e\u2066-\u2069]/g;

export interface BidiControlsOptions {
  readonly cwd: string;
  readonly base: string;
  readonly candidate: string;
  /** Ids (or `bidi-control:<file>`) mapped to reasons. */
  readonly sanctions?: Readonly<Record<string, string>> | undefined;
}

/** One file whose added lines hold the nine. */
export interface BidiControlFinding {
  readonly id: string;
  readonly category: "bidi-control";
  readonly file: string;
  /** Each distinct character, as `U+XXXX`, ascending. */
  readonly characters: readonly string[];
  /** The sanction's reason, or `null` while unsanctioned. */
  readonly sanction: string | null;
}

export interface BidiControlsRecord extends CheckRecord {
  readonly findings: readonly BidiControlFinding[];
}

function runGit(cwd: string, args: readonly string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile("git", args as string[], { cwd, maxBuffer: 1024 * 1024 * 1024, encoding: "buffer" }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.toString("utf8").trim() || error.message));
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
    hash = (await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`])).toString("utf8").trim();
  } catch (error) {
    throw fail(`: ${(error as Error).message}`);
  }
  if (hash.length === 0) throw fail("");
  return hash;
}

const REGULAR = new Set(["100644", "100755"]);

/** A blob's lines, trimmed, counted; `null` for no entry, or a file holding a NUL byte. */
async function readTexts(cwd: string, mode: string, sha: string): Promise<Map<string, number> | null> {
  if (!REGULAR.has(mode)) return null;
  const bytes = await runGit(cwd, ["cat-file", "blob", sha]);
  if (bytes.includes(0)) return null;
  const counts = new Map<string, number>();
  for (const raw of bytes.toString("utf8").split("\n")) {
    const text = raw.replace(/\r$/, "").trim();
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return counts;
}

interface Draft {
  readonly file: string;
  readonly characters: string[];
}

async function readDrafts(cwd: string, from: string, to: string): Promise<Draft[]> {
  const out = (await runGit(cwd, ["diff", "--raw", "-z", "--no-abbrev", "--find-renames", "--no-relative", from, to, "--"])).toString("utf8");
  const fields = out.split("\0");
  const drafts: Draft[] = [];
  for (let i = 0; i < fields.length; i++) {
    const head = fields[i] ?? "";
    if (!head.startsWith(":")) continue;
    const [oldMode = "", newMode = "", oldSha = "", newSha = "", status = ""] = head.slice(1).split(" ");
    const first = fields[++i] ?? "";
    const renamed = status.startsWith("R") || status.startsWith("C");
    const file = renamed ? (fields[++i] ?? "") : first;
    if (status.startsWith("D")) continue;
    const now = await readTexts(cwd, newMode, newSha);
    if (now === null) continue;
    const before = status.startsWith("A") ? null : await readTexts(cwd, oldMode, oldSha);
    const found = new Set<string>();
    for (const [text, count] of now) {
      if (count <= (before?.get(text) ?? 0)) continue;
      for (const char of text.match(CONTROLS) ?? []) found.add(`U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`);
    }
    if (found.size > 0) drafts.push({ file, characters: [...found].sort() });
  }
  return drafts.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/** The text after the sanction key on every such line of the range's commit messages. */
async function readSanctionLines(cwd: string, from: string, to: string): Promise<string[]> {
  const out = (await runGit(cwd, ["log", "--format=%B%x00", `${from}..${to}`, "--"])).toString("utf8");
  const prefix = `${SANCTION_KEY}:`;
  return out
    .split(/[\n\0]/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length).trim());
}

function sanctionFor(id: string, lines: readonly string[], given: Readonly<Record<string, string>>): string | null {
  const reason = Object.hasOwn(given, id) ? given[id] : undefined;
  if (typeof reason === "string" && reason.trim().length > 0) return reason.trim();
  for (const line of lines) {
    const rest = line.slice(id.length);
    if (line.startsWith(id) && /^\s+\S/.test(rest)) return rest.trim();
  }
  return null;
}

function describeFinding(finding: BidiControlFinding): string {
  const tail = finding.sanction === null ? "" : ` - sanctioned: ${escapeText(finding.sanction)}`;
  return `${escapeText(finding.file)}: bidi-control ${finding.characters.join(",")}${tail}`;
}

/**
 * Report each file `base..candidate` adds a line holding one of the nine to.
 * Fails while any finding is unsanctioned, and fails closed: a revision that
 * names no commit, or any git invocation that fails, is a `fail` record naming
 * the cause - never a `pass`, never a throw.
 */
export async function check(options: BidiControlsOptions): Promise<BidiControlsRecord> {
  try {
    const { cwd, base, candidate } = options;
    const baseCommit = await resolveCommit(cwd, base);
    const candidateCommit = await resolveCommit(cwd, candidate);
    let ancestor: string;
    try {
      ancestor = (await runGit(cwd, ["merge-base", baseCommit, candidateCommit])).toString("utf8").trim();
    } catch (error) {
      throw new Error(`no merge base of "${escapeText(base)}" and "${escapeText(candidate)}": ${(error as Error).message}`);
    }
    const drafts = await readDrafts(cwd, ancestor, candidateCommit);
    const lines = drafts.length === 0 ? [] : await readSanctionLines(cwd, baseCommit, candidateCommit);
    const findings: BidiControlFinding[] = drafts.map((draft) => {
      const id = `bidi-control:${draft.file}`;
      return { id, category: "bidi-control", ...draft, sanction: sanctionFor(id, lines, options.sanctions ?? {}) };
    });
    if (findings.length === 0) return { name, status: "pass", evidence: ["no bidirectional control character added"], findings };
    const open = findings.some((finding) => finding.sanction === null);
    return { name, status: open ? "fail" : "pass", evidence: findings.map(describeFinding), findings };
  } catch (error) {
    return { name, status: "fail", evidence: [escapeText(error instanceof Error ? error.message : String(error))], findings: [] };
  }
}
