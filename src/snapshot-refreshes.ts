/**
 * Snapshot refreshes.
 *
 * A snapshot test passes when the output matches what was recorded, so the
 * cheapest way to make a failing one pass is to record again. This check
 * reports every snapshot `base..candidate` rewrites or deletes, and says
 * whether a commit that did it also changed a file that is neither a snapshot
 * nor a test. A new snapshot, or one only renamed with its content unchanged,
 * is not a finding. Inline snapshots are not this version's.
 *
 * Only the range's changes are read, through git with an argument vector: the
 * diff from the merge base of the two revisions to the candidate, with renames
 * detected, and the paths each commit of `base..candidate` changed. A snapshot
 * the base changed before the range is not reported.
 */

import { execFile } from "node:child_process";

import type { CheckRecord } from "./index.js";
import { SANCTION_KEY, WEAKENING_SPELLINGS } from "./weakened-tests.js";

const NAME = "RT-16";

/**
 * The shapes of a snapshot path, each tested against a path relative to the
 * repository root. The check reads this list each time it runs, so a consumer
 * appends its own shape.
 */
export const SNAPSHOT_PATHS: RegExp[] = [/(?:^|\/)__snapshots__\//, /\.snap$/, /\.ambr$/];

export type SnapshotCategory = "snapshot-refreshed" | "snapshot-deleted";

export interface SnapshotRefreshesOptions {
  readonly cwd: string;
  readonly base: string;
  readonly candidate: string;
  /** Keys are finding ids; values are the reasons. */
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

/** One entry of a raw diff. */
interface Entry {
  /** The first letter of git's status: A, M, D, R, T. */
  readonly status: string;
  /** Whether the content differs, by blob id. */
  readonly contentChanged: boolean;
  readonly oldPath: string;
  readonly newPath: string;
}

function parseRaw(out: string): Entry[] {
  const tokens = out.split("\0");
  const entries: Entry[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const meta = tokens[i] ?? "";
    if (!meta.startsWith(":")) {
      continue;
    }
    const fields = meta.slice(1).split(" ");
    const status = (fields[4] ?? "").charAt(0);
    const oldPath = tokens[i + 1] ?? "";
    let newPath = oldPath;
    if (status === "R" || status === "C") {
      newPath = tokens[i + 2] ?? "";
      i += 2;
    } else {
      i += 1;
    }
    entries.push({ status, contentChanged: (fields[2] ?? "") !== (fields[3] ?? ""), oldPath, newPath });
  }
  return entries;
}

function matchesAny(patterns: readonly RegExp[], path: string): boolean {
  return patterns.some((pattern) => {
    pattern.lastIndex = 0;
    const hit = pattern.test(path);
    pattern.lastIndex = 0;
    return hit;
  });
}

interface Draft {
  readonly category: SnapshotCategory;
  readonly path: string;
  /** Every path the snapshot had in the range, to match commits against. */
  readonly paths: readonly string[];
}

function draftsOf(entries: readonly Entry[], isSnapshot: (path: string) => boolean): Draft[] {
  const drafts: Draft[] = [];
  for (const entry of entries) {
    const { status, oldPath, newPath } = entry;
    if (status === "A" || status === "C" || !isSnapshot(oldPath)) {
      continue;
    }
    if (status === "D" || !isSnapshot(newPath)) {
      drafts.push({ category: "snapshot-deleted", path: oldPath, paths: [oldPath, newPath] });
    } else if (entry.contentChanged) {
      drafts.push({ category: "snapshot-refreshed", path: newPath, paths: [oldPath, newPath] });
    }
  }
  return drafts;
}

interface RangeCommit {
  readonly id: string;
  readonly entries: Entry[];
}

/** The commits of the range, oldest first, with what each changed. */
async function readCommits(cwd: string, from: string, to: string): Promise<RangeCommit[]> {
  const ids = (await runGit(cwd, ["rev-list", "--reverse", `${from}..${to}`, "--"])).split("\n").filter(Boolean);
  const commits: RangeCommit[] = [];
  for (const id of ids) {
    const raw = await runGit(cwd, ["diff-tree", "--root", "-r", "-M", "-z", "--raw", "--no-commit-id", id, "--"]);
    commits.push({ id, entries: parseRaw(raw) });
  }
  return commits;
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
  if (typeof reason === "string" && reason.trim().length > 0) {
    return reason.trim();
  }
  for (const line of lines) {
    const rest = line.slice(id.length);
    if (line.startsWith(id) && /^\s+\S/.test(rest)) {
      return rest.trim();
    }
  }
  return null;
}

/**
 * Report the snapshots `base..candidate` rewrites or deletes. Fails while any
 * finding is unsanctioned, and fails closed: a revision that names no commit,
 * or any git invocation that fails, is a `fail` record naming the cause.
 */
export async function checkSnapshotRefreshes(options: SnapshotRefreshesOptions): Promise<CheckRecord> {
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

    const snapshotPatterns = [...SNAPSHOT_PATHS];
    const testPatterns = [...WEAKENING_SPELLINGS.testFiles];
    const isSnapshot = (path: string): boolean => matchesAny(snapshotPatterns, path);
    const isCode = (path: string): boolean => !isSnapshot(path) && !matchesAny(testPatterns, path);

    const raw = await runGit(cwd, ["diff", "-z", "--raw", "-M", "--no-ext-diff", ancestor, candidateCommit, "--"]);
    const drafts = draftsOf(parseRaw(raw), isSnapshot);

    if (drafts.length === 0) {
      return { name: NAME, status: "pass", evidence: ["no snapshot refreshed or deleted"] };
    }

    const commits = await readCommits(cwd, baseCommit, candidateCommit);
    const lines = await readSanctionLines(cwd, baseCommit, candidateCommit);
    const given = options.sanctions ?? {};

    let open = 0;
    const evidence = drafts.map((draft) => {
      const id = `${draft.category}:${draft.path}`;
      const beside = commits
        .filter(
          (commit) =>
            commit.entries.some(
              (entry) =>
                entry.status !== "A" &&
                (draft.paths.includes(entry.oldPath) || draft.paths.includes(entry.newPath)) &&
                (entry.status === "D" || entry.contentChanged),
            ) && commit.entries.some((entry) => isCode(entry.oldPath) || isCode(entry.newPath)),
        )
        .map((commit) => commit.id);
      const word = draft.category === "snapshot-deleted" ? "deleted" : "refreshed";
      let line = `${escapeText(draft.path)}: ${word}`;
      if (beside.length > 0) {
        line += ` beside a code change in ${beside.join(", ")}`;
      }
      const reason = sanctionFor(id, lines, given);
      if (reason === null) {
        open += 1;
        return `${line} - awaiting a sanction`;
      }
      return `${line} - sanctioned: ${escapeText(reason)}`;
    });
    return { name: NAME, status: open > 0 ? "fail" : "pass", evidence };
  } catch (error) {
    return { name: NAME, status: "fail", evidence: [escapeText(error instanceof Error ? error.message : String(error))] };
  }
}
