/**
 * Credentials.
 *
 * A credential committed once is published to every clone for good. This check
 * reads the lines `base..candidate` adds, in every file git can read as text,
 * and reports each line that holds a credential in a form only a real one has:
 * the file, the line and the kind - never the text it matched, because a report
 * that prints a credential has published it a second time. A credential the
 * base already holds, a line the range removes and a binary file say nothing.
 * There is no sanction: remove the credential and revoke it.
 *
 * The forms live in the exported `CREDENTIAL_SHAPES`, read each time the check
 * runs: a consumer appends its own entry. They are regular expressions only.
 */

import { execFile } from "node:child_process";

import type { CheckRecord } from "../index.js";

export const name = "RT-26";

/** One form of credential. */
export interface CredentialShape {
  /** The kind a finding names. */
  readonly name: string;
  /** Tested against each line the range adds. */
  readonly pattern: RegExp;
}

export interface CredentialsOptions {
  readonly cwd: string;
  readonly base: string;
  readonly candidate: string;
}

export const CREDENTIAL_SHAPES: CredentialShape[] = [
  { name: "private key", pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/ },
  { name: "cloud access key id", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { name: "code host token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/ },
  { name: "chat token", pattern: /xox[abposr]-[A-Za-z0-9-]{10,}/ },
  {
    name: "assigned secret",
    pattern: /(?:api_key|api-key|apikey|secret_key|access_token|auth_token|oauth_token|password)["']?\s*[:=]\s*(?:"[^"'\s]{20,}"|'[^"'\s]{20,}')/i,
  },
];

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

async function resolveCommit(cwd: string, revision: string): Promise<string> {
  const fail = (cause: string): Error => new Error(`revision "${escapeText(String(revision))}" does not name a commit${cause}`);
  // A revision that begins with a dash would be read as an option.
  if (typeof revision !== "string" || revision.length === 0 || revision.startsWith("-")) throw fail("");
  let hash = "";
  try {
    hash = (await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`])).trim();
  } catch (error) {
    throw fail(`: ${(error as Error).message}`);
  }
  if (hash.length === 0) throw fail("");
  return hash;
}

interface Line {
  readonly number: number;
  readonly text: string;
}

/** The lines a change adds to a file; a missing old side (`null`) means every line is added. */
async function addedLines(cwd: string, oldBlob: string | null, newBlob: string): Promise<Line[]> {
  const text = await runGit(cwd, ["cat-file", "blob", newBlob]);
  if (text.includes("\0")) return [];
  const all = (): Line[] => text.replace(/\n$/, "").split("\n").map((t, i) => ({ number: i + 1, text: t.replace(/\r$/, "") }));
  if (oldBlob === null) return all();
  const out = await runGit(cwd, ["diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", oldBlob, newBlob]);
  const added: Line[] = [];
  let newLine = 0;
  let inHunk = false;
  for (const raw of out.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk !== null) {
      newLine = Number(hunk[1]);
      inHunk = true;
    } else if (inHunk && raw.startsWith("+")) added.push({ number: newLine++, text: raw.slice(1).replace(/\r$/, "") });
  }
  return added;
}

async function findings(cwd: string, from: string, to: string): Promise<string[]> {
  const out = await runGit(cwd, ["diff", "--raw", "-z", "--no-abbrev", "--find-renames", "--no-relative", from, to, "--"]);
  const fields = out.split("\0");
  const shapes = CREDENTIAL_SHAPES.map((shape) => ({
    name: shape.name,
    pattern: new RegExp(shape.pattern.source, shape.pattern.flags.replace(/[gy]/g, "")),
  }));
  const lines: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const head = fields[i] ?? "";
    if (!head.startsWith(":")) continue;
    const [oldMode = "", newMode = "", oldSha = "", newSha = "", status = ""] = head.slice(1).split(" ");
    const first = fields[++i] ?? "";
    const path = status.startsWith("R") || status.startsWith("C") ? (fields[++i] ?? "") : first;
    if (status.startsWith("D") || !newMode.startsWith("100")) continue;
    const oldBlob = status.startsWith("A") || !oldMode.startsWith("100") ? null : oldSha;
    for (const line of await addedLines(cwd, oldBlob, newSha)) {
      for (const shape of shapes) {
        if (shape.pattern.test(line.text)) lines.push(`${escapeText(path)}:${line.number}: ${escapeText(shape.name)}`);
      }
    }
  }
  return lines;
}

/**
 * Report each credential-shaped line `base..candidate` adds. Fails closed: a
 * revision that names no commit, or any git invocation that fails, is a `fail`
 * record naming the cause - never a `pass`, and never a thrown error.
 */
export async function check(options: CredentialsOptions): Promise<CheckRecord> {
  try {
    const { cwd, base, candidate } = options;
    const baseCommit = await resolveCommit(cwd, base);
    const candidateCommit = await resolveCommit(cwd, candidate);
    let ancestor: string;
    try {
      ancestor = (await runGit(cwd, ["merge-base", baseCommit, candidateCommit])).trim();
    } catch (error) {
      throw new Error(`no merge base of "${escapeText(base)}" and "${escapeText(candidate)}": ${(error as Error).message}`);
    }
    const found = await findings(cwd, ancestor, candidateCommit);
    if (found.length === 0) return { name, status: "pass", evidence: ["no credential in the lines the range adds"] };
    return { name, status: "fail", evidence: found };
  } catch (error) {
    return { name, status: "fail", evidence: [escapeText(error instanceof Error ? error.message : String(error))] };
  }
}
