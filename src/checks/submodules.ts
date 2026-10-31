/**
 * Submodules added or moved.
 *
 * A submodule is a commit id written into the tree (a gitlink, mode 160000);
 * the diff of a range that adds one or moves it shows a single line, and no
 * check that reads added lines or blobs reads the code that commit holds. A
 * `url` in .gitmodules points the next update at another repository. This
 * check reports each gitlink the range adds (`submodule-added`) or moves to
 * another commit (`submodule-moved`), and each `url` value .gitmodules gains,
 * in any section (`submodule-url`, of the file .gitmodules). A gitlink the
 * range removes or leaves at its commit is no finding.
 *
 * The range is read through git, from the merge base of `base` and `candidate`
 * to `candidate`, by listing the trees of the two commits: never from the
 * working tree, never through a diff that the repository's `diff.ignoreSubmodules`
 * or a `submodule.<name>.ignore` could quiet. No submodule is fetched,
 * initialised or entered. The check declares no options.
 *
 * A finding is sanctioned by a `Sanctioned-Weakening: <id> <reason>` line in a
 * commit message of the range or by the caller's `sanctions`. Its id is
 * `<category>:<path>`; for a URL it is `submodule-url:.gitmodules`.
 */

import { execFile } from "node:child_process";

import type { CheckRecord } from "../index.js";
import { SANCTION_KEY } from "../weakened-tests.js";

export const name = "RT-87";

export type SubmoduleCategory = "submodule-added" | "submodule-moved" | "submodule-url";

export interface SubmodulesOptions {
  readonly cwd: string;
  readonly base: string;
  readonly candidate: string;
  /** Ids mapped to reasons. */
  readonly sanctions?: Readonly<Record<string, string>> | undefined;
}

export interface SubmoduleFinding {
  readonly id: string;
  readonly category: SubmoduleCategory;
  readonly path: string;
  /** The text after `<path>: <category>` on the evidence line, before any sanction. */
  readonly detail: string;
  /** The sanction's reason, or `null` while unsanctioned. */
  readonly sanction: string | null;
}

export interface SubmodulesRecord extends CheckRecord {
  readonly findings: readonly SubmoduleFinding[];
}

const GITMODULES = ".gitmodules";

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

/** Every gitlink of a commit's tree, from its path to its commit id. */
async function readGitlinks(cwd: string, commit: string): Promise<Map<string, string>> {
  const out = await runGit(cwd, ["ls-tree", "-r", "-z", "--full-tree", commit]);
  const links = new Map<string, string>();
  for (const entry of out.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const [mode = "", , sha = ""] = entry.slice(0, tab).split(" ");
    if (mode === "160000") links.set(entry.slice(tab + 1), sha);
  }
  return links;
}

/** Every `url` value .gitmodules holds in a commit, in any section; none when the file is absent. */
async function readUrls(cwd: string, commit: string): Promise<string[]> {
  const listed = await runGit(cwd, ["ls-tree", "-z", "--full-tree", commit, "--", GITMODULES]);
  const mode = listed.split(" ")[0] ?? "";
  if (!mode.startsWith("100")) return [];
  const out = await runGit(cwd, ["config", "--blob", `${commit}:${GITMODULES}`, "-z", "--list"]);
  const urls: string[] = [];
  for (const entry of out.split("\0")) {
    const newline = entry.indexOf("\n");
    if (newline < 0) continue;
    const key = entry.slice(0, newline);
    if (key.startsWith("submodule.") && key.endsWith(".url")) urls.push(entry.slice(newline + 1));
  }
  return urls;
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

function describeFinding(finding: SubmoduleFinding): string {
  const tail = finding.sanction === null ? "" : ` - sanctioned: ${escapeText(finding.sanction)}`;
  return `${escapeText(finding.path)}: ${finding.category} ${finding.detail}${tail}`;
}

/**
 * Report each gitlink `base..candidate` adds or moves and each submodule URL it
 * gains. Fails while any finding is unsanctioned, and fails closed: a revision
 * that names no commit, or any git invocation that fails, is a `fail` record
 * naming the cause - never a `pass`, never a throw.
 */
export async function check(options: SubmodulesOptions): Promise<SubmodulesRecord> {
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
    const [before, after, urlsBefore, urlsAfter] = await Promise.all([
      readGitlinks(cwd, ancestor),
      readGitlinks(cwd, candidateCommit),
      readUrls(cwd, ancestor),
      readUrls(cwd, candidateCommit),
    ]);
    const drafts: Omit<SubmoduleFinding, "id" | "sanction">[] = [];
    for (const [path, sha] of [...after].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const old = before.get(path);
      if (old === undefined) drafts.push({ category: "submodule-added", path, detail: sha });
      else if (old !== sha) drafts.push({ category: "submodule-moved", path, detail: `${old} -> ${sha}` });
    }
    const known = new Set(urlsBefore);
    for (const url of [...new Set(urlsAfter)]) {
      if (!known.has(url)) drafts.push({ category: "submodule-url", path: GITMODULES, detail: escapeText(url) });
    }
    if (drafts.length === 0) {
      return { name, status: "pass", evidence: ["no submodule added or moved, and no submodule URL changed"], findings: [] };
    }
    const lines = await readSanctionLines(cwd, ancestor, candidateCommit);
    const findings: SubmoduleFinding[] = drafts.map((draft) => {
      const id = `${draft.category}:${draft.path}`;
      return { id, ...draft, sanction: sanctionFor(id, lines, options.sanctions ?? {}) };
    });
    const open = findings.some((finding) => finding.sanction === null);
    return { name, status: open ? "fail" : "pass", evidence: findings.map(describeFinding), findings };
  } catch (error) {
    return { name, status: "fail", evidence: [escapeText(error instanceof Error ? error.message : String(error))], findings: [] };
  }
}
