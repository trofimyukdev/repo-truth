/**
 * Conflict markers.
 *
 * A merge, a rebase or a cherry-pick that stops on a conflict writes marker
 * lines into the file, and whoever resolves it by editing around them can
 * commit them. A compiler catches that in some files and not in others: a
 * Markdown page, a YAML fixture or a JSON snapshot carries the markers
 * silently. This check reads the lines `git diff base...candidate` shows as
 * ADDED and reports every conflict marker among them with its file and line.
 *
 * Only added lines count. A marker the base already holds is not the range's
 * doing, and a line the range removes is never read as one it adds, so the
 * commit that deletes a leftover marker is not itself reported. The lines come
 * from git's diff of the two commits, never from the working tree.
 *
 * A marker is a line that begins with exactly seven of one marker character
 * followed by whitespace or the end of the line. `<` opens a conflict, `|`
 * opens the common ancestor's part and `>` closes it; those three are always
 * findings. `=` separates the two sides, and a line of seven equals signs is
 * also what underlines a Markdown heading, so a separator is a finding only
 * between an opening marker and the next closing marker among the added lines
 * of the same file.
 */

import { execFile } from "node:child_process";

import type { CheckRecord } from "./index.js";

const NAME = "RT-09";

/** Where to look, and which two revisions bound the range. */
export interface ConflictMarkersOptions {
  /** The git repository to run in. */
  readonly cwd: string;
  /** The revision the range starts after. */
  readonly base: string;
  /** The revision the range ends at. */
  readonly candidate: string;
}

type MarkerKind = "opening" | "base" | "separator" | "closing";

/** Seven of one marker character, then ASCII whitespace or the end of the line. */
const MARKER = /^(?:(<{7})|(\|{7})|(={7})|(>{7}))(?:[ \t\r\f\v]|$)/;

function markerKind(line: string): MarkerKind | undefined {
  const match = MARKER.exec(line);
  if (match === null) {
    return undefined;
  }
  if (match[1] !== undefined) return "opening";
  if (match[2] !== undefined) return "base";
  if (match[3] !== undefined) return "separator";
  return "closing";
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

/** Escape control characters so a name or revision cannot replay a terminal sequence or split a line. */
function escapeControl(text: string): string {
  let escaped = "";
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) {
      escaped += `\\u{${codePoint.toString(16).padStart(4, "0")}}`;
    } else {
      escaped += char;
    }
  }
  return escaped;
}

function quote(text: string): string {
  return `"${escapeControl(text)}"`;
}

function decodePath(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return bytes.toString("latin1");
  }
}

function splitNul(out: Buffer): string[] {
  const paths: string[] = [];
  let start = 0;
  for (let i = 0; i < out.length; i += 1) {
    if (out[i] === 0) {
      if (i > start) {
        paths.push(decodePath(out.subarray(start, i)));
      }
      start = i + 1;
    }
  }
  return paths;
}

async function resolveCommit(cwd: string, revision: string): Promise<string> {
  if (revision.length === 0 || revision.startsWith("-")) {
    throw new Error(`revision ${quote(revision)} names no commit`);
  }
  let hash: string;
  try {
    const out = await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`]);
    hash = out.toString("utf8").trim();
  } catch (error) {
    throw new Error(`revision ${quote(revision)} names no commit: ${(error as Error).message}`);
  }
  if (hash.length === 0) {
    throw new Error(`revision ${quote(revision)} names no commit`);
  }
  return hash;
}

/** One added line: where it is in the candidate's file, and what it says. */
interface AddedLine {
  readonly line: number;
  readonly text: string;
}

/** The lines added to each file, in the order git lists the files. */
async function addedLines(
  cwd: string,
  base: string,
  candidate: string,
): Promise<Array<{ path: string; lines: AddedLine[] }>> {
  const common = [
    "-c",
    "core.quotePath=false",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--no-renames",
    "--ignore-submodules=none",
    "--submodule=short",
    "--text",
  ];
  const range = `${base}...${candidate}`;
  let names: string[];
  let patch: Buffer;
  try {
    names = splitNul(await runGit(cwd, [...common, "--name-only", "-z", range, "--"]));
    patch = await runGit(cwd, [...common, "-U0", range, "--"]);
  } catch (error) {
    throw new Error(`could not read the lines added by ${quote(`${base}...${candidate}`)}: ${(error as Error).message}`);
  }

  const files: Array<{ path: string; lines: AddedLine[] }> = [];
  let current: AddedLine[] | undefined;
  let oldLeft = 0;
  let newLeft = 0;
  let newLine = 0;

  // Both listings come from the same diff, so the Nth `diff --git` section is the Nth name.
  for (const raw of patch.toString("latin1").split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      if (raw.startsWith("+") && newLeft > 0) {
        current?.push({ line: newLine, text: raw.slice(1) });
        newLine += 1;
        newLeft -= 1;
      } else if (raw.startsWith("-") && oldLeft > 0) {
        oldLeft -= 1;
      }
      continue;
    }
    if (raw.startsWith("diff --git ")) {
      current = [];
      files.push({ path: names[files.length] ?? "", lines: current });
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (hunk !== null) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
      newLine = Number(hunk[2]);
    }
  }
  if (files.length !== names.length) {
    throw new Error(`git listed ${names.length} changed path(s) but ${files.length} in its patch`);
  }
  return files;
}

/** The findings among one file's added lines, as evidence lines. */
function findingsIn(path: string, lines: readonly AddedLine[]): string[] {
  const evidence: string[] = [];
  const label = escapeControl(path);
  let open = false;
  let pending: string[] = [];
  for (const { line, text } of lines) {
    const kind = markerKind(text);
    if (kind === undefined) {
      continue;
    }
    const entry = `${label}:${line}: ${kind} marker`;
    if (kind === "separator") {
      if (open) {
        pending.push(entry);
      }
      continue;
    }
    if (kind === "closing") {
      evidence.push(...pending);
      open = false;
      pending = [];
    } else if (kind === "opening") {
      open = true;
    }
    evidence.push(entry);
  }
  return evidence;
}

/**
 * Check the lines `base...candidate` adds for leftover conflict markers.
 * Fails closed: a revision that names no commit, or any git invocation that
 * fails, is a `fail` record naming the cause - never a `pass`, and never a
 * thrown error.
 */
export async function checkConflictMarkers(options: ConflictMarkersOptions): Promise<CheckRecord> {
  try {
    const { cwd, base, candidate } = options;
    const baseCommit = await resolveCommit(cwd, base);
    const candidateCommit = await resolveCommit(cwd, candidate);
    const files = await addedLines(cwd, baseCommit, candidateCommit);

    const evidence: string[] = [];
    let scanned = 0;
    for (const { path, lines } of files) {
      scanned += lines.length;
      evidence.push(...findingsIn(path, lines));
    }

    if (evidence.length > 0) {
      return { name: NAME, status: "fail", evidence };
    }
    return {
      name: NAME,
      status: "pass",
      evidence: [`${scanned} added line(s) in ${quote(base)}...${quote(candidate)} hold no conflict marker`],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name: NAME, status: "fail", evidence: [escapeControl(message)] };
  }
}
