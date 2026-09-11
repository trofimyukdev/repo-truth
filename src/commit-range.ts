/**
 * Commit-range ASCII and identity hygiene.
 *
 * `commit-msg` hooks see one commit at a time, at the moment it is written.
 * `cherry-pick`, `revert`, every form of `rebase`, and `git am` all create
 * commits without ever invoking that hook - a property of git, not a defect
 * of the hook. A rule enforced only at commit time is therefore enforced on
 * a subset of history it cannot even name. This check instead reads the
 * whole range `base..candidate` after the fact and answers for all of it.
 */

import { execFile } from "node:child_process";

import type { CheckRecord } from "./index.js";

/** Where to look, and what range of commits to look at. */
export interface CommitRangeOptions {
  /** The git repository to run in. */
  readonly cwd: string;
  /** The revision the range starts after (exclusive). */
  readonly base: string;
  /** The revision the range ends at (inclusive). */
  readonly candidate: string;
}

/** The commit fields this check reads and validates, one line at a time. */
const FIELDS = [
  { key: "message", label: "commit message" },
  { key: "authorName", label: "author name" },
  { key: "authorEmail", label: "author e-mail" },
  { key: "committerName", label: "committer name" },
  { key: "committerEmail", label: "committer e-mail" },
] as const;

interface CommitFields {
  readonly hash: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly committerName: string;
  readonly committerEmail: string;
  readonly message: string;
}

function runGit(cwd: string, args: readonly string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args as string[],
      { cwd, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve({ stdout });
      },
    );
  });
}

/**
 * Escape a character outside printable ASCII (plus tab) so evidence can be
 * printed to a terminal without replaying whatever control sequence a
 * malicious or malformed commit smuggled in.
 */
function escapeChar(char: string): string {
  const codePoint = char.codePointAt(0) ?? 0;
  return `\\u{${codePoint.toString(16).padStart(4, "0")}}`;
}

function escapeLine(line: string): string {
  let escaped = "";
  for (const char of line) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint === 0x09 || (codePoint >= 0x20 && codePoint <= 0x7e)) {
      escaped += char;
    } else {
      escaped += escapeChar(char);
    }
  }
  return escaped;
}

function isAllowedCodePoint(codePoint: number): boolean {
  return codePoint === 0x09 || (codePoint >= 0x20 && codePoint <= 0x7e);
}

function lineIsAscii(line: string): boolean {
  for (const char of line) {
    if (!isAllowedCodePoint(char.codePointAt(0) ?? 0)) {
      return false;
    }
  }
  return true;
}

function validateField(hash: string, label: string, content: string, evidence: string[]): void {
  for (const line of content.split("\n")) {
    if (!lineIsAscii(line)) {
      evidence.push(
        `${hash.slice(0, 12)}: ${label} contains a character outside printable ASCII/tab: "${escapeLine(line)}"`,
      );
    }
  }
}

async function listCommits(cwd: string, base: string, candidate: string): Promise<string[]> {
  const { stdout } = await runGit(cwd, ["rev-list", "--reverse", `${base}..${candidate}`, "--"]);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function readCommitField(cwd: string, hash: string, prettyFormat: string): Promise<string> {
  const { stdout } = await runGit(cwd, ["show", "-s", `--format=${prettyFormat}`, hash]);
  // `git show` always appends a trailing newline after a pretty-printed
  // format; that newline is formatting, not content the commit wrote.
  return stdout.replace(/\n$/, "");
}

async function readCommitFields(cwd: string, hash: string): Promise<CommitFields> {
  // Read each field with its own `git show` call, one argument vector per
  // invocation, rather than joining them with a delimiter: a delimiter drawn
  // from the same alphabet this check polices could itself appear in a
  // message or identity, and Node's `execFile` rejects NUL outright as an
  // argument byte, so there is no safe separator to join on.
  const [authorName, authorEmail, committerName, committerEmail, message] = await Promise.all([
    readCommitField(cwd, hash, "%an"),
    readCommitField(cwd, hash, "%ae"),
    readCommitField(cwd, hash, "%cn"),
    readCommitField(cwd, hash, "%ce"),
    readCommitField(cwd, hash, "%B"),
  ]);
  return { hash, authorName, authorEmail, committerName, committerEmail, message };
}

/**
 * Check every commit in `base..candidate` for characters outside printable
 * ASCII plus tab, in the message and in both identities. Fails closed: any
 * git invocation that cannot be completed (unknown revision, unreachable
 * base, non-zero exit) is reported as `fail`, never as `pass`, and never as
 * a thrown error the caller must catch to stay correct.
 */
export async function checkCommitRange(options: CommitRangeOptions): Promise<CheckRecord> {
  const { cwd, base, candidate } = options;

  let hashes: string[];
  try {
    hashes = await listCommits(cwd, base, candidate);
  } catch (error) {
    return {
      name: "RT-01",
      status: "fail",
      evidence: [`could not compute range ${base}..${candidate}: ${(error as Error).message}`],
    };
  }

  if (hashes.length === 0) {
    return {
      name: "RT-01",
      status: "pass",
      evidence: [`range ${base}..${candidate} is empty`],
    };
  }

  const evidence: string[] = [];
  for (const hash of hashes) {
    let fields: CommitFields;
    try {
      fields = await readCommitFields(cwd, hash);
    } catch (error) {
      return {
        name: "RT-01",
        status: "fail",
        evidence: [`could not read commit ${hash}: ${(error as Error).message}`],
      };
    }

    for (const field of FIELDS) {
      validateField(fields.hash, field.label, fields[field.key], evidence);
    }
  }

  if (evidence.length > 0) {
    return { name: "RT-01", status: "fail", evidence };
  }

  return {
    name: "RT-01",
    status: "pass",
    evidence: [`${hashes.length} commit(s) in ${base}..${candidate} are printable ASCII/tab, identities included`],
  };
}
