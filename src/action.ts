/**
 * Range resolution for a pull request.
 *
 * A pull request's range is `merge-base(target, candidate)..candidate`, never
 * `target..candidate`: commits that landed on the target after the branch
 * forked are not the pull request's, and a rebased branch must not be charged
 * for them. The merge base is also what a default shallow checkout lacks, so
 * its absence is a stated failure, never an empty range that passes.
 */

import { execFile } from "node:child_process";

/** The range cannot be resolved; the command maps this to its bad-invocation code. */
export class RangeResolutionError extends Error {}

/** Events whose range is a pull request's. Every other event has no `--target` rule. */
export const PULL_REQUEST_EVENTS: readonly string[] = ["pull_request", "pull_request_target"];

/**
 * Refuse `--target` for an event that is not a pull request. An unset event
 * name (a local run) is allowed.
 */
export function assertPullRequestEvent(eventName: string | undefined): void {
  if (eventName === undefined || eventName === "") return;
  if (!PULL_REQUEST_EVENTS.includes(eventName)) {
    throw new RangeResolutionError(
      `--target resolves a pull request's range, but this run is a ${JSON.stringify(eventName)} event; ` +
        `name the range with --base instead`,
    );
  }
}

function git(cwd: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args as string[],
      { cwd, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 128) : 0;
        resolve({ code, stdout, stderr: stderr.trim() || (error ? error.message : "") });
      },
    );
  });
}

/**
 * The merge base of two commits, as `git merge-base <target> <candidate>`
 * prints it. Throws `RangeResolutionError` naming the missing history and the
 * fetch depth needed when there is none.
 */
export async function resolveMergeBase(cwd: string, target: string, candidate: string): Promise<string> {
  const result = await git(cwd, ["merge-base", target, candidate]);
  const base = result.stdout.trim().split("\n")[0] ?? "";
  if (result.code === 0 && base.length > 0) return base;

  const shallow = (await git(cwd, ["rev-parse", "--is-shallow-repository"])).stdout.trim() === "true";
  if (shallow) {
    throw new RangeResolutionError(
      `the merge base of ${target} and ${candidate} is missing: this checkout is shallow and does not contain ` +
        `the history that joins them. Check out with \`fetch-depth: 0\` (the actions/checkout input) so the full history is fetched`,
    );
  }
  if (result.code === 1) {
    throw new RangeResolutionError(
      `the merge base of ${target} and ${candidate} is missing: the two share no history. ` +
        `If the checkout is partial, check out with \`fetch-depth: 0\` (the actions/checkout input)`,
    );
  }
  throw new RangeResolutionError(`could not compute the merge base of ${target} and ${candidate}: ${result.stderr}`);
}
