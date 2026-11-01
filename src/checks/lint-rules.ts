/**
 * Lint rules turned off.
 *
 * A lint run goes green as surely when a rule is turned off in the lint
 * configuration as when the code is fixed. This check reads every path the range
 * adds, changes or renames onto whose last path segment is exactly one of
 * `LINT_FILES` (`.eslintrc*`, `eslint.config.*`, `biome.json`, `biome.jsonc`,
 * `.oxlintrc.json`), at any depth, whole and through git at the merge base of
 * `base` and `candidate` and at `candidate`, renames detected. The working tree
 * is never read, and no file is parsed or run.
 *
 * An off pair is, in a file's text, a rule name, white space or none, a colon,
 * white space or none, then an off value (`"off"`, `'off'`, `off` or `0`, or
 * `[` and white space before one of them), the value not followed by a letter, a
 * digit, `_` or `.`. A name is written in double quotes, in single quotes or
 * bare. A pair is counted wherever it stands, a comment included. For each file,
 * each name's pairs are counted at the candidate and in the source file (the
 * file at the merge base, the one a rename came from, or none for a file the
 * range adds); a name counted more often at the candidate is one finding
 * `rule-off`, whatever the count. A rule moved or a line re-indented says
 * nothing; a rule changed from `error` or `warn` to `off` is a finding.
 *
 * Each finding is the evidence line `<file>: rule-off <name>`. A finding's id is
 * `rule-off:<file>`, which sanctions every finding of that file by a
 * `Sanctioned-Weakening: <id> <reason>` line in a commit message of the range or
 * by the caller's `sanctions`; the evidence line then ends ` - sanctioned:
 * <reason>`.
 *
 * What it does not see: a rule set to `warn`, a rule deleted, a rule turned off
 * by a configuration named in `extends`, `package.json`'s `eslintConfig`, ignore
 * patterns, biome's `"recommended": false` and `"enabled": false`, and other
 * linters' files.
 */

import { execFile } from "node:child_process";

import type { CheckRecord } from "../index.js";
import { SANCTION_KEY } from "../weakened-tests.js";

export const name = "RT-92";

const LINT_FILES: ReadonlySet<string> = new Set([
  ".eslintrc",
  ".eslintrc.json",
  ".eslintrc.yml",
  ".eslintrc.yaml",
  ".eslintrc.js",
  ".eslintrc.cjs",
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  "eslint.config.mts",
  "eslint.config.cts",
  "biome.json",
  "biome.jsonc",
  ".oxlintrc.json",
]);

export interface LintRulesOptions {
  readonly cwd: string;
  readonly base: string;
  readonly candidate: string;
  /** Ids (`rule-off:<file>`) mapped to reasons. */
  readonly sanctions?: Readonly<Record<string, string>> | undefined;
}

const OFF_PAIR = new RegExp(
  String.raw`(?:"([^"]*)"|'([^']*)'|([A-Za-z@_$][A-Za-z0-9@/\-_.$]*))\s*:\s*(?:\[\s*)?(?:"off"|'off'|off|0)(?![A-Za-z0-9_.])`,
  "g",
);

function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args as string[], { cwd, maxBuffer: 1024 * 1024 * 1024, encoding: "buffer" }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.toString("utf8").trim() || error.message));
      else resolve(stdout.toString("utf8"));
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

const isLintPath = (path: string): boolean => LINT_FILES.has(path.slice(path.lastIndexOf("/") + 1));
const isNull = (sha: string): boolean => /^0+$/.test(sha);

/** A blob read whole through git; an absent blob is an empty file. */
const readBlob = async (cwd: string, sha: string): Promise<string> =>
  isNull(sha) ? "" : runGit(cwd, ["cat-file", "blob", sha]);

/** How many off pairs each rule name has in a file's text. */
function countOffPairs(content: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of content.matchAll(OFF_PAIR)) {
    const rule = match[1] ?? match[2] ?? match[3] ?? "";
    counts.set(rule, (counts.get(rule) ?? 0) + 1);
  }
  return counts;
}

interface Draft {
  readonly file: string;
  readonly rule: string;
}

async function compare(cwd: string, from: string, to: string): Promise<Draft[]> {
  const out = await runGit(cwd, ["diff", "--raw", "-z", "-M", "--no-abbrev", "--no-ext-diff", "--no-relative", from, to, "--"]);
  const fields = out.split("\0");
  const drafts: Draft[] = [];
  for (let i = 0; i < fields.length; i++) {
    const head = fields[i] ?? "";
    if (!head.startsWith(":")) continue;
    const [, , oldSha = "", newSha = "", status = ""] = head.slice(1).split(" ");
    const renamed = status.startsWith("R") || status.startsWith("C");
    i++;
    const newPath = renamed ? (fields[++i] ?? "") : (fields[i] ?? "");
    const letter = status.charAt(0);
    if (!["A", "M", "R", "C", "T"].includes(letter) || !isLintPath(newPath)) continue;
    const before = countOffPairs(letter === "A" ? "" : await readBlob(cwd, oldSha));
    const after = countOffPairs(await readBlob(cwd, newSha));
    for (const [rule, count] of after) {
      if (count > (before.get(rule) ?? 0)) drafts.push({ file: newPath, rule });
    }
  }
  return drafts;
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

function sanctionFor(id: string, lines: readonly string[], given: Readonly<Record<string, string>>): string | null {
  const reason = Object.hasOwn(given, id) ? given[id] : undefined;
  if (typeof reason === "string" && reason.trim().length > 0) return reason.trim();
  for (const line of lines) {
    const rest = line.slice(id.length);
    if (line.startsWith(id) && /^\s+\S/.test(rest)) return rest.trim();
  }
  return null;
}

/**
 * Report each rule `base..candidate` turns off in a lint configuration file.
 * Fails while any finding is unsanctioned, and fails closed: a revision that
 * names no commit, or any git invocation that fails, is a `fail` record naming
 * the cause - never a `pass`, never a throw.
 */
export async function check(options: LintRulesOptions): Promise<CheckRecord> {
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
    const drafts = await compare(cwd, ancestor, candidateCommit);
    if (drafts.length === 0) return { name, status: "pass", evidence: ["no lint rule turned off"] };
    const lines = await readSanctionLines(cwd, ancestor, candidateCommit);
    let open = false;
    const evidence = drafts.map((draft) => {
      const reason = sanctionFor(`rule-off:${draft.file}`, lines, options.sanctions ?? {});
      if (reason === null) open = true;
      const tail = reason === null ? "" : ` - sanctioned: ${escapeText(reason)}`;
      return `${escapeText(draft.file)}: rule-off ${escapeText(draft.rule)}${tail}`;
    });
    return { name, status: open ? "fail" : "pass", evidence };
  } catch (error) {
    return { name, status: "fail", evidence: [escapeText(error instanceof Error ? error.message : String(error))] };
  }
}
