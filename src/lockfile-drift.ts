/**
 * Lockfile drift.
 *
 * The manifest (the root `package.json`) and the lockfile are two statements of
 * one install. A range that changes a dependency field of the manifest without
 * the lockfile leaves a pin that no longer matches what was asked for (a stale
 * pin); a range that changes the lockfile without a dependency field of the
 * manifest moves a version with no request behind it (an unrequested change).
 * The two are reported in different words because the fix and the alarm differ.
 *
 * Lockfiles are never parsed: they are compared by git object id at the two
 * revisions. Only the manifest is parsed, and only to compare its dependency
 * fields, so a script or description edit is not drift. A repository with no
 * manifest or no recognised lockfile gets a `skip` naming what was looked for.
 */

import { execFile } from "node:child_process";

import type { CheckRecord } from "./index.js";

const NAME = "RT-06";

/** Where to look, and which two revisions bound the range. */
export interface LockfileDriftOptions {
  /** The git repository to run in. */
  readonly cwd: string;
  /** The revision the range starts after. */
  readonly base: string;
  /** The revision the range ends at. */
  readonly candidate: string;
}

const MANIFEST = "package.json";

/** The manifest fields that say what to install. */
export const DEPENDENCY_FIELDS: string[] = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "bundledDependencies",
  "bundleDependencies",
];

/** The lockfiles recognised at the repository root. */
export const LOCKFILES: string[] = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
];

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

/** Escape everything outside printable ASCII so a name cannot replay a control sequence. */
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

async function resolveCommit(cwd: string, revision: string): Promise<string> {
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

/** The blob id of a root file at a commit, or undefined when the commit has no such file. */
async function blobId(root: string, commit: string, path: string): Promise<string | undefined> {
  const out = (await runGit(root, ["ls-tree", "-z", commit, "--", path])).toString("utf8");
  const entry = out.split("\0")[0] ?? "";
  const match = /^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/s.exec(entry);
  if (match === null || match[4] !== path || match[2] !== "blob") {
    return undefined;
  }
  return match[3];
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** The dependency fields of a manifest blob, in a form that compares by value. */
async function dependencyView(root: string, id: string, label: string): Promise<string> {
  const text = (await runGit(root, ["cat-file", "blob", id])).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${MANIFEST} at ${label} is not valid JSON: ${(error as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${MANIFEST} at ${label} is not a JSON object`);
  }
  const fields: Record<string, unknown> = {};
  for (const field of DEPENDENCY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(parsed, field)) {
      fields[field] = canonical((parsed as Record<string, unknown>)[field]);
    }
  }
  return JSON.stringify(fields);
}

/**
 * Compare the manifest's dependency fields and the root lockfiles between the
 * merge base of `base` and `candidate` and `candidate`. Fails closed: a
 * revision that names no commit, or any git invocation that fails, is a `fail`
 * record naming the cause - never a `pass`, and never a thrown error.
 */
export async function checkLockfileDrift(options: LockfileDriftOptions): Promise<CheckRecord> {
  try {
    const { cwd, base, candidate } = options;
    const baseCommit = await resolveCommit(cwd, base);
    const candidateCommit = await resolveCommit(cwd, candidate);
    const root = (await runGit(cwd, ["rev-parse", "--show-toplevel"])).toString("utf8").replace(/\r?\n$/, "");
    let ancestor: string;
    try {
      ancestor = (await runGit(root, ["merge-base", baseCommit, candidateCommit])).toString("utf8").trim();
    } catch (error) {
      throw new Error(`no merge base of ${quote(base)} and ${quote(candidate)}: ${(error as Error).message}`);
    }
    if (ancestor.length === 0) {
      throw new Error(`no merge base of ${quote(base)} and ${quote(candidate)}`);
    }

    const range = `${quote(base)}..${quote(candidate)}`;
    const looked = `looked for ${MANIFEST} and one of ${LOCKFILES.join(", ")} at the repository root`;
    const manifestBefore = await blobId(root, ancestor, MANIFEST);
    const manifestAfter = await blobId(root, candidateCommit, MANIFEST);
    if (manifestBefore === undefined && manifestAfter === undefined) {
      return { name: NAME, status: "skip", evidence: [`no ${MANIFEST} found in ${range}; ${looked}`] };
    }

    const lockfiles: { name: string; changed: boolean }[] = [];
    for (const name of LOCKFILES) {
      const before = await blobId(root, ancestor, name);
      const after = await blobId(root, candidateCommit, name);
      if (before !== undefined || after !== undefined) {
        lockfiles.push({ name, changed: before !== after });
      }
    }
    if (lockfiles.length === 0) {
      return { name: NAME, status: "skip", evidence: [`no recognised lockfile found in ${range}; ${looked}`] };
    }

    let dependenciesChanged = false;
    if (manifestBefore !== manifestAfter) {
      const viewBefore = manifestBefore === undefined ? "" : await dependencyView(root, manifestBefore, quote(base));
      const viewAfter = manifestAfter === undefined ? "" : await dependencyView(root, manifestAfter, quote(candidate));
      dependenciesChanged = viewBefore !== viewAfter;
    }
    const changedLocks = lockfiles.filter((lock) => lock.changed).map((lock) => lock.name);
    const lockNames = lockfiles.map((lock) => lock.name).join(", ");

    if (dependenciesChanged && changedLocks.length === 0) {
      return {
        name: NAME,
        status: "fail",
        evidence: [
          `stale pin: a dependency field of ${MANIFEST} changed in ${range} but ${lockNames} did not, so the lockfile no longer records what the manifest asks for`,
        ],
      };
    }
    if (!dependenciesChanged && changedLocks.length > 0) {
      return {
        name: NAME,
        status: "fail",
        evidence: [
          `unrequested change: ${changedLocks.join(", ")} changed in ${range} but no dependency field of ${MANIFEST} did, so a resolved version moved with no request behind it`,
        ],
      };
    }
    return {
      name: NAME,
      status: "pass",
      evidence: [
        dependenciesChanged
          ? `${MANIFEST} dependency fields and ${changedLocks.join(", ")} changed together`
          : `neither the dependency fields of ${MANIFEST} nor ${lockNames} changed`,
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name: NAME, status: "fail", evidence: [escapeText(message)] };
  }
}
