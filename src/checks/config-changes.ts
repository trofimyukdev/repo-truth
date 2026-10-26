/**
 * Configuration file changed.
 *
 * The command reads its settings from one file, so a range that loosens that
 * file is judged by what it found, and every later range by the loosened
 * settings. This check fails a range that adds, changes, deletes or renames the
 * file the run's settings were read from.
 *
 * The file it watches: with no `config` option (no `--config`), repo-truth.json
 * at the top directory of the repository, by that path, from any directory of
 * the repository; with `config`, that path, read against `cwd` when relative, when
 * its directory (symbolic links resolved) is the top directory or below it. A
 * file outside the repository is one no range can change: a `skip` naming it.
 * A revision that names no commit, a git that fails or a `config` path whose
 * directory cannot be read is a `fail`.
 *
 * The range is read through git, from the merge base of `base` and `candidate`
 * to `candidate`, renames detected; the working tree is never read. An entry
 * that names the watched path, on either side of a rename, is a finding of
 * category `config-added`, `config-changed`, `config-deleted` or
 * `config-renamed`, in one evidence line `<file>: <category>`.
 *
 * A finding is sanctioned by a `Sanctioned-Weakening: <id> <reason>` line in a
 * commit message of the range or by the caller's `sanctions`. Its id is
 * `<category>:<file>`. The check declares no options.
 */

import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { CheckRecord } from "../index.js";
import { SANCTION_KEY } from "../weakened-tests.js";

export const name = "RT-66";

export type ConfigCategory = "config-added" | "config-changed" | "config-deleted" | "config-renamed";

export interface ConfigChangesOptions {
  readonly cwd: string;
  readonly base: string;
  readonly candidate: string;
  /** The path `--config` named; absent when the settings were read from repo-truth.json. */
  readonly config?: string | undefined;
  /** Ids mapped to reasons. */
  readonly sanctions?: Readonly<Record<string, string>> | undefined;
}

export interface ConfigFinding {
  readonly id: string;
  readonly category: ConfigCategory;
  readonly file: string;
  /** The other path of a rename; `null` otherwise. */
  readonly other: string | null;
  /** The sanction's reason, or `null` while unsanctioned. */
  readonly sanction: string | null;
}

export interface ConfigChangesRecord extends CheckRecord {
  readonly findings: readonly ConfigFinding[];
}

function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile("git", args as string[], { cwd, maxBuffer: 1024 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolvePromise(stdout);
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

/** The watched path from the top directory, or `null` when the file is outside the repository. */
async function watchedPath(cwd: string, config: string | undefined): Promise<string | null> {
  if (config === undefined) return "repo-truth.json";
  const top = await realpath((await runGit(cwd, ["rev-parse", "--show-toplevel"])).replace(/\n$/, ""));
  const absolute = isAbsolute(config) ? config : resolve(cwd, config);
  let directory: string;
  try {
    directory = await realpath(dirname(absolute));
  } catch (error) {
    throw new Error(`${escapeText(config)}: cannot read the directory of the configuration file (${(error as Error).message})`);
  }
  const path = relative(top, join(directory, basename(absolute)));
  if (path === "" || path === ".." || path.startsWith("../") || isAbsolute(path)) return null;
  return path.split("\\").join("/");
}

interface Draft {
  readonly category: ConfigCategory;
  readonly other: string | null;
}

async function compare(cwd: string, from: string, to: string, file: string): Promise<Draft[]> {
  const out = await runGit(cwd, ["diff", "--raw", "-z", "--no-abbrev", "--find-renames", "--no-relative", from, to, "--"]);
  const fields = out.split("\0");
  const drafts: Draft[] = [];
  for (let i = 0; i < fields.length; i++) {
    const head = fields[i] ?? "";
    if (!head.startsWith(":")) continue;
    const status = head.slice(1).split(" ")[4] ?? "";
    const first = fields[++i] ?? "";
    const pair = status.startsWith("R") || status.startsWith("C");
    const second = pair ? (fields[++i] ?? "") : first;
    if (first !== file && second !== file) continue;
    if (status.startsWith("R")) drafts.push({ category: "config-renamed", other: first === file ? second : first });
    else if (status.startsWith("A") || status.startsWith("C")) drafts.push({ category: "config-added", other: null });
    else if (status.startsWith("D")) drafts.push({ category: "config-deleted", other: null });
    else drafts.push({ category: "config-changed", other: null });
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

function describeFinding(finding: ConfigFinding): string {
  const other = finding.other === null ? "" : ` (other path: ${escapeText(finding.other)})`;
  const tail = finding.sanction === null ? "" : ` - sanctioned: ${escapeText(finding.sanction)}`;
  return `${escapeText(finding.file)}: ${finding.category}${other}${tail}`;
}

/**
 * Report a change `base..candidate` makes to the configuration file the run
 * read. Fails while a finding is unsanctioned, and fails closed: a revision
 * that names no commit, or any git invocation that fails, is a `fail` record
 * naming the cause - never a `pass`, never a throw.
 */
export async function check(options: ConfigChangesOptions): Promise<ConfigChangesRecord> {
  try {
    const { cwd, base, candidate, config } = options;
    const baseCommit = await resolveCommit(cwd, base);
    const candidateCommit = await resolveCommit(cwd, candidate);
    let ancestor: string;
    try {
      ancestor = (await runGit(cwd, ["merge-base", baseCommit, candidateCommit])).trim();
    } catch (error) {
      throw new Error(`no merge base of "${escapeText(base)}" and "${escapeText(candidate)}": ${(error as Error).message}`);
    }
    const file = await watchedPath(cwd, config);
    if (file === null) {
      const named = escapeText(String(config));
      return { name, status: "skip", evidence: [`${named}: outside the repository, no range can change it`], findings: [] };
    }
    const drafts = await compare(cwd, ancestor, candidateCommit, file);
    if (drafts.length === 0) {
      return { name, status: "pass", evidence: [`${escapeText(file)}: not added, changed, deleted or renamed`], findings: [] };
    }
    const lines = await readSanctionLines(cwd, ancestor, candidateCommit);
    const findings: ConfigFinding[] = drafts.map((draft) => {
      const id = `${draft.category}:${file}`;
      return { id, category: draft.category, file, other: draft.other, sanction: sanctionFor(id, lines, options.sanctions ?? {}) };
    });
    const open = findings.some((finding) => finding.sanction === null);
    return { name, status: open ? "fail" : "pass", evidence: findings.map(describeFinding), findings };
  } catch (error) {
    return { name, status: "fail", evidence: [escapeText(error instanceof Error ? error.message : String(error))], findings: [] };
  }
}
