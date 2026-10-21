/**
 * Binary files.
 *
 * A review reads a range line by line and a binary file has no lines: what the
 * range adds of it enters the history whole and unreviewed. This check reads
 * the files the range adds, changes or renames, through git at the candidate,
 * and reports each whose new content is binary by git's own test - a NUL byte
 * among its first `BINARY_PROBE_BYTES` bytes - and was not already that same
 * content at the merge base. The file's name and `.gitattributes` decide
 * nothing, and neither does the working tree.
 *
 * A finding is `binary-changed` when the file's source blob at the merge base
 * is binary too, and `binary-added` otherwise. It is sanctioned by a
 * `Sanctioned-Weakening: <category>:<path> <reason>` line in a commit message
 * of the range or by the caller's `sanctions`. A path ending with one of the
 * caller's `allowedSuffixes` yields no finding.
 */

import { execFile } from "node:child_process";

import type { CheckRecord } from "../index.js";
import { SANCTION_KEY } from "../weakened-tests.js";

export const name = "RT-55";

/** The number of leading bytes git looks at for a NUL byte. */
export const BINARY_PROBE_BYTES = 8000;

/** The option a configuration file may set for this check. */
export const optionKinds = { allowedSuffixes: "strings" };

export type BinaryCategory = "binary-added" | "binary-changed";

export interface BinaryFilesOptions {
  readonly cwd: string;
  readonly base: string;
  readonly candidate: string;
  /** Ids (`<category>:<path>`) mapped to reasons. */
  readonly sanctions?: Readonly<Record<string, string>> | undefined;
  /** Paths ending with one of these strings yield no finding. */
  readonly allowedSuffixes?: readonly string[] | undefined;
}

export interface BinaryFinding {
  readonly id: string;
  readonly category: BinaryCategory;
  readonly path: string;
  readonly size: number;
  /** The sanction's reason, or `null` while unsanctioned. */
  readonly sanction: string | null;
}

export interface BinaryFilesRecord extends CheckRecord {
  readonly findings: readonly BinaryFinding[];
}

function runGit(cwd: string, args: readonly string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile("git", args as string[], { cwd, maxBuffer: 1024 * 1024 * 1024, encoding: "buffer" }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.toString("utf8").trim() || error.message));
      else resolve(stdout);
    });
  });
}

const runText = async (cwd: string, args: readonly string[]): Promise<string> => (await runGit(cwd, args)).toString("utf8");

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
    hash = (await runText(cwd, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`])).trim();
  } catch (error) {
    throw fail(`: ${(error as Error).message}`);
  }
  if (hash.length === 0) throw fail("");
  return hash;
}

const isNull = (sha: string): boolean => /^0+$/.test(sha);

/** A blob's content read through git, or `null` when there is no such blob. */
async function readBlob(cwd: string, sha: string): Promise<Buffer | null> {
  return isNull(sha) ? null : runGit(cwd, ["cat-file", "blob", sha]);
}

const isBinary = (content: Buffer): boolean => content.subarray(0, BINARY_PROBE_BYTES).includes(0);

interface Draft {
  readonly category: BinaryCategory;
  readonly path: string;
  readonly size: number;
}

async function compare(cwd: string, from: string, to: string, allowed: readonly string[]): Promise<Draft[]> {
  const out = await runText(cwd, ["diff", "--raw", "-z", "-M", "--no-abbrev", "--no-ext-diff", "--no-relative", from, to, "--"]);
  const fields = out.split("\0");
  const drafts: Draft[] = [];
  for (let i = 0; i < fields.length; i++) {
    const head = fields[i] ?? "";
    if (!head.startsWith(":")) continue;
    const [, newMode = "", oldSha = "", newSha = "", status = ""] = head.slice(1).split(" ");
    i++;
    const moved = status.startsWith("R") || status.startsWith("C");
    const path = moved ? (fields[++i] ?? "") : (fields[i] ?? "");
    const letter = status.charAt(0);
    if (!["A", "M", "R", "C", "T"].includes(letter)) continue;
    if (newMode !== "100644" && newMode !== "100755") continue;
    // A copy git does not list as a rename is an added file.
    const sourceSha = letter === "A" || letter === "C" ? "" : oldSha;
    if (sourceSha !== "" && sourceSha === newSha) continue;
    if (allowed.some((suffix) => suffix.length > 0 && path.endsWith(suffix))) continue;
    const content = await readBlob(cwd, newSha);
    if (content === null || !isBinary(content)) continue;
    const source = sourceSha === "" ? null : await readBlob(cwd, sourceSha);
    drafts.push({ category: source !== null && isBinary(source) ? "binary-changed" : "binary-added", path, size: content.length });
  }
  const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return drafts.sort((a, b) => order(a.path, b.path) || order(a.category, b.category));
}

/** The text after the sanction key on every such line of the range's commit messages. */
async function readSanctionLines(cwd: string, from: string, to: string): Promise<string[]> {
  const out = await runText(cwd, ["log", "--format=%B%x00", `${from}..${to}`, "--"]);
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

function describeFinding(finding: BinaryFinding): string {
  const tail = finding.sanction === null ? "" : ` - sanctioned: ${escapeText(finding.sanction)}`;
  return `${escapeText(finding.path)}: ${finding.category}, ${finding.size} bytes${tail}`;
}

/**
 * Report each file `base..candidate` adds or changes into binary content.
 * Fails while any finding is unsanctioned, and fails closed: a revision that
 * names no commit, or any git invocation that fails, is a `fail` record naming
 * the cause - never a `pass`, never a throw.
 */
export async function check(options: BinaryFilesOptions): Promise<BinaryFilesRecord> {
  try {
    const { cwd, base, candidate } = options;
    const baseCommit = await resolveCommit(cwd, base);
    const candidateCommit = await resolveCommit(cwd, candidate);
    let ancestor: string;
    try {
      ancestor = (await runText(cwd, ["merge-base", baseCommit, candidateCommit])).trim();
    } catch (error) {
      throw new Error(`no merge base of "${escapeText(base)}" and "${escapeText(candidate)}": ${(error as Error).message}`);
    }
    const drafts = await compare(cwd, ancestor, candidateCommit, options.allowedSuffixes ?? []);
    const lines = drafts.length === 0 ? [] : await readSanctionLines(cwd, baseCommit, candidateCommit);
    const findings: BinaryFinding[] = drafts.map((draft) => {
      const id = `${draft.category}:${draft.path}`;
      return { id, ...draft, sanction: sanctionFor(id, lines, options.sanctions ?? {}) };
    });
    if (findings.length === 0) return { name, status: "pass", evidence: ["no binary file added or changed"], findings };
    const open = findings.some((finding) => finding.sanction === null);
    return { name, status: open ? "fail" : "pass", evidence: findings.map(describeFinding), findings };
  } catch (error) {
    return { name, status: "fail", evidence: [escapeText(error instanceof Error ? error.message : String(error))], findings: [] };
  }
}
