/**
 * Install scripts added.
 *
 * `npm ci` and `npm install` run a package's `preinstall`, `install` and
 * `postinstall` scripts on the machine that installs it, and npm's lockfile
 * says which packages have one: the entry of such a package under `packages`
 * holds `"hasInstallScript": true`. This check reads every file the range adds,
 * changes or renames onto whose last path segment is exactly `package-lock.json`
 * or `npm-shrinkwrap.json`, at any depth, whole through git at the merge base
 * of `base` and `candidate` and at `candidate` (never the working tree, renames
 * detected), and parses each with `JSON.parse`. The source is the file at the
 * merge base, the one a rename came from, or none for a file the range adds.
 *
 * A finding is a key of the candidate's `packages` object whose entry holds
 * `hasInstallScript` equal to `true` while the source's `packages` does not
 * hold that key with such an entry (whatever its version). A lockfile of
 * version 1 has no `packages` object and yields nothing. A lockfile, candidate
 * or source, that `JSON.parse` refuses fails the record and names the file.
 *
 * A finding's id is `install-script:<file>`, which sanctions every finding of
 * that file, by a `Sanctioned-Weakening: <id> <reason>` line in a commit
 * message of the range or by the caller's `sanctions`.
 */

import { execFile } from "node:child_process";

import type { CheckRecord } from "../index.js";
import { SANCTION_KEY } from "../weakened-tests.js";

export const name = "RT-94";

export interface InstallScriptsOptions {
  readonly cwd: string;
  readonly base: string;
  readonly candidate: string;
  /** Ids (`install-script:<file>`) mapped to reasons. */
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

const isLockfile = (path: string): boolean => /(^|\/)(package-lock|npm-shrinkwrap)\.json$/.test(path);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The `packages` object of a lockfile: `null` when it holds none, or the reason it cannot be read. */
type Packages = { readonly packages: Record<string, unknown> | null } | { readonly problem: string };

async function readPackages(cwd: string, mode: string, sha: string): Promise<Packages> {
  if (!mode.startsWith("100")) return { problem: "is not a regular file" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(await runGit(cwd, ["cat-file", "blob", sha]));
  } catch (error) {
    return { problem: `is not JSON: ${(error as Error).message}` };
  }
  const packages = isObject(parsed) && Object.hasOwn(parsed, "packages") ? parsed["packages"] : null;
  return { packages: isObject(packages) ? packages : null };
}

/** Whether an entry of `packages` is an object holding `hasInstallScript: true`. */
const flagged = (entry: unknown): entry is Record<string, unknown> => isObject(entry) && entry["hasInstallScript"] === true;

interface Draft {
  readonly file: string;
  readonly text: string;
}

async function compare(cwd: string, from: string, to: string): Promise<{ drafts: Draft[]; problems: string[] }> {
  const out = await runGit(cwd, ["diff", "--raw", "-z", "--no-abbrev", "--find-renames", "--no-relative", from, to, "--"]);
  const fields = out.split("\0");
  const drafts: Draft[] = [];
  const problems: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const head = fields[i] ?? "";
    if (!head.startsWith(":")) continue;
    const [oldMode = "", newMode = "", oldSha = "", newSha = "", status = ""] = head.slice(1).split(" ");
    const first = fields[++i] ?? "";
    const renamed = status.startsWith("R") || status.startsWith("C");
    const second = renamed ? (fields[++i] ?? "") : first;
    if (status.startsWith("D")) continue;
    const oldPath = status.startsWith("A") ? null : first;
    const file = second;
    if (!isLockfile(file)) continue;
    const after = await readPackages(cwd, newMode, newSha);
    const before: Packages = oldPath === null ? { packages: null } : await readPackages(cwd, oldMode, oldSha);
    if ("problem" in after) problems.push(`${escapeText(file)}: at the candidate the lockfile ${escapeText(after.problem)}`);
    if ("problem" in before) problems.push(`${escapeText(oldPath ?? file)}: at the merge base the lockfile ${escapeText(before.problem)}`);
    if ("problem" in after || "problem" in before || after.packages === null) continue;
    for (const [key, entry] of Object.entries(after.packages)) {
      if (!flagged(entry)) continue;
      if (before.packages !== null && Object.hasOwn(before.packages, key) && flagged(before.packages[key])) continue;
      const version = entry["version"];
      drafts.push({ file, text: `${escapeText(file)}: install-script ${escapeText(key)}${typeof version === "string" ? `@${escapeText(version)}` : ""}` });
    }
  }
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
 * Report each package `base..candidate` adds to a lockfile with an install
 * script. Fails while any finding is unsanctioned or a lockfile cannot be read,
 * and fails closed: a revision that names no commit, or any git invocation that
 * fails, is a `fail` record naming the cause - never a `pass`, never a throw.
 */
export async function check(options: InstallScriptsOptions): Promise<CheckRecord> {
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
    if (drafts.length === 0 && problems.length === 0) return { name, status: "pass", evidence: ["no install script added"] };
    const lines = drafts.length === 0 ? [] : await readSanctionLines(cwd, ancestor, candidateCommit);
    let open = problems.length > 0;
    const evidence = drafts.map((draft) => {
      const reason = sanctionFor(`install-script:${draft.file}`, lines, options.sanctions ?? {});
      if (reason === null) open = true;
      return reason === null ? draft.text : `${draft.text} - sanctioned: ${escapeText(reason)}`;
    });
    return { name, status: open ? "fail" : "pass", evidence: [...problems, ...evidence] };
  } catch (error) {
    return { name, status: "fail", evidence: [escapeText(error instanceof Error ? error.message : String(error))] };
  }
}
