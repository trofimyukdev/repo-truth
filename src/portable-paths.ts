/**
 * Portable paths.
 *
 * Linux accepts almost any byte in a file name, so a repository developed
 * there can take in `Readme.md` beside `README.md`, a file called `aux.ts` or
 * a name that ends in a dot, and every check on Linux stays green. A clone on
 * macOS or Windows then silently keeps one of two files, or cannot check the
 * tree out at all. This check reads the names a range introduces and reports
 * the ones another operating system cannot hold.
 *
 * A NAME is the path of a tree entry or of a directory above one. The range
 * INTRODUCES a name when the candidate's tree holds it and the tree of the
 * merge base does not. Names the base already held are never reported by the
 * last three rules, and a case collision is reported only when at least one
 * of its spellings is introduced: a check that fails on names nobody in the
 * range wrote is a check that gets switched off.
 *
 * Both trees are read through git with an argument vector, never from the
 * working tree.
 */

import { execFile } from "node:child_process";

import type { CheckRecord } from "./index.js";

const NAME = "RT-10";

/** Where to look, and which two revisions bound the range. */
export interface PortablePathsOptions {
  /** The git repository to run in. */
  readonly cwd: string;
  /** The revision the range starts after. */
  readonly base: string;
  /** The revision the range ends at. */
  readonly candidate: string;
}

function runGit(cwd: string, args: readonly string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args as string[],
      { cwd, maxBuffer: 1024 * 1024 * 1024, encoding: "buffer" },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.toString("utf8").trim();
          reject(new Error(detail.length > 0 ? detail : error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Escape every character outside printable ASCII so a name can be printed to
 * a terminal without replaying whatever control sequence it smuggled in.
 */
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

function quote(text: string): string {
  return `"${escapeText(text)}"`;
}

/**
 * Decode a path as UTF-8; a path that is not valid UTF-8 is decoded byte for
 * byte instead, so that two different byte strings never become one name.
 */
function decodePath(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return bytes.toString("latin1");
  }
}

/** Every revision is resolved to a commit before it is used as anything else. */
async function resolveCommit(cwd: string, revision: string): Promise<string> {
  // A revision that begins with a dash would be read as an option.
  if (revision.length === 0 || revision.startsWith("-")) {
    throw new Error(`revision ${quote(revision)} names no commit`);
  }
  try {
    const out = await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`]);
    const hash = out.toString("utf8").trim();
    if (hash.length === 0) {
      throw new Error("empty answer");
    }
    return hash;
  } catch (error) {
    throw new Error(`revision ${quote(revision)} names no commit: ${(error as Error).message}`);
  }
}

async function mergeBase(cwd: string, base: string, candidate: string): Promise<string> {
  const label = `${base.slice(0, 12)} and ${candidate.slice(0, 12)}`;
  let out: Buffer;
  try {
    out = await runGit(cwd, ["merge-base", base, candidate]);
  } catch (error) {
    throw new Error(`no merge base of ${label}: ${(error as Error).message}`);
  }
  const hash = out.toString("utf8").trim();
  if (hash.length === 0) {
    throw new Error(`no merge base of ${label}`);
  }
  return hash;
}

/** Every name of a commit's tree: each path and each directory above one. */
async function readNames(cwd: string, commit: string): Promise<Set<string>> {
  let out: Buffer;
  try {
    out = await runGit(cwd, ["ls-tree", "-r", "-z", "--name-only", commit, "--"]);
  } catch (error) {
    throw new Error(`could not read the tree of ${commit.slice(0, 12)}: ${(error as Error).message}`);
  }
  const names = new Set<string>();
  let start = 0;
  for (let i = 0; i < out.length; i += 1) {
    if (out[i] !== 0) {
      continue;
    }
    const path = decodePath(out.subarray(start, i));
    start = i + 1;
    if (path.length === 0) {
      continue;
    }
    names.add(path);
    for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
      names.add(path.slice(0, slash));
    }
  }
  return names;
}

const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARACTER = /[<>:"\\|?*\u0000-\u001f\u007f-\u009f]/;

function lastComponent(name: string): string {
  return name.slice(name.lastIndexOf("/") + 1);
}

/** The rules that judge one introduced name by itself. */
function judge(name: string): string[] {
  const component = lastComponent(name);
  const findings: string[] = [];
  if (RESERVED.test(component.split(".")[0] ?? "")) {
    findings.push(`${quote(name)} is a reserved device name on Windows [reserved]`);
  }
  if (component.endsWith(".") || component.endsWith(" ")) {
    findings.push(`${quote(name)} ends in a dot or a space, which Windows drops [trailing]`);
  }
  if (FORBIDDEN_CHARACTER.test(component)) {
    findings.push(`${quote(name)} holds a character Windows forbids in a name [character]`);
  }
  return findings;
}

/** Names that differ only in letter case, at least one of them introduced. */
function caseFindings(candidateNames: ReadonlySet<string>, introduced: ReadonlySet<string>): string[] {
  const groups = new Map<string, string[]>();
  for (const name of candidateNames) {
    const key = name.toLowerCase();
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [name]);
    } else {
      group.push(name);
    }
  }
  const findings: string[] = [];
  for (const group of groups.values()) {
    if (group.length < 2 || !group.some((name) => introduced.has(name))) {
      continue;
    }
    group.sort();
    findings.push(`${group.map(quote).join(" and ")} differ only in letter case [case]`);
  }
  return findings;
}

/**
 * Check the names `base..candidate` introduces for the ones another operating
 * system cannot hold. Fails closed: a revision that names no commit, or any
 * git invocation that fails, is a `fail` record naming the cause - never a
 * `pass`, and never a thrown error.
 */
export async function checkPortablePaths(options: PortablePathsOptions): Promise<CheckRecord> {
  try {
    const { cwd, base, candidate } = options;
    const baseCommit = await resolveCommit(cwd, base);
    const candidateCommit = await resolveCommit(cwd, candidate);
    const ancestor = await mergeBase(cwd, baseCommit, candidateCommit);

    const [heldByBase, candidateNames] = await Promise.all([
      readNames(cwd, ancestor),
      readNames(cwd, candidateCommit),
    ]);

    const introduced = new Set<string>();
    for (const name of candidateNames) {
      if (!heldByBase.has(name)) {
        introduced.add(name);
      }
    }

    const evidence = caseFindings(candidateNames, introduced);
    for (const name of [...introduced].sort()) {
      evidence.push(...judge(name));
    }

    if (evidence.length > 0) {
      return { name: NAME, status: "fail", evidence };
    }
    return {
      name: NAME,
      status: "pass",
      evidence: [
        introduced.size === 0
          ? `no name introduced in ${quote(base)}..${quote(candidate)}`
          : `${introduced.size} name(s) introduced in ${quote(base)}..${quote(candidate)}, all portable`,
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name: NAME, status: "fail", evidence: [escapeText(message)] };
  }
}
