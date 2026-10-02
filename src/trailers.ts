/**
 * Task-Id trailer check.
 *
 * A landing says which queued task it closes in a trailer, because the
 * trailer is the one signal a rebase or squash does not rewrite and a later
 * reader can match exactly. The trailer block is read by git itself
 * (`%(trailers)`), never by splitting message text on a colon, so folded
 * values, empty values and a missing blank line before the block are all
 * decided by git's rules.
 *
 * Which commit must carry one: the LANDING, which is the candidate commit.
 * The rest of `base..candidate` is the task's intermediate work and needs
 * none; a trailer on one of them does not count for the landing.
 */

import { execFile } from "node:child_process";

import type { CheckRecord } from "./index.js";

/** The trailer key that names the task a landing closes. */
export const TASK_TRAILER_KEY = "Task-Id";

/** The shape of a task id: a letter, letters or digits, a hyphen, digits. */
export const TASK_ID_PATTERN = /^[A-Za-z][A-Za-z0-9]*-[0-9]+$/;

/** Where to look, and what range of commits to look at. */
export interface TrailerCheckOptions {
  /** The git repository to run in. */
  readonly cwd: string;
  /** The revision the range starts after (exclusive). */
  readonly base: string;
  /** The revision the range ends at (inclusive); the landing. */
  readonly candidate: string;
}

const NAME = "RT-03";

function runGit(cwd: string, args: readonly string[]): Promise<string> {
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
        resolve(stdout);
      },
    );
  });
}

function fail(evidence: string[]): CheckRecord {
  return { name: NAME, status: "fail", evidence };
}

async function resolveCommit(cwd: string, revision: string): Promise<string | undefined> {
  try {
    const out = await runGit(cwd, [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      revision + "^{commit}",
    ]);
    const sha = out.trim();
    return sha.length > 0 ? sha : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The values of every `Task-Id` trailer in a commit's trailer block, as git
 * parses and unfolds them. One entry per trailer; an empty value is "".
 */
async function readTaskIds(cwd: string, sha: string): Promise<string[]> {
  const out = await runGit(cwd, [
    "log",
    "-1",
    "--format=%(trailers:key=" + TASK_TRAILER_KEY + ",unfold,separator=%x00)",
    sha,
    "--",
  ]);
  // Each entry is `Task-Id: value` as git printed it; the key is known and
  // colon-free, so cutting after the first colon only drops the key git matched.
  const text = out.replace(/\n$/, "");
  if (text.length === 0) {
    return [];
  }
  return text.split("\0").map((entry) => entry.slice(entry.indexOf(":") + 1).trim());
}

/**
 * Check that the landing of `base..candidate` - the candidate commit - carries
 * a well-formed `Task-Id` trailer. Fails closed: an unknown revision or any
 * failing git invocation is a `fail`, never a `pass` and never a throw.
 */
export async function checkTrailers(options: TrailerCheckOptions): Promise<CheckRecord> {
  const { cwd, base, candidate } = options;
  const range = base + ".." + candidate;

  try {
    const baseSha = await resolveCommit(cwd, base);
    if (baseSha === undefined) {
      return fail([`revision ${base} does not name a commit`]);
    }
    const landing = await resolveCommit(cwd, candidate);
    if (landing === undefined) {
      return fail([`revision ${candidate} does not name a commit`]);
    }

    const listed = (await runGit(cwd, ["rev-list", baseSha + ".." + landing, "--"])).trim();
    if (listed.length === 0) {
      return { name: NAME, status: "pass", evidence: [`range ${range} is empty`] };
    }

    const subject = (await runGit(cwd, ["log", "-1", "--format=%s", landing, "--"])).replace(/\n$/, "");
    const label = `${landing.slice(0, 12)} ${subject}`;
    const values = await readTaskIds(cwd, landing);

    if (values.length === 0) {
      return fail([`${label}: no ${TASK_TRAILER_KEY} trailer`]);
    }
    const bad = values.filter((value) => !TASK_ID_PATTERN.test(value));
    if (bad.length > 0) {
      return fail(bad.map((value) => `${label}: ${TASK_TRAILER_KEY} value "${value}" does not parse as a task id`));
    }
    return { name: NAME, status: "pass", evidence: [`${label}: closes ${values.join(", ")}`] };
  } catch (error) {
    return fail([`could not check trailers of ${range}: ${(error as Error).message}`]);
  }
}
