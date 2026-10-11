/**
 * Raised timeouts.
 *
 * A test that starts failing by running out of time passes again the moment its
 * timeout goes up. This check reads the lines `base..candidate` changes in test
 * files and in the runner's configuration, pairs each timeout the range removes
 * with the one it adds for the same setting, and reports one that went up
 * (`timeout-raised`) or one added to a file the merge base holds
 * (`timeout-added`) for a human to sanction. Only the diff is read, through git.
 *
 * Which files and spellings count lives in the exported `TIMEOUT_SPELLINGS`,
 * read each time the check runs: a consumer appends its own entry.
 */

import { execFile } from "node:child_process";

import type { CheckRecord } from "../index.js";
import { SANCTION_KEY } from "../weakened-tests.js";

export const name = "RT-24";

export type TimeoutCategory = "timeout-raised" | "timeout-added";

/** One spelling of a timeout. */
export interface TimeoutSpelling {
  /** What the evidence calls this spelling. */
  readonly name: string;
  /** Tested against a changed path. */
  readonly files: RegExp;
  /**
   * Tested against each line the range removes or adds in such a file. The
   * named group `value` holds the number; the optional group `key` names the
   * setting. A line may hold several matches.
   */
  readonly pattern: RegExp;
  /** A line `pattern` matches. */
  readonly example: string;
}

const NUMBER = "(?<value>\\d+(?:\\.\\d+)?)";
const KEYS = "(?<key>testTimeout|hookTimeout|teardownTimeout)";
const RUNNER_CONFIG = /(?:^|\/)(?:(?:vitest|vite|jest)\.config\.(?:[cm]?[jt]s|json)|package\.json)$/;
const TEST_FILE = /(?:(?:^|\/)(?:tests?|__tests__|spec)\/(?:.*\/)?[^/]*\.[cm]?[jt]sx?$|\.(?:test|spec)\.(?:[^/]*\.)?[cm]?[jt]sx?$)/;
const CONFIG_OR_TEST = new RegExp(`${RUNNER_CONFIG.source}|${TEST_FILE.source}`);

export const TIMEOUT_SPELLINGS: TimeoutSpelling[] = [
  {
    name: "timeout key",
    files: CONFIG_OR_TEST,
    pattern: new RegExp(`(?<![\\w.-])["']?${KEYS}["']?\\s*:\\s*${NUMBER}`),
    example: "testTimeout: 5000,",
  },
  {
    name: "jest.setTimeout",
    files: TEST_FILE,
    pattern: new RegExp(`(?<![\\w-])jest\\.setTimeout\\(\\s*${NUMBER}`),
    example: "jest.setTimeout(30000);",
  },
  {
    name: "timeout option",
    files: TEST_FILE,
    pattern: new RegExp(`(?<![\\w.-])["']?(?<key>timeout)["']?\\s*:\\s*${NUMBER}`),
    example: "{ timeout: 30000 }",
  },
  {
    name: "mocha this.timeout",
    files: TEST_FILE,
    pattern: new RegExp(`(?<![\\w-])this\\.timeout\\(\\s*${NUMBER}`),
    example: "this.timeout(30000);",
  },
  {
    name: "test timeout argument",
    files: TEST_FILE,
    pattern: new RegExp(`^\\s*\\}\\s*\\)?\\s*,\\s*${NUMBER}\\s*\\)`),
    example: "}, 30000);",
  },
];

/** One timeout the range raised or added; `id` is `<category>:<file>:<line>`, the line in the candidate. */
export interface TimeoutFinding {
  readonly id: string;
  readonly category: TimeoutCategory;
  readonly file: string;
  readonly line: number;
  readonly name: string;
  readonly key: string | null;
  readonly oldValue: string | null;
  readonly newValue: string;
  /** The sanction's reason, or `null` while unsanctioned. */
  readonly sanction: string | null;
}

export interface RaisedTimeoutsRecord extends CheckRecord {
  readonly findings: readonly TimeoutFinding[];
}

/** `sanctions` keys are finding ids or `<category>:<file>`; values are the reasons. */
export interface RaisedTimeoutsOptions {
  readonly cwd: string;
  readonly base: string;
  readonly candidate: string;
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

function quote(text: string): string {
  return `"${escapeText(text)}"`;
}

async function resolveCommit(cwd: string, revision: string): Promise<string> {
  const fail = (cause: string): Error => new Error(`revision ${quote(String(revision))} does not name a commit${cause}`);
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

interface Line {
  readonly number: number;
  readonly text: string;
}

interface Change {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly removed: Line[];
  readonly added: Line[];
}

/** The lines changed between two blobs; a missing side (`null`) is a file that is not there. */
async function diffBlobs(cwd: string, oldBlob: string | null, newBlob: string | null): Promise<{ removed: Line[]; added: Line[] }> {
  if (oldBlob === null || newBlob === null) {
    const only = oldBlob ?? newBlob;
    const text = only === null ? "" : await runGit(cwd, ["cat-file", "blob", only]);
    const lines = text.includes("\0") ? [] : text.replace(/\n$/, "").split("\n").map((t, i) => ({ number: i + 1, text: t.replace(/\r$/, "") }));
    return oldBlob === null ? { removed: [], added: lines } : { removed: lines, added: [] };
  }
  const out = await runGit(cwd, ["diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", oldBlob, newBlob]);
  const removed: Line[] = [];
  const added: Line[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const raw of out.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    const text = raw.slice(1).replace(/\r$/, "");
    if (hunk !== null) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
    } else if (inHunk && raw.startsWith("-")) removed.push({ number: oldLine++, text });
    else if (inHunk && raw.startsWith("+")) added.push({ number: newLine++, text });
  }
  return { removed, added };
}

async function readChanges(cwd: string, from: string, to: string): Promise<Change[]> {
  const out = await runGit(cwd, ["diff", "--raw", "-z", "--no-abbrev", "--find-renames", "--no-relative", from, to, "--"]);
  const fields = out.split("\0");
  const changes: Change[] = [];
  for (let i = 0; i < fields.length; i++) {
    const head = fields[i] ?? "";
    if (!head.startsWith(":")) continue;
    const [oldMode = "", newMode = "", oldSha = "", newSha = "", status = ""] = head.slice(1).split(" ");
    const first = fields[++i] ?? "";
    const second = status.startsWith("R") || status.startsWith("C") ? (fields[++i] ?? "") : first;
    const blob = (mode: string, sha: string): string | null => (mode.startsWith("100") ? sha : null);
    const lines = await diffBlobs(cwd, blob(oldMode, oldSha), blob(newMode, newSha));
    changes.push({ oldPath: status.startsWith("A") ? null : first, newPath: status.startsWith("D") ? null : second, ...lines });
  }
  return changes;
}

interface Hit {
  readonly line: number;
  readonly key: string;
  readonly value: string;
}

function hitsOf(spelling: TimeoutSpelling, path: string | null, lines: readonly Line[]): Hit[] {
  if (path === null || !new RegExp(spelling.files.source, spelling.files.flags.replace(/[gy]/g, "")).test(path)) return [];
  const pattern = new RegExp(spelling.pattern.source, spelling.pattern.flags.replace("g", "") + "g");
  const hits: Hit[] = [];
  for (const line of lines) {
    for (const match of line.text.matchAll(pattern)) {
      const value = match.groups?.["value"];
      if (value !== undefined && Number.isFinite(Number(value))) hits.push({ line: line.number, key: match.groups?.["key"] ?? "", value });
    }
  }
  return hits;
}

type Draft = Omit<TimeoutFinding, "id" | "sanction">;

function draftsOf(changes: readonly Change[], spellings: readonly TimeoutSpelling[]): Draft[] {
  const drafts: Draft[] = [];
  for (const change of changes) {
    for (const spelling of spellings) {
      const removed = hitsOf(spelling, change.oldPath, change.removed);
      const added = hitsOf(spelling, change.newPath, change.added);
      for (const key of new Set([...removed, ...added].map((hit) => hit.key))) {
        const before = removed.filter((hit) => hit.key === key);
        added
          .filter((hit) => hit.key === key)
          .forEach((now, index) => {
            const old = before[index];
            const shared = { name: spelling.name, key: key === "" ? null : key, file: change.newPath ?? "", line: now.line, newValue: now.value };
            if (old === undefined) {
              if (change.oldPath !== null) drafts.push({ category: "timeout-added", oldValue: null, ...shared });
            } else if (Number(now.value) > Number(old.value)) {
              drafts.push({ category: "timeout-raised", oldValue: old.value, ...shared });
            }
          });
      }
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

function sanctionFor(draft: Draft, id: string, lines: readonly string[], given: Readonly<Record<string, string>>): string | null {
  for (const key of [id, `${draft.category}:${draft.file}`]) {
    const reason = Object.hasOwn(given, key) ? given[key] : undefined;
    if (typeof reason === "string" && reason.trim().length > 0) return reason.trim();
    for (const line of lines) {
      const rest = line.slice(key.length);
      if (line.startsWith(key) && /^\s+\S/.test(rest)) return rest.trim();
    }
  }
  return null;
}

function describeFinding(finding: TimeoutFinding): string {
  const setting = finding.key === null ? finding.name : `${finding.name} ${finding.key}`;
  const moved =
    finding.oldValue === null
      ? `added ${setting} ${finding.newValue}`
      : `raised ${setting} from ${finding.oldValue} to ${finding.newValue}`;
  const tail = finding.sanction === null ? "" : ` - sanctioned: ${finding.sanction}`;
  return `${escapeText(finding.file)}:${finding.line}: ${escapeText(moved + tail)}`;
}

/**
 * Report the timeouts `base..candidate` raises or adds to an existing file.
 * Fails while any finding is unsanctioned, and fails closed: a revision that
 * names no commit, or any git invocation that fails, is a `fail` record naming
 * the cause - never a `pass`, and never a thrown error.
 */
export async function check(options: RaisedTimeoutsOptions): Promise<RaisedTimeoutsRecord> {
  try {
    const { cwd, base, candidate } = options;
    const baseCommit = await resolveCommit(cwd, base);
    const candidateCommit = await resolveCommit(cwd, candidate);
    let ancestor: string;
    try {
      ancestor = (await runGit(cwd, ["merge-base", baseCommit, candidateCommit])).trim();
    } catch (error) {
      throw new Error(`no merge base of ${quote(base)} and ${quote(candidate)}: ${(error as Error).message}`);
    }
    const drafts = draftsOf(await readChanges(cwd, ancestor, candidateCommit), TIMEOUT_SPELLINGS);
    const lines = drafts.length === 0 ? [] : await readSanctionLines(cwd, baseCommit, candidateCommit);
    const findings: TimeoutFinding[] = drafts.map((draft) => {
      const id = `${draft.category}:${draft.file}:${draft.line}`;
      return { id, ...draft, sanction: sanctionFor(draft, id, lines, options.sanctions ?? {}) };
    });
    if (findings.length === 0) return { name, status: "pass", evidence: ["no timeout raised or added"], findings };
    const open = findings.some((finding) => finding.sanction === null);
    return { name, status: open ? "fail" : "pass", evidence: findings.map(describeFinding), findings };
  } catch (error) {
    return { name, status: "fail", evidence: [escapeText(error instanceof Error ? error.message : String(error))], findings: [] };
  }
}
