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
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CliIo } from "./cli.js";

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

/**
 * The command's arguments for the Action: `argv` as given, then one
 * `--check <name>` per name in `env.REPO_TRUTH_CHECKS` (split at white space and
 * commas), then `--format <format>` when `env.REPO_TRUTH_FORMAT` is set. Nothing
 * is run, expanded or matched: every name is one argument, as written.
 */
export function actionArguments(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): string[] {
  const out = [...argv];
  for (const name of (env.REPO_TRUTH_CHECKS ?? "").split(/[\s,]+/)) {
    if (name !== "") out.push("--check", name);
  }
  const format = env.REPO_TRUTH_FORMAT;
  if (format !== undefined && format !== "") out.push("--format", format);
  return out;
}

function isActionEntryPoint(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

const OUTCOMES: Readonly<Record<number, string>> = {
  0: "All checks passed (exit code 0).",
  1: "At least one check failed (exit code 1).",
  2: "The checks did not run (exit code 2).",
};

/**
 * The job summary of a run: a heading, the outcome in one sentence, and the
 * output whole in one fenced block whose fence is longer than any run of
 * backticks the output holds, so no text of it closes or opens a block.
 */
export function jobSummary(exitCode: number, output: string): string {
  const sentence = OUTCOMES[exitCode] ?? `The run ended with exit code ${exitCode}.`;
  const body = output.endsWith("\n") ? output.slice(0, -1) : output;
  const longest = Math.max(0, ...(output.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `## repo-truth\n\n${sentence}\n\n${fence}\n${body === "" ? "" : body + "\n"}${fence}\n`;
}

/**
 * What the Action's program does: run the command with the Action's
 * arguments, pass its output on, and append the job summary to the file
 * `env.GITHUB_STEP_SUMMARY` names, if any. Resolves to the command's exit code.
 */
export async function runAction(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: CliIo = {},
): Promise<number> {
  const { main } = await import("./cli.js");
  let stdout = "";
  let stderr = "";
  const toStderr = (text: string): void => {
    if (io.stderr) io.stderr(text);
    else process.stderr.write(text);
  };
  const code = await main(actionArguments(argv, env), {
    ...io,
    stdout: (text) => {
      stdout += text;
      if (io.stdout) io.stdout(text);
      else process.stdout.write(text);
    },
    stderr: (text) => {
      stderr += text;
      toStderr(text);
    },
  });
  const file = env.GITHUB_STEP_SUMMARY;
  if (file !== undefined && file !== "") {
    try {
      const held = existsSync(file) ? readFileSync(file, "utf8") : "";
      const lead = held !== "" && !held.endsWith("\n") ? "\n" : "";
      appendFileSync(file, lead + jobSummary(code, code === 2 ? stderr : stdout));
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ");
      toStderr(`repo-truth: could not write the job summary: ${reason}\n`);
    }
  }
  return code;
}

// cli.ts imports this module, so `main` is reached only by a dynamic import
// made after this module has finished loading.
if (isActionEntryPoint()) {
  void (async () => {
    try {
      process.exitCode = await runAction(process.argv.slice(2), process.env);
    } catch (error) {
      process.stderr.write(`repo-truth: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    }
  })();
}
