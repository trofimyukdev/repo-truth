/**
 * Unpinned actions.
 *
 * A `uses: owner/repo@v4` runs whatever commit the tag names on the day the job
 * runs, with the job's token and secrets. This check reads, whole and through
 * git at the merge base of `base` and `candidate` and at `candidate` (never the
 * working tree), every workflow file the range adds, changes or renames onto -
 * `.github/workflows/<name>.yml` or `.yaml` directly in that directory - and
 * every file named `action.yml` or `action.yaml` at any depth.
 *
 * The YAML is not parsed. A `uses:` line is a line whose text, white space at
 * both ends removed, opens `uses:` or `- uses:`; its value is the rest of the
 * line with a trailing comment (a `#` after white space) removed, then white
 * space at both ends, then one pair of matching surrounding quotes. A line is
 * added when the candidate's file holds its text more often than its source
 * file (the file at the merge base, the one a rename came from, or none) did;
 * a line moved or re-indented is not, and a text added more than once is one
 * finding.
 *
 * Pinned: a local reference (opening `./`), a `docker://` image by digest
 * (`@sha256:` and sixty-four hexadecimal digits), and a repository reference
 * `<owner>/<repo>[/<path>]@<commit>` whose commit is exactly forty hexadecimal
 * digits. Every other value - a tag, a branch, no `@`, a short commit id, a
 * `docker://` image by tag - is unpinned and is a finding `unpinned-action`.
 *
 * The option `allowedOwners` (strings): a repository reference whose owner, the
 * text before its first `/`, is one of them, compared exactly, yields no
 * finding. `docker://` and local references are judged as above regardless.
 *
 * A finding's id is `unpinned-action:<file>`; it is sanctioned by a
 * `Sanctioned-Weakening: <id> <reason>` line in a commit message of the range
 * or by the caller's `sanctions`.
 */

import { execFile } from "node:child_process";

import type { CheckRecord } from "../index.js";
import { SANCTION_KEY } from "../weakened-tests.js";

export const name = "RT-88";

export const optionKinds = { allowedOwners: "strings" };

export interface ActionPinsOptions {
  readonly cwd: string;
  readonly base: string;
  readonly candidate: string;
  readonly allowedOwners?: readonly string[] | undefined;
  /** Ids (`unpinned-action:<file>`) mapped to reasons. */
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

const isReadPath = (path: string): boolean =>
  /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path) || /(?:^|\/)action\.ya?ml$/.test(path);
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

/** The value of a `uses:` line's text, or null when the text is not such a line. */
function usesValue(text: string): string | null {
  const match = /^(?:-\s+)?uses:(.*)$/.exec(text);
  if (match === null) return null;
  let value = (match[1] ?? "").replace(/(?:^|\s)#.*$/, "").trim();
  const quote = value.charAt(0);
  if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) value = value.slice(1, -1);
  return value;
}

/** Whether a value is unpinned and, if it is a repository reference, not by an allowed owner. */
function isFinding(value: string, allowed: readonly string[]): boolean {
  if (value.length === 0 || value.startsWith("./")) return false;
  if (value.startsWith("docker://")) return !/@sha256:[0-9a-fA-F]{64}$/.test(value);
  const at = value.lastIndexOf("@");
  const pinned = at > 0 && /^[0-9a-fA-F]{40}$/.test(value.slice(at + 1)) && value.slice(0, at).includes("/");
  if (pinned) return false;
  const slash = value.indexOf("/");
  return !(slash > 0 && allowed.includes(value.slice(0, slash)));
}

interface Draft {
  readonly file: string;
  readonly value: string;
}

async function compare(cwd: string, from: string, to: string, allowed: readonly string[]): Promise<Draft[]> {
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
    if (!["A", "M", "R", "C", "T"].includes(letter) || !isReadPath(newPath)) continue;
    const fromRead = letter === "M" || letter === "T" || letter === "R";
    const before = countLines(fromRead ? await readBlob(cwd, oldSha) : "");
    const after = countLines(await readBlob(cwd, newSha));
    for (const [text, count] of after) {
      if (count <= (before.get(text) ?? 0)) continue;
      const value = usesValue(text);
      if (value !== null && isFinding(value, allowed)) drafts.push({ file: newPath, value });
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
 * Report each unpinned `uses:` reference `base..candidate` adds. Fails while any
 * finding is unsanctioned, and fails closed: a revision that names no commit,
 * or any git invocation that fails, is a `fail` record naming the cause.
 */
export async function check(options: ActionPinsOptions): Promise<CheckRecord> {
  try {
    const { cwd, base, candidate } = options;
    const allowed = Array.isArray(options.allowedOwners) ? options.allowedOwners.filter((o) => typeof o === "string") : [];
    const baseCommit = await resolveCommit(cwd, base);
    const candidateCommit = await resolveCommit(cwd, candidate);
    let ancestor: string;
    try {
      ancestor = (await runGit(cwd, ["merge-base", baseCommit, candidateCommit])).trim();
    } catch (error) {
      throw new Error(`no merge base of "${escapeText(base)}" and "${escapeText(candidate)}": ${(error as Error).message}`);
    }
    const drafts = await compare(cwd, ancestor, candidateCommit, allowed);
    if (drafts.length === 0) return { name, status: "pass", evidence: ["no unpinned action reference added"] };
    const lines = await readSanctionLines(cwd, baseCommit, candidateCommit);
    let open = false;
    const evidence = drafts.map((draft) => {
      const reason = sanctionFor(`unpinned-action:${draft.file}`, lines, options.sanctions ?? {});
      if (reason === null) open = true;
      const tail = reason === null ? "" : ` - sanctioned: ${escapeText(reason)}`;
      return `${escapeText(draft.file)}: unpinned-action ${escapeText(draft.value)}${tail}`;
    });
    return { name, status: open ? "fail" : "pass", evidence };
  } catch (error) {
    return { name, status: "fail", evidence: [escapeText(error instanceof Error ? error.message : String(error))] };
  }
}
