/**
 * Compiler strictness lowered.
 *
 * Reads every tsconfig the range adds, deletes, changes or renames, whole
 * through git, at each end at which the path is a tsconfig, as the compiler
 * reads one (JSON with comments and trailing commas). Reports each strict
 * option that held its strict value at the merge base and does not at the
 * candidate (`strictness-lowered`) and each change of `extends`
 * (`extends-changed`). A file the range adds is compared with nothing; one it
 * deletes is compared with a file that sets nothing. `extends` is not followed.
 * A file that cannot be read at an end at which it is read fails the record.
 *
 * A finding is sanctioned by a `Sanctioned-Weakening: <id> <reason>` line in a
 * commit message of the range or by the caller's `sanctions`. Its id is
 * `<category>:<file>:<option>`; `<category>:<file>` sanctions every finding of
 * that category in that file.
 */

import { execFile } from "node:child_process";

import type { CheckRecord } from "../index.js";
import { SANCTION_KEY } from "../weakened-tests.js";

export const name = "RT-34";

/** An option of `compilerOptions`, its strict value, and whether `strict` sets it by default. */
export interface StrictOption {
  readonly name: string;
  readonly strict: boolean;
  readonly fromStrict: boolean;
}

/** The options the check judges. A consumer appends to it; it is read at every run. */
export const STRICT_OPTIONS: StrictOption[] = [
  { name: "strict", strict: true, fromStrict: false },
  ...[
    "noImplicitAny",
    "strictNullChecks",
    "strictFunctionTypes",
    "strictBindCallApply",
    "strictPropertyInitialization",
    "strictBuiltinIteratorReturn",
    "noImplicitThis",
    "alwaysStrict",
    "useUnknownInCatchVariables",
  ].map((option) => ({ name: option, strict: true, fromStrict: true })),
  ...[
    "noUncheckedIndexedAccess",
    "exactOptionalPropertyTypes",
    "noImplicitOverride",
    "noImplicitReturns",
    "noFallthroughCasesInSwitch",
    "noPropertyAccessFromIndexSignature",
  ].map((option) => ({ name: option, strict: true, fromStrict: false })),
  { name: "skipLibCheck", strict: false, fromStrict: false },
];

export type StrictnessCategory = "strictness-lowered" | "extends-changed";

export interface StrictnessOptions {
  readonly cwd: string;
  readonly base: string;
  readonly candidate: string;
  /** Ids (or `<category>:<file>`) mapped to reasons. */
  readonly sanctions?: Readonly<Record<string, string>> | undefined;
}

export interface StrictnessFinding {
  readonly id: string;
  readonly category: StrictnessCategory;
  readonly file: string;
  /** The option, or `extends`. */
  readonly option: string;
  /** The value at the merge base: a boolean, or the `extends` text. */
  readonly before: boolean | string;
  /** The value at the candidate. */
  readonly after: boolean | string;
  /** The sanction's reason, or `null` while unsanctioned. */
  readonly sanction: string | null;
}

export interface StrictnessRecord extends CheckRecord {
  readonly findings: readonly StrictnessFinding[];
}

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

const quoted = (text: string): string => `"${escapeText(text).replace(/"/g, '\\"')}"`;

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

/** JSON with comments and trailing commas, as the compiler reads a tsconfig. */
export function parseTsconfig(text: string): unknown {
  const out: string[] = [];
  let lastComma = -1; // index in `out` of a comma with only blanks and comments after it
  for (let i = text.startsWith("﻿") ? 1 : 0; i < text.length; i++) {
    const char = text.charAt(i);
    const next = text.charAt(i + 1);
    if (char === '"') {
      let end = i + 1;
      while (end < text.length && text.charAt(end) !== '"') end += text.charAt(end) === "\\" ? 2 : 1;
      out.push(text.slice(i, end + 1));
      i = end;
      lastComma = -1;
    } else if (char === "/" && next === "/") {
      while (i < text.length && text.charAt(i) !== "\n") i++;
      out.push("\n");
    } else if (char === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) throw new Error("unterminated comment");
      i = end + 1;
      out.push(" ");
    } else if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      out.push(char);
    } else {
      if ((char === "}" || char === "]") && lastComma >= 0) out[lastComma] = " ";
      lastComma = char === "," ? out.length : -1;
      out.push(char);
    }
  }
  return JSON.parse(out.join(""));
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A tsconfig at one end: its `compilerOptions` and `extends`, or the reason it cannot be read. */
type Config = { readonly options: Record<string, unknown>; readonly extendsText: string } | { readonly problem: string };

const EMPTY = { options: {}, extendsText: "" };

async function readConfig(cwd: string, mode: string, sha: string): Promise<Config> {
  if (!mode.startsWith("100")) return { problem: "is not a regular file" };
  let parsed: unknown;
  try {
    parsed = parseTsconfig(await runGit(cwd, ["cat-file", "blob", sha]));
  } catch (error) {
    return { problem: `is not JSON: ${(error as Error).message}` };
  }
  if (!isObject(parsed)) return { problem: "is not a JSON object" };
  const options = Object.hasOwn(parsed, "compilerOptions") ? parsed["compilerOptions"] : {};
  if (!isObject(options)) return { problem: "has a compilerOptions that is not an object" };
  const ext = Object.hasOwn(parsed, "extends") ? parsed["extends"] : undefined;
  return { options, extendsText: ext === undefined ? "" : typeof ext === "string" ? ext : JSON.stringify(ext) };
}

/** An option's value in a file: its own boolean, else `strict` for a member, else false. */
function valueOf(options: Record<string, unknown>, option: StrictOption): boolean {
  const own = Object.hasOwn(options, option.name) ? options[option.name] : undefined;
  if (typeof own === "boolean") return own;
  const strict = Object.hasOwn(options, "strict") ? options["strict"] : undefined;
  return option.fromStrict && typeof strict === "boolean" ? strict : false;
}

function isTsconfig(path: string | null): path is string {
  if (path === null) return false;
  const file = path.slice(path.lastIndexOf("/") + 1);
  return file === "tsconfig.json" || file === "jsconfig.json" || (file.startsWith("tsconfig.") && file.endsWith(".json"));
}

type Draft = Omit<StrictnessFinding, "id" | "sanction">;

async function compare(cwd: string, from: string, to: string): Promise<{ drafts: Draft[]; problems: string[] }> {
  const out = await runGit(cwd, ["diff", "--raw", "-z", "--no-abbrev", "--find-renames", "--no-relative", from, to, "--"]);
  const fields = out.split("\0");
  const drafts: Draft[] = [];
  const problems: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const head = fields[i] ?? "";
    if (!head.startsWith(":")) continue;
    const [oldMode = "", newMode = "", oldSha = "", newSha = "", status = ""] = head.slice(1).split(" ");
    const first = fields[++i] ?? "";
    const renamed = status.startsWith("R") || status.startsWith("C");
    const second = renamed ? (fields[++i] ?? "") : first;
    const oldPath = status.startsWith("A") ? null : first;
    const newPath = status.startsWith("D") ? null : second;
    const oldHere = isTsconfig(oldPath);
    const newHere = isTsconfig(newPath);
    if (!oldHere && !newHere) continue;
    const file = newHere ? newPath : (oldPath ?? "");
    const before = oldHere ? await readConfig(cwd, oldMode, oldSha) : undefined;
    const after = newHere ? await readConfig(cwd, newMode, newSha) : undefined;
    if (before !== undefined && "problem" in before) problems.push(`${escapeText(oldPath ?? file)}: at the merge base the file ${escapeText(before.problem)}`);
    if (after !== undefined && "problem" in after) problems.push(`${escapeText(file)}: at the candidate the file ${escapeText(after.problem)}`);
    // Only at the candidate there is nothing to compare with; an unreadable end is already reported.
    if (before === undefined || "problem" in before || (after !== undefined && "problem" in after)) continue;
    const now = after ?? EMPTY;
    if (before.extendsText !== now.extendsText) {
      drafts.push({ category: "extends-changed", file, option: "extends", before: before.extendsText, after: now.extendsText });
    }
    for (const option of STRICT_OPTIONS) {
      const was = valueOf(before.options, option);
      const is = valueOf(now.options, option);
      if (was === option.strict && is !== option.strict) {
        drafts.push({ category: "strictness-lowered", file, option: option.name, before: was, after: is });
      }
    }
  }
  return { drafts, problems };
}

/** The text after the sanction key on every such line of the range's commit messages. */
async function readSanctionLines(cwd: string, from: string, to: string): Promise<string[]> {
  const out = await runGit(cwd, ["log", "--format=%B%x00", `${from}..${to}`, "--"]);
  const prefix = `${SANCTION_KEY}:`;
  return out
    .split(/[\n\0]/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length).trim());
}

function sanctionFor(category: string, file: string, id: string, lines: readonly string[], given: Readonly<Record<string, string>>): string | null {
  for (const key of [id, `${category}:${file}`]) {
    const reason = Object.hasOwn(given, key) ? given[key] : undefined;
    if (typeof reason === "string" && reason.trim().length > 0) return reason.trim();
    for (const line of lines) {
      const rest = line.slice(key.length);
      if (line.startsWith(key) && /^\s+\S/.test(rest)) return rest.trim();
    }
  }
  return null;
}

function describeFinding(finding: StrictnessFinding): string {
  const text =
    finding.category === "extends-changed"
      ? `extends changed ${quoted(String(finding.before))} -> ${quoted(String(finding.after))}`
      : `lowered ${escapeText(finding.option)}: ${String(finding.before)} -> ${String(finding.after)}`;
  const tail = finding.sanction === null ? "" : ` - sanctioned: ${escapeText(finding.sanction)}`;
  return `${escapeText(finding.file)}: ${text}${tail}`;
}

/**
 * Report each strict option `base..candidate` lowers and each change of
 * `extends`. Fails closed: a revision that names no commit, or a git
 * invocation that fails, is a `fail` record naming the cause.
 */
export async function check(options: StrictnessOptions): Promise<StrictnessRecord> {
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
    const { drafts, problems } = await compare(cwd, ancestor, candidateCommit);
    const lines = drafts.length === 0 ? [] : await readSanctionLines(cwd, baseCommit, candidateCommit);
    const findings: StrictnessFinding[] = drafts.map((draft) => {
      const id = `${draft.category}:${draft.file}:${draft.option}`;
      return { id, ...draft, sanction: sanctionFor(draft.category, draft.file, id, lines, options.sanctions ?? {}) };
    });
    if (findings.length === 0 && problems.length === 0) {
      return { name, status: "pass", evidence: ["no strict option lowered"], findings };
    }
    const open = problems.length > 0 || findings.some((finding) => finding.sanction === null);
    return { name, status: open ? "fail" : "pass", evidence: [...problems, ...findings.map(describeFinding)], findings };
  } catch (error) {
    return { name, status: "fail", evidence: [escapeText(error instanceof Error ? error.message : String(error))], findings: [] };
  }
}
