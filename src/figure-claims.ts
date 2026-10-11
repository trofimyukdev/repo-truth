/**
 * Figure claims.
 *
 * A measured figure is written in one form: a git command in a code span, the
 * word `printed`, and the output in a code span. This finds the claims of that
 * form a range adds, in its Markdown pages and in its commit messages. It
 * reads only through git, with an argument vector and never a shell, and never
 * from the working tree: a page is read as a blob of the candidate, and only
 * the lines the range adds to it - against the file of the merge base it was
 * renamed from, when git pairs it with one - can hold a claim. The text of a
 * page or a body is read by `claimsInText`, which is RT-28's.
 */

import { execFile } from "node:child_process";

import { claimsInText } from "./figure-text.js";

/** One figure claim of the range. */
export interface FigureClaim {
  /** `<path>:<line>` for a page, the full commit id for a commit body. */
  readonly where: string;
  /** The text of the command's code span. */
  readonly command: string;
  /** The text of the claimed output's code span. */
  readonly claimed: string;
}

export interface FigureClaimsOptions {
  readonly cwd: string;
  /** The revision the range starts after. */
  readonly base: string;
  /** The revision the range ends at. */
  readonly candidate: string;
}

export type FigureClaimsResult = { claims: FigureClaim[] } | { failure: string };

const ZERO_ID = /^0+$/;

function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args as string[],
      { cwd, maxBuffer: 1024 * 1024 * 1024, encoding: "utf8" },
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

async function resolveCommit(cwd: string, revision: string): Promise<string> {
  // A revision that begins with a dash would be read as an option.
  if (typeof revision !== "string" || revision.length === 0 || revision.startsWith("-")) {
    throw new Error(`revision ${JSON.stringify(String(revision))} does not name a commit`);
  }
  let hash = "";
  try {
    hash = (await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`])).trim();
  } catch (error) {
    throw new Error(`revision ${JSON.stringify(revision)} does not name a commit: ${(error as Error).message}`);
  }
  if (hash.length === 0) throw new Error(`revision ${JSON.stringify(revision)} does not name a commit`);
  return hash;
}

interface ChangedPage {
  readonly path: string;
  /** The blob of the merge base this page comes from, or `null` for a page the range adds. */
  readonly oldId: string | null;
  readonly newId: string;
}

/** The Markdown pages of the candidate that differ from the merge base, paired by rename detection. */
async function changedPages(cwd: string, mergeBase: string, candidate: string): Promise<ChangedPage[]> {
  const out = await runGit(cwd, [
    "diff-tree", "-r", "-M", "-z", "--no-ext-diff", "--no-textconv", mergeBase, candidate,
  ]);
  const fields = out.split("\0");
  const pages: ChangedPage[] = [];
  let i = 0;
  while (i < fields.length) {
    const meta = fields[i++] as string;
    if (!meta.startsWith(":")) continue;
    const [, newMode = "", oldId = "", newId = "", status = ""] = meta.split(/\s+/);
    const first = fields[i++] ?? "";
    const path = status.startsWith("R") || status.startsWith("C") ? (fields[i++] ?? "") : first;
    if (status.startsWith("D") || !path.endsWith(".md")) continue;
    if (!newMode.startsWith("100") || ZERO_ID.test(newId)) continue;
    pages.push({ path, oldId: ZERO_ID.test(oldId) ? null : oldId, newId });
  }
  return pages;
}

/** The lines, counted from 1, that the new blob holds and the old one does not. */
async function addedLines(cwd: string, page: ChangedPage, text: string): Promise<Set<number>> {
  const added = new Set<number>();
  if (page.oldId === null) {
    const total = text.split("\n").length;
    for (let line = 1; line <= total; line += 1) added.add(line);
    return added;
  }
  if (page.oldId === page.newId) return added;
  const diff = await runGit(cwd, [
    "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "-U0", page.oldId, page.newId,
  ]);
  for (const header of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(header[1]);
    const count = header[2] === undefined ? 1 : Number(header[2]);
    for (let line = start; line < start + count; line += 1) added.add(line);
  }
  return added;
}

async function pageClaims(cwd: string, mergeBase: string, candidate: string): Promise<FigureClaim[]> {
  const claims: FigureClaim[] = [];
  for (const page of await changedPages(cwd, mergeBase, candidate)) {
    const text = await runGit(cwd, ["cat-file", "blob", page.newId]);
    const added = await addedLines(cwd, page, text);
    for (const claim of claimsInText(text, "paragraphs")) {
      if (added.has(claim.line)) {
        claims.push({ where: `${page.path}:${claim.line}`, command: claim.command, claimed: claim.claimed });
      }
    }
  }
  return claims;
}

async function bodyClaims(cwd: string, base: string, candidate: string): Promise<FigureClaim[]> {
  const out = await runGit(cwd, ["log", "-z", "--format=%H%n%B", `${base}..${candidate}`]);
  const claims: FigureClaim[] = [];
  for (const record of out.split("\0")) {
    const newline = record.indexOf("\n");
    if (newline < 0) continue;
    const id = record.slice(0, newline).replace(/^\n+/, "");
    const body = record.slice(newline + 1);
    for (const claim of claimsInText(body, "whole")) {
      claims.push({ where: id, command: claim.command, claimed: claim.claimed });
    }
  }
  return claims;
}

/** Every figure claim the range adds, or a failure naming why they could not be read. */
export async function readFigureClaims(options: FigureClaimsOptions): Promise<FigureClaimsResult> {
  try {
    const { cwd } = options;
    const base = await resolveCommit(cwd, options.base);
    const candidate = await resolveCommit(cwd, options.candidate);
    let mergeBase = "";
    try {
      mergeBase = (await runGit(cwd, ["merge-base", base, candidate])).trim();
    } catch (error) {
      throw new Error(`no merge base of ${base} and ${candidate}: ${(error as Error).message}`);
    }
    if (mergeBase.length === 0) throw new Error(`no merge base of ${base} and ${candidate}`);
    const pages = await pageClaims(cwd, mergeBase, candidate);
    const bodies = await bodyClaims(cwd, base, candidate);
    return { claims: [...pages, ...bodies] };
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error) };
  }
}
