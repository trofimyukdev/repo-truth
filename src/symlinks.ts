/**
 * Symlinks.
 *
 * A symbolic link is committed as a blob holding its target, so a diff shows a
 * link to `/etc/passwd` as one harmless line of text. This check reads every
 * link `base..candidate` adds, retargets or turns a file into, takes the
 * target from the candidate's own blob (never from the working tree), resolves
 * it from the link's own directory and reports one that is [absolute], that
 * climbs [outside] the repository, or that lands in the repository's [.git]
 * directory. A target inside the repository is not a finding whether or not
 * anything exists there.
 */

import { execFile } from "node:child_process";

import type { CheckRecord } from "./index.js";

const NAME = "RT-11";

const SYMLINK_MODE = "120000";

/** Where to look, and which two revisions bound the range. */
export interface SymlinksOptions {
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

function decodeText(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return bytes.toString("latin1");
  }
}

function splitNul(out: Buffer): string[] {
  const fields: string[] = [];
  let start = 0;
  for (let i = 0; i < out.length; i += 1) {
    if (out[i] === 0) {
      fields.push(decodeText(out.subarray(start, i)));
      start = i + 1;
    }
  }
  return fields;
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

interface Link {
  readonly path: string;
  readonly blob: string;
}

/** The links the range adds, retargets or turns a file into, read from the diff of the two commits. */
async function changedLinks(root: string, base: string, candidate: string): Promise<Link[]> {
  const label = `${base.slice(0, 12)} and ${candidate.slice(0, 12)}`;
  let ancestor: string;
  try {
    ancestor = (await runGit(root, ["merge-base", base, candidate])).toString("utf8").trim();
  } catch (error) {
    throw new Error(`no merge base of ${label}: ${(error as Error).message}`);
  }
  if (ancestor.length === 0) {
    throw new Error(`no merge base of ${label}`);
  }
  let out: Buffer;
  try {
    out = await runGit(root, [
      "diff-tree",
      "-r",
      "-z",
      "--raw",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--diff-filter=ACMRT",
      "--abbrev=40",
      ancestor,
      candidate,
      "--",
    ]);
  } catch (error) {
    throw new Error(`could not read the entries changed by the range: ${(error as Error).message}`);
  }
  const fields = splitNul(out);
  const links: Link[] = [];
  // Each entry is ":oldmode newmode oldsha newsha status" then the path.
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = (fields[i] ?? "").replace(/^:/, "").split(" ");
    const path = fields[i + 1] ?? "";
    if (meta[1] === SYMLINK_MODE && meta[3] !== undefined) {
      links.push({ path, blob: meta[3] });
    }
  }
  return links.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function readTarget(root: string, link: Link): Promise<string> {
  try {
    return decodeText(await runGit(root, ["cat-file", "blob", link.blob]));
  } catch (error) {
    throw new Error(`could not read the blob of link ${quote(link.path)}: ${(error as Error).message}`);
  }
}

/** The rule a target breaks when the link at `path` points at it, or undefined if it stays inside. */
function brokenRule(path: string, target: string): "absolute" | "outside" | ".git" | undefined {
  if (target.startsWith("/") || target.startsWith("\\\\") || /^[A-Za-z]:/.test(target)) {
    return "absolute";
  }
  const stack = path.split("/").slice(0, -1);
  for (const segment of target.split(/[\\/]/)) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (stack.length === 0) {
        return "outside";
      }
      stack.pop();
    } else {
      stack.push(segment);
    }
  }
  if ((stack[0] ?? "").toLowerCase() === ".git") {
    return ".git";
  }
  return undefined;
}

/**
 * Check every link `base..candidate` adds or changes. Fails closed: a revision
 * that names no commit, or any git invocation that fails, is a `fail` record
 * naming the cause - never a `pass`, and never a thrown error.
 */
export async function checkSymlinks(options: SymlinksOptions): Promise<CheckRecord> {
  try {
    const { cwd, base, candidate } = options;
    const baseCommit = await resolveCommit(cwd, base);
    const candidateCommit = await resolveCommit(cwd, candidate);
    const root = (await runGit(cwd, ["rev-parse", "--show-toplevel"])).toString("utf8").replace(/\r?\n$/, "");

    const links = await changedLinks(root, baseCommit, candidateCommit);
    const evidence: string[] = [];
    for (const link of links) {
      const target = await readTarget(root, link);
      const rule = brokenRule(link.path, target);
      if (rule !== undefined) {
        evidence.push(`link ${quote(link.path)} -> ${quote(target)} breaks rule [${rule}]`);
      }
    }

    if (evidence.length > 0) {
      return { name: NAME, status: "fail", evidence };
    }
    return {
      name: NAME,
      status: "pass",
      evidence: [`${links.length} link(s) added or changed in ${quote(base)}..${quote(candidate)} stay inside the repository`],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name: NAME, status: "fail", evidence: [escapeText(message)] };
  }
}
