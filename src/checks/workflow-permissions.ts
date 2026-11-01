/**
 * Raised workflow permissions.
 *
 * A workflow's `permissions:` decide what the job's token may do, and the
 * `pull_request_target` trigger runs a workflow with the base repository's token
 * and secrets for a pull request from anyone. This check reads every workflow
 * file the range adds, changes or renames onto - `.github/workflows/<name>.yml`
 * or `.yaml` directly in that directory, no deeper and nowhere else - whole and
 * through git at the merge base of `base` and `candidate` and at `candidate`,
 * renames detected; the working tree is never read. The YAML is not parsed.
 *
 * A line's text is the line with white space at both ends removed; its
 * value-text is that text with a trailing comment (a `#` after white space)
 * removed. A line is added when the candidate's file holds its text more often
 * than the source file held it - the file at the merge base, the one a rename
 * came from, or none for a file the range adds. A line moved or re-indented is
 * not added, and a text added more than once is one finding.
 *
 * Three categories, each judged on an added line's value-text with an opening
 * `- ` removed; a value is the same plain, in double quotes or in single quotes,
 * and white space around a colon does not matter:
 *  - `write-all`: the key `permissions` with the value `write-all`.
 *  - `write-permission`: a scope with the value `write`, as the whole value-text
 *    (`contents: write`) or as one entry of a one-line mapping that is the value
 *    of `permissions` (`permissions: { contents: write }`). The scopes are
 *    `actions`, `attestations`, `checks`, `contents`, `deployments`,
 *    `discussions`, `id-token`, `issues`, `models`, `packages`, `pages`,
 *    `pull-requests`, `repository-projects`, `security-events` and `statuses`.
 *  - `pull-request-target`: the key `pull_request_target` with or without a
 *    value, the list item `pull_request_target`, or the key `on` whose value is
 *    `pull_request_target` or a one-line list (`[...]`) holding it.
 *
 * Not a finding: `read`, `none`, `read-all`, `{}`, a scope not listed,
 * `pull_request`, `workflow_run`, the words inside a comment line or inside a
 * `run:` line's command.
 *
 * A finding's id is `<category>:<file>`; it is sanctioned by a
 * `Sanctioned-Weakening: <id> <reason>` line in a commit message of the range
 * or by the caller's `sanctions`. The check declares no options.
 */

import { execFile } from "node:child_process";

import type { CheckRecord } from "../index.js";
import { SANCTION_KEY } from "../weakened-tests.js";

export const name = "RT-91";

export interface WorkflowPermissionsOptions {
  readonly cwd: string;
  readonly base: string;
  readonly candidate: string;
  /** Ids (`<category>:<file>`) mapped to reasons. */
  readonly sanctions?: Readonly<Record<string, string>> | undefined;
}

const SCOPES = new Set([
  "actions", "attestations", "checks", "contents", "deployments", "discussions", "id-token", "issues",
  "models", "packages", "pages", "pull-requests", "repository-projects", "security-events", "statuses",
]);

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

/** A scalar without the quotes around it, when it is wholly quoted. */
function unquote(value: string): string {
  const v = value.trim();
  const first = v.charAt(0);
  return v.length >= 2 && (first === '"' || first === "'") && v.endsWith(first) ? v.slice(1, -1).trim() : v;
}

/** The entries of a one-line `[...]` or `{...}`, or null when the value is not wrapped so. */
function flowEntries(value: string, open: string, close: string): string[] | null {
  const v = value.trim();
  if (!v.startsWith(open) || !v.endsWith(close)) return null;
  return v.slice(1, -1).split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

/** Splits `key : value`; the key is unquoted. */
function splitPair(text: string): { key: string; value: string } | null {
  const match = /^("[^"]*"|'[^']*'|[^\s:"'][^:]*?)\s*:(?:\s+(.*)|(.*))$/.exec(text);
  if (match === null) return null;
  const rest = match[2] ?? match[3] ?? "";
  // A colon with no space after it belongs to a scalar (`a:b`), unless nothing follows.
  if (match[2] === undefined && rest.length > 0) return null;
  return { key: unquote(match[1] ?? ""), value: rest.trim() };
}

/** The category of an added line, or null. */
function categorize(text: string): string | null {
  const valueText = text.replace(/(?:^|\s)#.*$/, "").trimEnd().replace(/^-\s+/, "").trim();
  if (valueText.length === 0) return null;
  if (unquote(valueText) === "pull_request_target") return "pull-request-target";
  const pair = splitPair(valueText);
  if (pair === null) return null;
  const value = unquote(pair.value);
  if (pair.key === "pull_request_target") return "pull-request-target";
  if (pair.key === "on") {
    const list = flowEntries(pair.value, "[", "]");
    const holds = value === "pull_request_target" || list?.some((entry) => unquote(entry) === "pull_request_target");
    return holds ? "pull-request-target" : null;
  }
  if (pair.key === "permissions") {
    if (value === "write-all") return "write-all";
    for (const entry of flowEntries(pair.value, "{", "}") ?? []) {
      const inner = splitPair(entry);
      if (inner !== null && SCOPES.has(inner.key) && unquote(inner.value) === "write") return "write-permission";
    }
    return null;
  }
  return SCOPES.has(pair.key) && value === "write" ? "write-permission" : null;
}

interface Draft {
  readonly category: string;
  readonly file: string;
  readonly line: string;
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
    i++;
    const newPath = moved ? (fields[++i] ?? "") : (fields[i] ?? "");
    const letter = status.charAt(0);
    if (!["A", "M", "R", "C", "T"].includes(letter) || !isWorkflowPath(newPath)) continue;
    // A rename is read against the file it came from, whatever that path was.
    const hasSource = letter === "M" || letter === "T" || letter === "R";
    const before = countLines(hasSource ? await readBlob(cwd, oldSha) : "");
    const after = countLines(await readBlob(cwd, newSha));
    for (const [text, count] of after) {
      if (count <= (before.get(text) ?? 0)) continue;
      const category = categorize(text);
      if (category !== null) drafts.push({ category, file: newPath, line: text });
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
 * Report each line `base..candidate` adds to a workflow that raises the token's
 * permissions or runs it on `pull_request_target`. Fails while any finding is
 * unsanctioned, and fails closed: a revision that names no commit, or a git that
 * fails, is a `fail` record naming the cause - never a `pass`, never a throw.
 */
export async function check(options: WorkflowPermissionsOptions): Promise<CheckRecord> {
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
    if (drafts.length === 0) return { name, status: "pass", evidence: ["no workflow permission raised"] };
    const lines = await readSanctionLines(cwd, baseCommit, candidateCommit);
    let open = false;
    const evidence = drafts.map((draft) => {
      const reason = sanctionFor(`${draft.category}:${draft.file}`, lines, options.sanctions ?? {});
      if (reason === null) open = true;
      const tail = reason === null ? "" : ` - sanctioned: ${escapeText(reason)}`;
      return `${escapeText(draft.file)}: ${draft.category} "${escapeText(draft.line)}"${tail}`;
    });
    return { name, status: open ? "fail" : "pass", evidence };
  } catch (error) {
    return { name, status: "fail", evidence: [escapeText(error instanceof Error ? error.message : String(error))] };
  }
}
