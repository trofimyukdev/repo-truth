/**
 * Weakened workflows.
 *
 * The cheapest way to turn a red check green is to change the workflow rather
 * than the code. This check reads every workflow file the range deletes, adds,
 * changes or renames, whole and through git at the merge base and at the
 * candidate, and reports each workflow the range removes (`workflow-removed`)
 * and each line of a weakening shape (`WEAKENING_SHAPES`) that the candidate's
 * file holds more often than its source did. A line moved or re-indented is not
 * a new line. The YAML is not parsed, and the working tree is never read.
 *
 * A finding's id is `<category>:<file>`; it is sanctioned by a
 * `Sanctioned-Weakening: <id> <reason>` line in a commit message of the range
 * or by the caller's `sanctions`.
 */

import { execFile } from "node:child_process";

import type { CheckRecord } from "../index.js";
import { SANCTION_KEY } from "../weakened-tests.js";

export const name = "RT-56";

export interface WeakeningShape {
  readonly category: string;
  /** Tested against a line's text with white space at both ends removed. */
  readonly pattern: RegExp;
}

const KEY_END = String.raw`\s*(?:#.*)?$`;

/** The shapes a line may have. A consumer appends to this array; it is read at each run. */
export const WEAKENING_SHAPES: WeakeningShape[] = [
  {
    category: "continue-on-error",
    pattern: new RegExp(String.raw`^(?:-\s+)?continue-on-error\s*:\s*(?:["']?true["']?|\$\{\{\s*true\s*\}\})` + KEY_END),
  },
  {
    category: "if-false",
    pattern: new RegExp(String.raw`^(?:-\s+)?if\s*:\s*(?:["']?false["']?|\$\{\{\s*false\s*\}\})` + KEY_END),
  },
  { category: "or-true", pattern: new RegExp(String.raw`\|\|\s*(?:true|:|exit\s+0)` + KEY_END) },
];

export interface WorkflowWeakeningOptions {
  readonly cwd: string;
  readonly base: string;
  readonly candidate: string;
  /** Ids (`<category>:<file>`) mapped to reasons. */
  readonly sanctions?: Readonly<Record<string, string>> | undefined;
}

function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args as string[], { cwd, maxBuffer: 1024 * 1024 * 1024, encoding: "buffer" }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.toString("utf8").trim() || error.message));
      else resolve(stdout.toString("utf8"));
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

const isWorkflowPath = (path: string): boolean => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path);
const isNull = (sha: string): boolean => /^0+$/.test(sha);

/** A blob read whole through git; an absent blob is an empty file. */
const readBlob = async (cwd: string, sha: string): Promise<string> =>
  isNull(sha) ? "" : runGit(cwd, ["cat-file", "blob", sha]);

/** How many times each line's text occurs, lines being split at line feeds, one CR dropped, white space trimmed. */
function countLines(content: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const raw of content.split("\n")) {
    const text = (raw.endsWith("\r") ? raw.slice(0, -1) : raw).trim();
    if (text.length > 0) counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return counts;
}

interface Draft {
  readonly category: string;
  readonly file: string;
  /** The line's text, or `null` for a removed workflow. */
  readonly line: string | null;
}

async function compare(cwd: string, from: string, to: string): Promise<Draft[]> {
  const out = await runGit(cwd, ["diff", "--raw", "-z", "-M", "--no-abbrev", "--no-ext-diff", "--no-relative", from, to, "--"]);
  const fields = out.split("\0");
  const drafts: Draft[] = [];
  for (let i = 0; i < fields.length; i++) {
    const head = fields[i] ?? "";
    if (!head.startsWith(":")) continue;
    const [, , oldSha = "", newSha = "", status = ""] = head.slice(1).split(" ");
    const moved = status.startsWith("R") || status.startsWith("C");
    const oldPath = fields[++i] ?? "";
    const newPath = moved ? (fields[++i] ?? "") : oldPath;
    const letter = status.charAt(0);
    if (letter === "D" || (letter === "R" && !isWorkflowPath(newPath))) {
      if (isWorkflowPath(oldPath)) drafts.push({ category: "workflow-removed", file: oldPath, line: null });
      continue;
    }
    if (!["A", "M", "R", "C", "T"].includes(letter) || !isWorkflowPath(newPath)) continue;
    const fromWorkflow = (letter === "M" || letter === "T" || letter === "R") && isWorkflowPath(oldPath);
    const before = countLines(fromWorkflow ? await readBlob(cwd, oldSha) : "");
    const after = countLines(await readBlob(cwd, newSha));
    for (const [text, count] of after) {
      if (count <= (before.get(text) ?? 0)) continue;
      const shape = WEAKENING_SHAPES.find((entry) => entry.pattern.test(text));
      if (shape !== undefined) drafts.push({ category: shape.category, file: newPath, line: text });
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

function sanctionFor(id: string, lines: readonly string[], given: Readonly<Record<string, string>>): string | null {
  const reason = Object.hasOwn(given, id) ? given[id] : undefined;
  if (typeof reason === "string" && reason.trim().length > 0) return reason.trim();
  for (const line of lines) {
    const rest = line.slice(id.length);
    if (line.startsWith(id) && /^\s+\S/.test(rest)) return rest.trim();
  }
  return null;
}

/**
 * Report each workflow `base..candidate` removes and each weakening line it adds.
 * Fails while any finding is unsanctioned, and fails closed: a revision that
 * names no commit, or any git invocation that fails, is a `fail` record naming
 * the cause - never a `pass`, never a throw.
 */
export async function check(options: WorkflowWeakeningOptions): Promise<CheckRecord> {
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
    const drafts = await compare(cwd, ancestor, candidateCommit);
    if (drafts.length === 0) return { name, status: "pass", evidence: ["no workflow weakened"] };
    const lines = await readSanctionLines(cwd, baseCommit, candidateCommit);
    let open = false;
    const evidence = drafts.map((draft) => {
      const reason = sanctionFor(`${draft.category}:${draft.file}`, lines, options.sanctions ?? {});
      if (reason === null) open = true;
      const quoted = draft.line === null ? "" : ` "${escapeText(draft.line)}"`;
      const tail = reason === null ? "" : ` - sanctioned: ${escapeText(reason)}`;
      return `${escapeText(draft.file)}: ${draft.category}${quoted}${tail}`;
    });
    return { name, status: open ? "fail" : "pass", evidence };
  } catch (error) {
    return { name, status: "fail", evidence: [escapeText(error instanceof Error ? error.message : String(error))] };
  }
}
