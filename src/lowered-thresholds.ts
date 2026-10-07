/**
 * Lowered thresholds.
 *
 * The cheapest way to make a coverage gate pass is to ask less of it: the
 * minimum in the runner's configuration goes down, or the key goes away. This
 * check reads the lines `base..candidate` changes in the files where a
 * repository states its coverage minimums, pairs each value the range removes
 * with the value it adds for the same setting, and reports a minimum that went
 * down (`threshold-lowered`) or disappeared (`threshold-removed`) for a human
 * to sanction. A raised, new or merely moved value says nothing.
 *
 * Only the DIFF is read, by blob id through git, from the merge base of the
 * two revisions; a low minimum the base already holds is never reported.
 *
 * Which files and which spellings count lives in one exported array,
 * `THRESHOLD_SPELLINGS`, read each time the check runs: a repository on another
 * runner appends its own entry.
 */

import { execFile } from "node:child_process";

import type { CheckRecord } from "./index.js";
import { SANCTION_KEY } from "./weakened-tests.js";

const NAME = "RT-14";

export type ThresholdCategory = "threshold-lowered" | "threshold-removed";

/** One spelling of a stated minimum. */
export interface ThresholdSpelling {
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
const KEYS = "(?<key>lines|branches|functions|statements)";
const RUNNER_CONFIG =
  /(?:^|\/)(?:(?:vitest|vite|jest)\.config\.(?:[cm]?[jt]s|json)|package\.json|\.nycrc(?:\.json)?|\.c8rc(?:\.json)?)$/;

export const THRESHOLD_SPELLINGS: ThresholdSpelling[] = [
  {
    name: "coverage key",
    files: RUNNER_CONFIG,
    pattern: new RegExp(`(?<![\\w.-])["']?${KEYS}["']?\\s*:\\s*${NUMBER}`),
    example: "lines: 80,",
  },
  {
    name: "coverage flag",
    files: /(?:^|\/)package\.json$/,
    pattern: new RegExp(`(?<![\\w-])--${KEYS}(?:\\s+|=)${NUMBER}`),
    example: '"check": "c8 check-coverage --lines 80",',
  },
  {
    name: "pytest --cov-fail-under",
    files: /(?:^|\/)(?:pyproject\.toml|setup\.cfg|tox\.ini|pytest\.ini)$/,
    pattern: new RegExp(`(?<![\\w-])--cov-fail-under(?:\\s+|=)${NUMBER}`),
    example: "addopts = --cov-fail-under=80",
  },
  {
    name: "coverage.py fail_under",
    files: /(?:^|\/)(?:pyproject\.toml|setup\.cfg|tox\.ini|\.coveragerc)$/,
    pattern: new RegExp(`(?<![\\w-])fail_under\\s*=\\s*${NUMBER}`),
    example: "fail_under = 80",
  },
];

/** One minimum the range lowered or removed. */
export interface ThresholdFinding {
  /** `<category>:<file>:<line>`. */
  readonly id: string;
  readonly category: ThresholdCategory;
  readonly file: string;
  /** The line in the candidate for a lowered value, in the base for a removed one. */
  readonly line: number;
  readonly name: string;
  readonly key: string | null;
  readonly oldValue: string;
  readonly newValue: string | null;
  /** The sanction's reason, or `null` while the finding is unsanctioned. */
  readonly sanction: string | null;
}

export interface LoweredThresholdsRecord extends CheckRecord {
  readonly findings: readonly ThresholdFinding[];
}

export interface LoweredThresholdsOptions {
  readonly cwd: string;
  /** The revision the range starts after. */
  readonly base: string;
  /** The revision the range ends at. */
  readonly candidate: string;
  /** Keys are finding ids or `<category>:<file>`; values are the reasons. */
  readonly sanctions?: Readonly<Record<string, string>> | undefined;
}

function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args as string[],
      { cwd, maxBuffer: 1024 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve(stdout);
      },
    );
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
  // A revision that begins with a dash would be read as an option.
  if (typeof revision !== "string" || revision.length === 0 || revision.startsWith("-")) {
    throw new Error(`revision ${quote(String(revision))} does not name a commit`);
  }
  let hash = "";
  try {
    hash = (await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`])).trim();
  } catch (error) {
    throw new Error(`revision ${quote(revision)} does not name a commit: ${(error as Error).message}`);
  }
  if (hash.length === 0) {
    throw new Error(`revision ${quote(revision)} does not name a commit`);
  }
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

function toLines(text: string): Line[] {
  if (text.includes("\0")) {
    return [];
  }
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.map((line, index) => ({ number: index + 1, text: line.replace(/\r$/, "") }));
}

async function readBlob(cwd: string, blob: string | null): Promise<Line[]> {
  return blob === null ? [] : toLines(await runGit(cwd, ["cat-file", "blob", blob]));
}

async function diffBlobs(cwd: string, oldBlob: string, newBlob: string): Promise<{ removed: Line[]; added: Line[] }> {
  const out = await runGit(cwd, ["diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", oldBlob, newBlob]);
  const removed: Line[] = [];
  const added: Line[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const raw of out.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk !== null) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
    } else if (inHunk && raw.startsWith("-")) {
      removed.push({ number: oldLine, text: raw.slice(1).replace(/\r$/, "") });
      oldLine += 1;
    } else if (inHunk && raw.startsWith("+")) {
      added.push({ number: newLine, text: raw.slice(1).replace(/\r$/, "") });
      newLine += 1;
    }
  }
  return { removed, added };
}

async function readChanges(cwd: string, from: string, to: string): Promise<Change[]> {
  const out = await runGit(cwd, ["diff", "--raw", "-z", "--no-abbrev", "--find-renames", "--no-relative", from, to, "--"]);
  const fields = out.split("\0");
  const changes: Change[] = [];
  let i = 0;
  while (i < fields.length) {
    const head = fields[i] ?? "";
    i += 1;
    if (!head.startsWith(":")) {
      continue;
    }
    const [oldMode = "", newMode = "", oldSha = "", newSha = "", status = ""] = head.slice(1).split(" ");
    const first = fields[i] ?? "";
    i += 1;
    let second = first;
    if (status.startsWith("R") || status.startsWith("C")) {
      second = fields[i] ?? "";
      i += 1;
    }
    const regular = (mode: string, sha: string): string | null =>
      mode.startsWith("100") && !/^0+$/.test(sha) ? sha : null;
    const oldBlob = regular(oldMode, oldSha);
    const newBlob = regular(newMode, newSha);
    const lines =
      oldBlob !== null && newBlob !== null
        ? await diffBlobs(cwd, oldBlob, newBlob)
        : { removed: await readBlob(cwd, oldBlob), added: await readBlob(cwd, newBlob) };
    changes.push({
      oldPath: status.startsWith("A") ? null : first,
      newPath: status.startsWith("D") ? null : second,
      ...lines,
    });
  }
  return changes;
}

interface Hit {
  readonly line: number;
  readonly key: string;
  readonly value: string;
}

function hitsOf(spelling: ThresholdSpelling, path: string | null, lines: readonly Line[]): Hit[] {
  if (path === null) {
    return [];
  }
  spelling.files.lastIndex = 0;
  if (!spelling.files.test(path)) {
    return [];
  }
  const flags = spelling.pattern.flags.includes("g") ? spelling.pattern.flags : `${spelling.pattern.flags}g`;
  const pattern = new RegExp(spelling.pattern.source, flags);
  const hits: Hit[] = [];
  for (const line of lines) {
    for (const match of line.text.matchAll(pattern)) {
      const value = match.groups?.["value"];
      if (value !== undefined && Number.isFinite(Number(value))) {
        hits.push({ line: line.number, key: match.groups?.["key"] ?? "", value });
      }
    }
  }
  return hits;
}

type Draft = Omit<ThresholdFinding, "id" | "sanction">;

function draftsOf(changes: readonly Change[], spellings: readonly ThresholdSpelling[]): Draft[] {
  const drafts: Draft[] = [];
  for (const change of changes) {
    for (const spelling of spellings) {
      const removed = hitsOf(spelling, change.oldPath, change.removed);
      const added = hitsOf(spelling, change.newPath, change.added);
      const keys = new Set([...removed, ...added].map((hit) => hit.key));
      for (const key of keys) {
        const before = removed.filter((hit) => hit.key === key);
        const after = added.filter((hit) => hit.key === key);
        before.forEach((old, index) => {
          const now = after[index];
          const shared = { name: spelling.name, key: key === "" ? null : key, oldValue: old.value };
          if (now === undefined) {
            drafts.push({ category: "threshold-removed", file: change.oldPath ?? "", line: old.line, newValue: null, ...shared });
          } else if (Number(now.value) < Number(old.value)) {
            drafts.push({ category: "threshold-lowered", file: change.newPath ?? "", line: now.line, newValue: now.value, ...shared });
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

function sanctionFor(
  draft: Draft,
  id: string,
  lines: readonly string[],
  given: Readonly<Record<string, string>>,
): string | null {
  for (const key of [id, `${draft.category}:${draft.file}`]) {
    const reason = Object.hasOwn(given, key) ? given[key] : undefined;
    if (typeof reason === "string" && reason.trim().length > 0) {
      return reason.trim();
    }
    for (const line of lines) {
      const rest = line.slice(key.length);
      if (line.startsWith(key) && /^\s+\S/.test(rest)) {
        return rest.trim();
      }
    }
  }
  return null;
}

function describeFinding(finding: ThresholdFinding): string {
  const setting = finding.key === null ? finding.name : `${finding.name} ${finding.key}`;
  const moved =
    finding.newValue === null
      ? `removed ${setting}, was ${finding.oldValue}`
      : `lowered ${setting} from ${finding.oldValue} to ${finding.newValue}`;
  const tail = finding.sanction === null ? "" : ` - sanctioned: ${finding.sanction}`;
  return `${escapeText(finding.file)}:${finding.line}: ${escapeText(moved + tail)}`;
}

/**
 * Report the coverage minimums `base..candidate` lowers or removes. Fails while
 * any finding is unsanctioned, and fails closed: a revision that names no
 * commit, or any git invocation that fails, is a `fail` record naming the
 * cause - never a `pass`, and never a thrown error.
 */
export async function checkLoweredThresholds(options: LoweredThresholdsOptions): Promise<LoweredThresholdsRecord> {
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

    const changes = await readChanges(cwd, ancestor, candidateCommit);
    const drafts = draftsOf(changes, THRESHOLD_SPELLINGS);
    const lines = drafts.length === 0 ? [] : await readSanctionLines(cwd, baseCommit, candidateCommit);
    const findings: ThresholdFinding[] = drafts.map((draft) => {
      const id = `${draft.category}:${draft.file}:${draft.line}`;
      return { id, ...draft, sanction: sanctionFor(draft, id, lines, options.sanctions ?? {}) };
    });

    if (findings.length === 0) {
      return { name: NAME, status: "pass", evidence: ["no threshold lowered or removed"], findings };
    }
    const open = findings.some((finding) => finding.sanction === null);
    return { name: NAME, status: open ? "fail" : "pass", evidence: findings.map(describeFinding), findings };
  } catch (error) {
    return {
      name: NAME,
      status: "fail",
      evidence: [escapeText(error instanceof Error ? error.message : String(error))],
      findings: [],
    };
  }
}
