/**
 * The measurement rule.
 *
 * "A number without a command and a date is not a fact." This check reads the
 * bodies of the commits in `base..candidate` and the lines the range adds to
 * changed `.md` files, finds the author's own sentences that assert a
 * measured quantity, and reports the ones whose BLOCK holds no command or no
 * date.
 *
 * A BLOCK is the whole body of one commit (the message without its subject
 * line), or one paragraph of a document - the lines between two blank lines,
 * a fenced block never split. A COMMAND is an inline code span or a fenced
 * block in the block; a DATE is an ISO date in it.
 *
 * A CLAIM is a numeral that carries a unit of measure (`12 ms`, `40%`,
 * `3 files`, `2x`). Digits alone are not a claim: a version, a SHA, an ISO
 * date, a section or figure number, a line reference, or a path containing
 * digits has no unit and is never matched. Lines inside a fenced block, lines
 * beginning with `>`, and text inside an inline code span are not the
 * author's own prose and are never read as claims.
 *
 * Git is always run with an argument vector, and every failure is a `fail`
 * record - never a `pass`, never a throw.
 */

import { execFile } from "node:child_process";

import type { CheckRecord } from "./index.js";

const NAME = "RT-02";

/** Where to look, and which two revisions bound the range. */
export interface MeasurementRuleOptions {
  /** The git repository to run in. */
  readonly cwd: string;
  /** The revision the range starts after. */
  readonly base: string;
  /** The revision the range ends at. */
  readonly candidate: string;
}

function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args as string[],
      { cwd, maxBuffer: 1024 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim();
          reject(new Error(detail.length > 0 ? detail : error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** Units that turn a numeral into a measured quantity. */
const UNITS = [
  "ms", "msec", "msecs", "millisecond", "milliseconds", "s", "sec", "secs", "second", "seconds",
  "min", "mins", "minute", "minutes", "h", "hr", "hrs", "hour", "hours", "days",
  "b", "kb", "mb", "gb", "tb", "kib", "mib", "gib", "byte", "bytes",
  "fps", "rps", "loc", "percent",
  "test", "tests", "case", "cases", "file", "files", "line", "lines", "commit", "commits",
  "failure", "failures", "failing", "passing", "error", "errors", "warning", "warnings",
  "check", "checks", "request", "requests", "call", "calls", "time", "times", "run", "runs",
  "sample", "samples", "iteration", "iterations", "module", "modules", "function", "functions",
  "violation", "violations", "hit", "hits", "match", "matches", "regression", "regressions",
];

/** A numeral not glued to a version, path, reference or identifier, then a unit. */
const CLAIM = new RegExp(
  "(?<![\\w./#:@$-])(\\d[\\d,]*(?:\\.\\d+)?)(?:\\s?%|x(?!\\w)|×|\\s+(?:" +
    UNITS.join("|") +
    ")(?![\\w/-]|\\.\\w))",
  "i",
);

const ISO_DATE = /(?<![\d-])\d{4}-\d{2}-\d{2}(?![\d-])/;
const CODE_SPAN = /(`+)[^`\n]+?\1/;
const CODE_SPAN_ALL = /(`+)[^`\n]+?\1/g;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

interface Line {
  /** 1-based line number inside the text the block came from. */
  readonly number: number;
  readonly text: string;
  /** Inside a fenced block, fence lines included. */
  readonly fenced: boolean;
}

function annotate(source: string): Line[] {
  const lines: Line[] = [];
  let marker: string | undefined;
  source.split("\n").forEach((raw, index) => {
    const text = raw.replace(/\r$/, "");
    const fence = FENCE.exec(text);
    let fenced = marker !== undefined;
    if (marker === undefined) {
      if (fence) {
        marker = fence[1];
        fenced = true;
      }
    } else if (fence?.[1] !== undefined && fence[1][0] === marker[0] && fence[1].length >= marker.length && text.trim() === fence[1]) {
      marker = undefined;
    }
    lines.push({ number: index + 1, text, fenced });
  });
  return lines;
}

/** Split into blocks at blank lines outside fences. */
function paragraphs(lines: readonly Line[]): Line[][] {
  const blocks: Line[][] = [];
  let current: Line[] = [];
  for (const line of lines) {
    if (!line.fenced && line.text.trim() === "") {
      if (current.length > 0) blocks.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

function claimIn(line: Line): string | undefined {
  if (line.fenced || /^\s*>/.test(line.text)) return undefined;
  const prose = line.text
    .replace(CODE_SPAN_ALL, " ")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/https?:\/\/\S+/g, " ");
  return CLAIM.exec(prose)?.[0].trim();
}

function missingHalf(block: readonly Line[]): string | undefined {
  const text = block.map((line) => line.text).join("\n");
  const hasCommand = block.some((line) => line.fenced) || CODE_SPAN.test(text);
  const hasDate = ISO_DATE.test(text);
  if (hasCommand && hasDate) return undefined;
  if (!hasCommand && !hasDate) return "command and date";
  return hasCommand ? "date" : "command";
}

/** Violations in one block; `wanted` limits which lines count as the range's own. */
function violationsIn(
  block: readonly Line[],
  wanted: ((line: Line) => boolean) | undefined,
  where: (line: Line) => string,
): string[] {
  const claims = block
    .filter((line) => (wanted ? wanted(line) : true))
    .flatMap((line) => {
      const figure = claimIn(line);
      return figure === undefined ? [] : [{ line, figure }];
    });
  if (claims.length === 0) return [];
  const missing = missingHalf(block);
  if (missing === undefined) return [];
  return claims.map(({ line, figure }) => `${where(line)}: figure "${figure}" is stated without its ${missing}`);
}

async function commitEvidence(cwd: string, base: string, candidate: string): Promise<string[]> {
  const listing = await runGit(cwd, ["rev-list", "--reverse", `${base}..${candidate}`, "--"]);
  const evidence: string[] = [];
  for (const sha of listing.split("\n").filter((l) => l.length > 0)) {
    const message = (await runGit(cwd, ["show", "-s", "--format=%B", sha])).replace(/\n+$/, "");
    // The body is everything after the subject line; numbering is body-relative.
    const lines = annotate(message.split("\n").slice(1).join("\n"));
    evidence.push(...violationsIn(lines, undefined, (line) => `${sha.slice(0, 7)} body line ${line.number}`));
  }
  return evidence;
}

function addedLines(diff: string): Set<number> {
  const added = new Set<number>();
  for (const match of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    for (let i = 0; i < count; i++) added.add(start + i);
  }
  return added;
}

async function documentEvidence(cwd: string, base: string, candidate: string): Promise<string[]> {
  const span = `${base}...${candidate}`;
  const names = await runGit(cwd, ["diff", "--name-only", "-z", "--diff-filter=d", span, "--"]);
  const evidence: string[] = [];
  for (const path of names.split("\0").filter((n) => n.endsWith(".md"))) {
    const diff = await runGit(cwd, ["diff", "--unified=0", "--no-color", "--no-ext-diff", span, "--", path]);
    const added = addedLines(diff);
    if (added.size === 0) continue;
    const content = await runGit(cwd, ["show", `${candidate}:${path}`]);
    for (const block of paragraphs(annotate(content))) {
      if (!block.some((line) => added.has(line.number))) continue;
      evidence.push(...violationsIn(block, (line) => added.has(line.number), (line) => `${path}:${line.number}`));
    }
  }
  return evidence;
}

async function resolvesToCommit(cwd: string, revision: string): Promise<boolean> {
  if (revision.length === 0 || revision.startsWith("-")) return false;
  try {
    await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check the commit bodies in `base..candidate` and the lines the range adds
 * to `.md` files. Fails closed on any git failure.
 */
export async function checkMeasurementRule(options: MeasurementRuleOptions): Promise<CheckRecord> {
  const { cwd, base, candidate } = options;
  try {
    for (const revision of [base, candidate]) {
      if (!(await resolvesToCommit(cwd, revision))) {
        return { name: NAME, status: "fail", evidence: [`revision ${revision} names no commit`] };
      }
    }
    const evidence = [
      ...(await commitEvidence(cwd, base, candidate)),
      ...(await documentEvidence(cwd, base, candidate)),
    ];
    if (evidence.length > 0) return { name: NAME, status: "fail", evidence };
    return {
      name: NAME,
      status: "pass",
      evidence: [`no unmeasured figure in the commit bodies or added documentation lines of ${base}..${candidate}`],
    };
  } catch (error) {
    return {
      name: NAME,
      status: "fail",
      evidence: [`git failed while reading ${base}..${candidate}: ${(error as Error).message}`],
    };
  }
}
