/**
 * Autosquash leftovers.
 *
 * `git commit --fixup`, `--squash` and `--fixup=amend:` write a commit whose
 * subject begins with `fixup! `, `squash! ` or `amend! `, a note that
 * `git rebase --autosquash` is to fold it into an earlier commit. This check
 * reads the subject of every commit of `base..candidate` as `git log --format=%s`
 * prints it (the first paragraph, its lines joined by spaces) and reports each
 * commit whose subject begins with one of `AUTOSQUASH_PREFIXES`.
 *
 * The list is read each time the check runs: a consumer appends its own entry.
 * There is no sanction; the fix is to squash the commits before the range lands.
 */

import { execFile } from "node:child_process";

import type { CheckRecord } from "../index.js";

export const name = "RT-29";

/** The prefixes git's autosquash reads, compared character for character. */
export const AUTOSQUASH_PREFIXES: string[] = ["fixup! ", "squash! ", "amend! "];

export interface AutosquashOptions {
  readonly cwd: string;
  readonly base: string;
  readonly candidate: string;
}

const ID_LENGTH = 12;

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

/** The commit a revision names; throws a message that names the revision when it names none. */
async function resolveCommit(cwd: string, revision: string): Promise<string> {
  try {
    const out = await runGit(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${revision}^{commit}`]);
    const id = out.trim();
    if (id !== "") return id;
  } catch {
    // a revision that does not resolve is reported by name below
  }
  throw new Error(`revision ${revision} names no commit`);
}

export async function check(options: AutosquashOptions): Promise<CheckRecord> {
  try {
    const base = await resolveCommit(options.cwd, options.base);
    const candidate = await resolveCommit(options.cwd, options.candidate);
    const log = await runGit(options.cwd, [
      "log",
      "-z",
      "--topo-order",
      "--reverse",
      "--encoding=UTF-8",
      "--format=%H %s",
      `${base}..${candidate}`,
      "--",
    ]);

    const prefixes = AUTOSQUASH_PREFIXES.filter((prefix) => prefix !== "");
    const findings: string[] = [];
    for (const entry of log.split("\0")) {
      if (entry === "") continue;
      const space = entry.indexOf(" ");
      const id = entry.slice(0, space);
      const subject = entry.slice(space + 1);
      if (prefixes.some((prefix) => subject.startsWith(prefix))) {
        findings.push(`${id.slice(0, ID_LENGTH)} ${escapeText(subject)}`);
      }
    }

    if (findings.length > 0) return { name, status: "fail", evidence: findings };
    return { name, status: "pass", evidence: ["no autosquash subject in the range"] };
  } catch (error) {
    return { name, status: "fail", evidence: [`git failed: ${escapeText(error instanceof Error ? error.message : String(error))}`] };
  }
}
