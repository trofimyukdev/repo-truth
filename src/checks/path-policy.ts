/**
 * Path policy.
 *
 * Which paths a change should not reach without a second look is the
 * repository's to say, so this check holds no list: it reads `forbidden` and
 * `allowed` from its options and reports each path the range adds, changes,
 * deletes or renames - both ends of a rename - that a `forbidden` pattern
 * matches or, when `allowed` is given, that no `allowed` pattern matches.
 *
 * Paths come from git's list of the changes between the merge base and the
 * candidate, never from the working tree. A pattern is matched against a whole
 * path: `?` is one character but `/`, `*` is any run but `/`, a segment that
 * is exactly `**` is any number of whole segments (none included), and every
 * other character - case included - matches only itself.
 */

import { execFile } from "node:child_process";

import type { CheckRecord } from "../index.js";
import { SANCTION_KEY } from "../weakened-tests.js";

export const name = "RT-57";

/** The options a configuration file may set for this check. */
export const optionKinds = { forbidden: "strings", allowed: "strings" };

export interface PathPolicyOptions {
  readonly cwd: string;
  readonly base: string;
  readonly candidate: string;
  /** Ids (`<category>:<path>`) mapped to reasons. */
  readonly sanctions?: Readonly<Record<string, string>> | undefined;
  readonly forbidden?: readonly string[] | undefined;
  readonly allowed?: readonly string[] | undefined;
}

function matchSegment(pattern: string, text: string): boolean {
  // `**` that is not a whole segment reads as two `*`, which is one `*`.
  let p = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  while (t < text.length) {
    const c = pattern[p];
    if (c === "*") {
      star = p++;
      resume = t;
    } else if (p < pattern.length && (c === "?" || c === text[t])) {
      p++;
      t++;
    } else if (star >= 0) {
      p = star + 1;
      t = ++resume;
    } else return false;
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

function matchSegments(pattern: readonly string[], path: readonly string[], p: number, s: number): boolean {
  if (p === pattern.length) return s === path.length;
  if (pattern[p] === "**") {
    while (pattern[p + 1] === "**") p++;
    for (let skip = s; skip <= path.length; skip++) if (matchSegments(pattern, path, p + 1, skip)) return true;
    return false;
  }
  return s < path.length && matchSegment(pattern[p] as string, path[s] as string) && matchSegments(pattern, path, p + 1, s + 1);
}

/** Whether one pattern matches one whole path. */
export function matchesPattern(pattern: string, path: string): boolean {
  return matchSegments(pattern.split("/"), path.split("/"), 0, 0);
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

/** Every path a change names, once: both ends of a rename. */
async function judgedPaths(cwd: string, from: string, to: string): Promise<string[]> {
  const out = await runGit(cwd, ["diff", "--raw", "-z", "-M", "--no-abbrev", "--no-ext-diff", "--no-relative", from, to, "--"]);
  const fields = out.split("\0");
  const paths = new Set<string>();
  for (let i = 0; i < fields.length; i++) {
    const head = fields[i] ?? "";
    if (!head.startsWith(":")) continue;
    const status = head.slice(1).split(" ")[4] ?? "";
    const count = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
    for (let k = 0; k < count; k++) paths.add(fields[++i] ?? "");
  }
  return [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

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

function patternList(option: string, value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`option "${option}" is not an array of strings`);
  }
  return value as string[];
}

/**
 * Report each path `base..candidate` touches that the policy forbids or does
 * not allow. Fails while any finding is unsanctioned, and fails closed: a bad
 * revision, a bad option or a failing git invocation is a `fail` record naming
 * the cause - never a `pass`, never a throw.
 */
export async function check(options: PathPolicyOptions): Promise<CheckRecord> {
  try {
    const { cwd, base, candidate } = options;
    const baseCommit = await resolveCommit(cwd, base);
    const candidateCommit = await resolveCommit(cwd, candidate);
    const forbidden = patternList("forbidden", options.forbidden);
    const allowed = patternList("allowed", options.allowed);
    if (forbidden.length === 0 && allowed.length === 0) {
      return { name, status: "skip", evidence: ["no path policy is configured"] };
    }
    let ancestor: string;
    try {
      ancestor = (await runGit(cwd, ["merge-base", baseCommit, candidateCommit])).trim();
    } catch (error) {
      throw new Error(`no merge base of "${escapeText(base)}" and "${escapeText(candidate)}": ${(error as Error).message}`);
    }
    const paths = await judgedPaths(cwd, ancestor, candidateCommit);
    const drafts: { id: string; path: string; category: string; pattern: string | null }[] = [];
    for (const path of paths) {
      const hit = forbidden.find((pattern) => matchesPattern(pattern, path));
      if (hit !== undefined) drafts.push({ id: `path-forbidden:${path}`, path, category: "path-forbidden", pattern: hit });
      if (allowed.length > 0 && !allowed.some((pattern) => matchesPattern(pattern, path))) {
        drafts.push({ id: `path-not-allowed:${path}`, path, category: "path-not-allowed", pattern: null });
      }
    }
    if (drafts.length === 0) return { name, status: "pass", evidence: ["no path outside the policy"] };
    const lines = await readSanctionLines(cwd, baseCommit, candidateCommit);
    let open = false;
    const evidence = drafts.map((draft) => {
      const reason = sanctionFor(draft.id, lines, options.sanctions ?? {});
      if (reason === null) open = true;
      const pattern = draft.pattern === null ? "" : ` "${escapeText(draft.pattern)}"`;
      const tail = reason === null ? "" : ` - sanctioned: ${escapeText(reason)}`;
      return `${escapeText(draft.path)}: ${draft.category}${pattern}${tail}`;
    });
    return { name, status: open ? "fail" : "pass", evidence };
  } catch (error) {
    return { name, status: "fail", evidence: [escapeText(error instanceof Error ? error.message : String(error))] };
  }
}
