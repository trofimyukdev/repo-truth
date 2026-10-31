/**
 * Secret files added or changed.
 *
 * Some files hold secrets by what they are, not by how a line of them looks. A
 * file is judged by its last path segment, compared exactly (letter case
 * included) at any depth, and never by its content. The exported
 * `SECRET_FILE_NAMES` holds the regular expressions tested against that
 * segment, read each time the check runs so a consumer can append to it. As
 * shipped it matches `.env`, `.env.<suffix>`, `.netrc`, `_netrc`, `.pgpass`,
 * `.git-credentials`, `.htpasswd`, `id_rsa`, `id_dsa`, `id_ecdsa`,
 * `id_ed25519` and any name ending `.tfstate` or `.tfstate.backup`. It does not
 * match a `.env` suffix whose last dot-separated part is `example`, `sample`,
 * `template` or `dist` (so `.env.local.example` is left alone), nor `.pub`
 * files, `.ENV`, `env`, `my.env` or `.envrc`.
 *
 * The range is read through git from the merge base of `base` and `candidate`
 * to `candidate`, renames and copies detected. A path at the candidate that is
 * a regular file whose name matches is `secret-file-added` when the range adds,
 * copies or renames it into place, or turns a symbolic link or a submodule into
 * it, and `secret-file-changed` when the range modifies it. A deletion, or a
 * rename away to a name that does not match, is no finding.
 *
 * No evidence line holds any text of a file. A finding's id is
 * `<category>:<path>`; a `Sanctioned-Weakening: <id> <reason>` line in a commit
 * message of the range, or the caller's `sanctions`, sanctions it. The check
 * declares no options.
 */

import { execFile } from "node:child_process";

import type { CheckRecord } from "../index.js";
import { SANCTION_KEY } from "../weakened-tests.js";

export const name = "RT-89";

export type SecretFileCategory = "secret-file-added" | "secret-file-changed";

export interface SecretFilesOptions {
  readonly cwd: string;
  readonly base: string;
  readonly candidate: string;
  /** Ids mapped to reasons. */
  readonly sanctions?: Readonly<Record<string, string>> | undefined;
}

export interface SecretFileFinding {
  readonly id: string;
  readonly category: SecretFileCategory;
  readonly path: string;
  /** The source of a rename, else `null`. */
  readonly from: string | null;
  /** The sanction's reason, or `null` while unsanctioned. */
  readonly sanction: string | null;
}

export interface SecretFilesRecord extends CheckRecord {
  readonly findings: readonly SecretFileFinding[];
}

/** Tested with `RegExp.prototype.test` against the last path segment; read on every run. */
export const SECRET_FILE_NAMES: RegExp[] = [
  /^\.env$/,
  /^\.env\.(?:.*\.)?(?!(?:example|sample|template|dist)$)[^.]*$/,
  /^\.netrc$/,
  /^_netrc$/,
  /^\.pgpass$/,
  /^\.git-credentials$/,
  /^\.htpasswd$/,
  /^id_(?:rsa|dsa|ecdsa|ed25519)$/,
  /\.tfstate(?:\.backup)?$/,
];

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

function isSecretName(path: string): boolean {
  const segment = path.slice(path.lastIndexOf("/") + 1);
  return SECRET_FILE_NAMES.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(segment);
  });
}

type Draft = Omit<SecretFileFinding, "id" | "sanction">;

async function compare(cwd: string, from: string, to: string): Promise<Draft[]> {
  const out = await runGit(cwd, ["diff", "--raw", "-z", "--no-abbrev", "--find-renames", "--find-copies", "--find-copies-harder", "--no-relative", from, to, "--"]);
  const fields = out.split("\0");
  const drafts: Draft[] = [];
  for (let i = 0; i < fields.length; i++) {
    const head = fields[i] ?? "";
    if (!head.startsWith(":")) continue;
    const [, newMode = "", , , status = ""] = head.slice(1).split(" ");
    const first = fields[++i] ?? "";
    const moved = status.startsWith("R") || status.startsWith("C");
    const path = moved ? (fields[++i] ?? "") : first;
    if (status.startsWith("D") || !newMode.startsWith("100") || !isSecretName(path)) continue;
    if (status.startsWith("M")) drafts.push({ category: "secret-file-changed", path, from: null });
    else drafts.push({ category: "secret-file-added", path, from: status.startsWith("R") ? first : null });
  }
  return drafts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
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

function describeFinding(finding: SecretFileFinding): string {
  const source = finding.from === null ? "" : ` from ${escapeText(finding.from)}`;
  const tail = finding.sanction === null ? "" : ` - sanctioned: ${escapeText(finding.sanction)}`;
  return `${escapeText(finding.path)}: ${finding.category}${source}${tail}`;
}

/**
 * Report each secret-named file `base..candidate` adds or changes. Fails while
 * any finding is unsanctioned, and fails closed: a revision that names no
 * commit, or any git invocation that fails, is a `fail` record naming the
 * cause - never a `pass`, never a throw.
 */
export async function check(options: SecretFilesOptions): Promise<SecretFilesRecord> {
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
    if (drafts.length === 0) return { name, status: "pass", evidence: ["no secret file added or changed"], findings: [] };
    const lines = await readSanctionLines(cwd, baseCommit, candidateCommit);
    const findings: SecretFileFinding[] = drafts.map((draft) => {
      const id = `${draft.category}:${draft.path}`;
      return { id, ...draft, sanction: sanctionFor(id, lines, options.sanctions ?? {}) };
    });
    const open = findings.some((finding) => finding.sanction === null);
    return { name, status: open ? "fail" : "pass", evidence: findings.map(describeFinding), findings };
  } catch (error) {
    return { name, status: "fail", evidence: [escapeText(error instanceof Error ? error.message : String(error))], findings: [] };
  }
}
