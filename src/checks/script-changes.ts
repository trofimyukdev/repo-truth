/**
 * Ladder commands changed.
 *
 * A repository's checks run through its manifest: `npm test` runs whatever the
 * `test` entry of `scripts` says. This check reads every package.json the range
 * adds, deletes, changes or renames, at the root or below it, whole at the
 * merge base and at the candidate through git, and reports each entry of
 * `scripts` the range adds (`script-added`), removes (`script-removed`) or
 * changes (`script-changed`) for a human to sanction. Another field, the order
 * of the keys and white space say nothing. A manifest that cannot be read as a
 * JSON object at either end, or whose `scripts` is not an object of strings, is
 * a failure that names it.
 *
 * A finding is sanctioned by a `Sanctioned-Weakening: <id> <reason>` line in a
 * commit message of the range or by the caller's `sanctions`. Its id is
 * `<category>:<file>:<key>`; `<category>:<file>` sanctions every finding of
 * that category in that file.
 */

import { execFile } from "node:child_process";

import type { CheckRecord } from "../index.js";
import { SANCTION_KEY } from "../weakened-tests.js";

export const name = "RT-33";

export type ScriptCategory = "script-added" | "script-removed" | "script-changed";

export interface ScriptChangesOptions {
  readonly cwd: string;
  readonly base: string;
  readonly candidate: string;
  /** Ids (or `<category>:<file>`) mapped to reasons. */
  readonly sanctions?: Readonly<Record<string, string>> | undefined;
}

/** One entry of `scripts` the range added, removed or changed. */
export interface ScriptFinding {
  readonly id: string;
  readonly category: ScriptCategory;
  readonly file: string;
  readonly key: string;
  /** The command at the merge base; `null` when the entry is added. */
  readonly before: string | null;
  /** The command at the candidate; `null` when the entry is removed. */
  readonly after: string | null;
  /** The sanction's reason, or `null` while unsanctioned. */
  readonly sanction: string | null;
}

export interface ScriptChangesRecord extends CheckRecord {
  readonly findings: readonly ScriptFinding[];
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

/** A string in double quotes, with everything outside printable ASCII escaped. */
const quoted = (text: string): string => `"${escapeText(text).replace(/"/g, '\\"')}"`;

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

/** A manifest at one end: its `scripts`, or the reason it cannot be read. */
type Scripts = { readonly scripts: ReadonlyMap<string, string> } | { readonly problem: string };

const NO_SCRIPTS: Scripts = { scripts: new Map() };

async function readScripts(cwd: string, mode: string, sha: string): Promise<Scripts> {
  if (/^0+$/.test(sha)) return NO_SCRIPTS;
  if (!mode.startsWith("100")) return { problem: "is not a regular file" };
  let parsed: unknown;
  try {
    parsed = JSON.parse((await runGit(cwd, ["cat-file", "blob", sha])).replace(/^﻿/, ""));
  } catch (error) {
    return { problem: `is not JSON: ${(error as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { problem: "is not a JSON object" };
  if (!Object.hasOwn(parsed, "scripts")) return NO_SCRIPTS;
  const scripts: unknown = (parsed as Record<string, unknown>)["scripts"];
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) return { problem: "has a scripts field that is not an object" };
  const entries = Object.entries(scripts);
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === "string")) {
    return { problem: "has a scripts field whose values are not all strings" };
  }
  return { scripts: new Map(entries) };
}

const isManifest = (path: string): boolean => path === "package.json" || path.endsWith("/package.json");

interface Compared {
  readonly drafts: Omit<ScriptFinding, "id" | "sanction">[];
  readonly problems: string[];
}

async function compare(cwd: string, from: string, to: string): Promise<Compared> {
  const out = await runGit(cwd, ["diff", "--raw", "-z", "--no-abbrev", "--find-renames", "--no-relative", from, to, "--"]);
  const fields = out.split("\0");
  const drafts: Compared["drafts"] = [];
  const problems: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const head = fields[i] ?? "";
    if (!head.startsWith(":")) continue;
    const [oldMode = "", newMode = "", oldSha = "", newSha = "", status = ""] = head.slice(1).split(" ");
    const first = fields[++i] ?? "";
    const renamed = status.startsWith("R") || status.startsWith("C");
    const second = renamed ? (fields[++i] ?? "") : first;
    const oldPath = status.startsWith("A") ? null : first;
    const newPath = status.startsWith("D") ? null : second;
    const oldHere = oldPath !== null && isManifest(oldPath);
    const newHere = newPath !== null && isManifest(newPath);
    if (!oldHere && !newHere) continue;
    const file = newHere ? newPath : (oldPath ?? "");
    const before = oldHere ? await readScripts(cwd, oldMode, oldSha) : NO_SCRIPTS;
    const after = newHere ? await readScripts(cwd, newMode, newSha) : NO_SCRIPTS;
    if ("problem" in before) problems.push(`${escapeText(oldPath ?? file)}: at the merge base the manifest ${escapeText(before.problem)}`);
    if ("problem" in after) problems.push(`${escapeText(file)}: at the candidate the manifest ${escapeText(after.problem)}`);
    if ("problem" in before || "problem" in after) continue;
    for (const [key, command] of after.scripts) {
      const old = before.scripts.get(key);
      if (old === undefined) drafts.push({ category: "script-added", file, key, before: null, after: command });
      else if (old !== command) drafts.push({ category: "script-changed", file, key, before: old, after: command });
    }
    for (const [key, command] of before.scripts) {
      if (!after.scripts.has(key)) drafts.push({ category: "script-removed", file, key, before: command, after: null });
    }
  }
  const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  drafts.sort((a, b) => order(a.file, b.file) || order(a.key, b.key));
  return { drafts, problems };
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

function sanctionFor(category: string, file: string, id: string, lines: readonly string[], given: Readonly<Record<string, string>>): string | null {
  for (const key of [id, `${category}:${file}`]) {
    const reason = Object.hasOwn(given, key) ? given[key] : undefined;
    if (typeof reason === "string" && reason.trim().length > 0) return reason.trim();
    for (const line of lines) {
      const rest = line.slice(key.length);
      if (line.startsWith(key) && /^\s+\S/.test(rest)) return rest.trim();
    }
  }
  return null;
}

function describeFinding(finding: ScriptFinding): string {
  const key = quoted(finding.key);
  let text: string;
  if (finding.category === "script-added") text = `added ${key}: ${quoted(finding.after ?? "")}`;
  else if (finding.category === "script-removed") text = `removed ${key}: ${quoted(finding.before ?? "")}`;
  else text = `changed ${key}: ${quoted(finding.before ?? "")} -> ${quoted(finding.after ?? "")}`;
  const tail = finding.sanction === null ? "" : ` - sanctioned: ${escapeText(finding.sanction)}`;
  return `${escapeText(finding.file)}: ${text}${tail}`;
}

/**
 * Report each `scripts` entry `base..candidate` adds, removes or changes.
 * Fails while any finding is unsanctioned or a manifest cannot be read, and
 * fails closed: a revision that names no commit, or any git invocation that
 * fails, is a `fail` record naming the cause - never a `pass`, never a throw.
 */
export async function check(options: ScriptChangesOptions): Promise<ScriptChangesRecord> {
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
    const { drafts, problems } = await compare(cwd, ancestor, candidateCommit);
    const lines = drafts.length === 0 ? [] : await readSanctionLines(cwd, baseCommit, candidateCommit);
    const findings: ScriptFinding[] = drafts.map((draft) => {
      const id = `${draft.category}:${draft.file}:${draft.key}`;
      return { id, ...draft, sanction: sanctionFor(draft.category, draft.file, id, lines, options.sanctions ?? {}) };
    });
    if (findings.length === 0 && problems.length === 0) {
      return { name, status: "pass", evidence: ["no scripts entry added, removed or changed"], findings };
    }
    const open = problems.length > 0 || findings.some((finding) => finding.sanction === null);
    return { name, status: open ? "fail" : "pass", evidence: [...problems, ...findings.map(describeFinding)], findings };
  } catch (error) {
    return { name, status: "fail", evidence: [escapeText(error instanceof Error ? error.message : String(error))], findings: [] };
  }
}
