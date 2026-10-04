/**
 * Large blobs.
 *
 * History keeps every blob a commit ever held, so a build artefact or a
 * dataset committed by accident and deleted again is gone from the tree and
 * still in every clone. This check measures every blob the range brings into
 * the history - those reachable from `candidate` and not from `base` - and
 * names each one over a size limit, including blobs the candidate's own tree
 * no longer holds.
 *
 * A blob reachable from `base` is never a finding, so a rename or a copy of a
 * large base blob (same object, new path) and a change beside it stay quiet.
 * Sizes come from the object store through `git cat-file`, never from the
 * working tree. A blob larger than the limit is a finding; one exactly at it
 * is not. The limit is `maxBytes`, and `DEFAULT_MAX_BLOB_BYTES` when absent.
 *
 * The check fails closed: an unresolvable revision, a failing git invocation
 * or an invalid `maxBytes` is a `fail` record naming the cause.
 */

import { execFile } from "node:child_process";

import type { CheckRecord } from "./index.js";

const NAME = "RT-12";

/** One mebibyte: the limit when the caller sets none. */
export const DEFAULT_MAX_BLOB_BYTES = 1048576;

/** Where to look, which two revisions bound the range, and the size limit. */
export interface LargeBlobsOptions {
  /** The git repository to run in. */
  readonly cwd: string;
  /** The revision the range starts after. */
  readonly base: string;
  /** The revision the range ends at. */
  readonly candidate: string;
  /** The largest blob size, in bytes, that is not a finding. */
  readonly maxBytes?: number;
}

function runGit(cwd: string, args: readonly string[], input?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
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
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input ?? "");
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

function decode(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return bytes.toString("latin1");
  }
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

const OBJECT_LINE = /^([0-9a-f]{40}|[0-9a-f]{64})(?: (.*))?$/;

/** Every object `rev-list --objects` lists, with the first path (in sort order) it names. */
function parseObjects(out: Buffer): Map<string, string | undefined> {
  const objects = new Map<string, string | undefined>();
  for (const line of decode(out).split("\n")) {
    const match = OBJECT_LINE.exec(line);
    if (match === null) continue;
    const oid = match[1] as string;
    const path = match[2];
    const known = objects.get(oid);
    if (!objects.has(oid) || (path !== undefined && (known === undefined || path < known))) {
      objects.set(oid, path);
    }
  }
  return objects;
}

interface Finding {
  readonly path: string;
  readonly size: number;
  readonly inTree: boolean;
}

async function findLargeBlobs(
  cwd: string,
  base: string,
  candidate: string,
  max: number,
): Promise<{ findings: Finding[]; added: number }> {
  const added = parseObjects(await runGit(cwd, ["rev-list", "--objects", candidate, `^${base}`, "--"]));
  // Reachability from the base is by history, not by the base's tip alone.
  const held = parseObjects(await runGit(cwd, ["rev-list", "--objects", base, "--"]));
  const fresh = [...added.keys()].filter((oid) => !held.has(oid));
  if (fresh.length === 0) return { findings: [], added: 0 };

  const sizes = decode(
    await runGit(cwd, ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], `${fresh.join("\n")}\n`),
  );
  const large = new Map<string, number>();
  let addedBlobs = 0;
  for (const line of sizes.split("\n")) {
    if (line.length === 0) continue;
    const parts = line.split(" ");
    if (parts.length !== 3 || parts[1] === "missing") {
      throw new Error(`git cat-file could not measure an object: ${quote(line)}`);
    }
    if (parts[1] === "blob") addedBlobs += 1;
    if (parts[1] === "blob" && Number(parts[2]) > max) {
      large.set(parts[0] as string, Number(parts[2]));
    }
  }
  if (large.size === 0) return { findings: [], added: addedBlobs };

  const tree = decode(await runGit(cwd, ["ls-tree", "-r", "--format=%(objectname)", candidate, "--"]));
  const inTree = new Set(tree.split("\n").filter((line) => line.length > 0));

  const findings: Finding[] = [];
  for (const [oid, size] of large) {
    findings.push({ path: added.get(oid) ?? oid, size, inTree: inTree.has(oid) });
  }
  findings.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { findings, added: addedBlobs };
}

function failure(cause: string): CheckRecord {
  return { name: NAME, status: "fail", evidence: [cause] };
}

/** Measure every blob the range adds to the history against the size limit. */
export async function checkLargeBlobs(options: LargeBlobsOptions): Promise<CheckRecord> {
  try {
    const max = options.maxBytes ?? DEFAULT_MAX_BLOB_BYTES;
    if (typeof max !== "number" || !Number.isSafeInteger(max) || max <= 0) {
      return failure(`maxBytes ${quote(String(max))} is not a positive integer`);
    }
    const base = await resolveCommit(options.cwd, options.base);
    const candidate = await resolveCommit(options.cwd, options.candidate);
    const { findings, added } = await findLargeBlobs(options.cwd, base, candidate, max);
    if (findings.length === 0) {
      return {
        name: NAME,
        status: "pass",
        evidence: [
          `${added} blob(s) added in ${quote(options.base)}..${quote(options.candidate)}, none over ${max} bytes`,
        ],
      };
    }
    return {
      name: NAME,
      status: "fail",
      evidence: findings.map(
        (f) =>
          `${quote(f.path)} is ${f.size} bytes, over the limit of ${max} bytes${f.inTree ? "" : " (only in history)"}`,
      ),
    };
  } catch (error) {
    return failure(`large-blobs check could not run: ${(error as Error).message}`);
  }
}
