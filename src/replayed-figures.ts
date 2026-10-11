/**
 * Replayed figures.
 *
 * RT-02 asks that a figure carry the command that printed it; this runs that
 * command again and compares. The claims a range adds are read by
 * `readFigureClaims` (RT-21), and whether a claim's command may run at all is
 * decided by `planReplay` (RT-20); this module holds neither a reader nor a
 * word splitter of its own. A planned command runs as `git --no-pager` and the
 * plan's words, as an argument vector with no shell, bounded in time, and only
 * once every commit the plan names is held by the repository.
 *
 * A command `planReplay` does not plan is counted as not replayable and never
 * failed. A different output, a commit the repository does not hold, a
 * non-zero exit and a replay that runs out of time are findings.
 *
 * The check fails closed: a failure the claim reader answers, an invalid
 * `timeoutMs` or a git invocation other than a replay that fails is a `fail`
 * record naming the cause, never a pass and never a thrown error.
 */

import { spawn } from "node:child_process";

import { readFigureClaims } from "./figure-claims.js";
import type { FigureClaim } from "./figure-claims.js";
import type { CheckRecord } from "./index.js";
import { planReplay } from "./replay-plan.js";
import type { ReplayPlan } from "./replay-plan.js";

const NAME = "RT-19";

/** How long one replay may run, in milliseconds, when the caller sets no bound. */
export const DEFAULT_REPLAY_TIMEOUT_MS = 10000;

/** The most characters of an output a finding shows. */
export const SHOWN_OUTPUT_LENGTH = 120;

export interface ReplayedFiguresOptions {
  /** The git repository to run in. */
  readonly cwd: string;
  /** The revision the range starts after. */
  readonly base: string;
  /** The revision the range ends at. */
  readonly candidate: string;
  /** How long one replay may run, in milliseconds. */
  readonly timeoutMs?: number;
}

interface Run {
  readonly timedOut: boolean;
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run git with an argument vector and no shell. A run still going at the
 * bound is killed with its whole process group and answered at once, so a
 * process it left behind holding a pipe cannot hold the check.
 */
function runGit(cwd: string, args: readonly string[], timeoutMs: number): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args as string[], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    const timer = setTimeout(() => {
      try {
        process.kill(-(child.pid as number), "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ timedOut: true, code: null, signal: null, stdout: "", stderr: "" });
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        timedOut: false,
        code,
        signal,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8").trim(),
      });
    });
  });
}

/** Escape every character outside printable ASCII so a line cannot replay a terminal sequence or split. */
function escapeText(text: string): string {
  let escaped = "";
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint >= 0x20 && codePoint <= 0x7e) {
      escaped += char;
    } else {
      escaped += `\\u{${codePoint.toString(16).padStart(4, "0")}}`;
    }
  }
  return escaped;
}

function shown(output: string): string {
  const chars = [...output];
  if (chars.length <= SHOWN_OUTPUT_LENGTH) return `\`${output}\``;
  return `\`${chars.slice(0, SHOWN_OUTPUT_LENGTH).join("")}\`...`;
}

function finding(claim: FigureClaim, printed: string): string {
  return escapeText(`${claim.where}: \`${claim.command}\` printed ${printed} claims ${shown(claim.claimed)}`);
}

/** Whether the repository holds `id` as a commit. Any answer but yes or no is thrown. */
async function holdsCommit(cwd: string, id: string, timeoutMs: number): Promise<boolean> {
  const run = await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${id}^{commit}`], timeoutMs);
  if (run.code === 0) return true;
  if (run.code === 1) return false;
  const cause = run.timedOut ? "timed out" : run.stderr || `exit code ${run.code ?? run.signal}`;
  throw new Error(`git rev-parse could not look up commit ${id}: ${cause}`);
}

/** Replay one planned claim; the finding it is, or `null` when it is reproduced. */
async function replay(
  cwd: string,
  claim: FigureClaim,
  plan: ReplayPlan,
  timeoutMs: number,
  held: Map<string, boolean>,
): Promise<string | null> {
  for (const id of plan.commits) {
    if (!held.has(id)) held.set(id, await holdsCommit(cwd, id, timeoutMs));
    if (held.get(id) === false) return finding(claim, `nothing: the repository does not hold ${id};`);
  }
  const run = await runGit(cwd, ["--no-pager", ...plan.args], timeoutMs);
  if (run.timedOut) return finding(claim, `nothing: timed out after ${timeoutMs} ms;`);
  if (run.code !== 0) {
    return finding(claim, run.code === null ? `nothing: killed by ${run.signal};` : `nothing: exit code ${run.code};`);
  }
  const output = plan.countLines
    ? String(run.stdout.split("\n").length - 1)
    : run.stdout.endsWith("\n")
      ? run.stdout.slice(0, -1)
      : run.stdout;
  return output === claim.claimed ? null : finding(claim, shown(output));
}

function failure(cause: string): CheckRecord {
  return { name: NAME, status: "fail", evidence: [escapeText(cause)] };
}

/** Replay every figure claim the range adds and compare each with what it says. */
export async function checkReplayedFigures(options: ReplayedFiguresOptions): Promise<CheckRecord> {
  try {
    const timeoutMs = options.timeoutMs ?? DEFAULT_REPLAY_TIMEOUT_MS;
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return failure(`timeoutMs ${String(timeoutMs)} is not a positive number of milliseconds`);
    }
    const read = await readFigureClaims({ cwd: options.cwd, base: options.base, candidate: options.candidate });
    // The reader's text is held as it answers it; it quotes the revision it names.
    if ("failure" in read) return { name: NAME, status: "fail", evidence: [read.failure] };

    const findings: string[] = [];
    const held = new Map<string, boolean>();
    let reproduced = 0;
    let notReplayable = 0;
    for (const claim of read.claims) {
      const plan = planReplay(claim.command);
      if (plan === null) {
        notReplayable += 1;
        continue;
      }
      const found = await replay(options.cwd, claim, plan, timeoutMs, held);
      if (found === null) reproduced += 1;
      else findings.push(found);
    }
    if (findings.length > 0) return { name: NAME, status: "fail", evidence: findings };
    return { name: NAME, status: "pass", evidence: [`${reproduced} reproduced, ${notReplayable} not replayable`] };
  } catch (error) {
    return failure(`replayed-figures check could not run: ${error instanceof Error ? error.message : String(error)}`);
  }
}
