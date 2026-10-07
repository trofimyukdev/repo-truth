/**
 * Dependency sources.
 *
 * A dependency names where it comes from as well as which version. This check
 * reads what the range adds or changes in the root manifest's dependency
 * fields, `overrides` and `resolutions`, and the resolved URLs on the lines the
 * range adds to the root lockfiles, and reports each dependency that does not
 * come from a registry, with the rule it breaks: [git], [url], [path], [alias]
 * or [registry]. A specifier the base already held is never judged. Lockfiles
 * are read as the range adds their lines and never parsed whole.
 */

import { execFile } from "node:child_process";

import type { CheckRecord } from "./index.js";
import { DEPENDENCY_FIELDS } from "./lockfile-drift.js";

const NAME = "RT-18";
const MANIFEST = "package.json";

/** The hosts a lockfile may resolve from when the caller gives none. */
export const DEFAULT_REGISTRIES: string[] = ["registry.npmjs.org", "registry.yarnpkg.com"];

/** Where to look, and which two revisions bound the range. */
export interface DependencySourcesOptions {
  /** The git repository to run in. */
  readonly cwd: string;
  /** The revision the range starts after. */
  readonly base: string;
  /** The revision the range ends at. */
  readonly candidate: string;
  /** The hosts a lockfile may resolve from; replaces `DEFAULT_REGISTRIES`. */
  readonly registries?: readonly string[];
}

const JSON_LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json"];
const YARN_LOCKFILE = "yarn.lock";

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

/** The text of a root file at a commit, or undefined when the commit has no such file. */
async function readFileAt(root: string, commit: string, path: string): Promise<string | undefined> {
  const out = (await runGit(root, ["ls-tree", "-z", commit, "--", path])).toString("utf8");
  const entry = out.split("\0")[0] ?? "";
  const match = /^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/s.exec(entry);
  if (match === null || match[4] !== path || match[2] !== "blob") {
    return undefined;
  }
  return (await runGit(root, ["cat-file", "blob", match[3] as string])).toString("utf8");
}

/** One dependency the manifest names: where it sits, and what it asks for. */
interface Declared {
  readonly field: string;
  readonly chain: string[];
  readonly specifier: string;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function walk(node: Record<string, unknown>, field: string, chain: string[], out: Declared[]): void {
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (typeof value === "string") {
      out.push({ field, chain: key === "." ? chain : [...chain, key], specifier: value });
    } else if (isMapping(value)) {
      walk(value, field, [...chain, key], out);
    }
  }
}

function declaredIn(text: string, label: string): Declared[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${MANIFEST} at ${label} is not valid JSON: ${(error as Error).message}`);
  }
  if (!isMapping(parsed)) {
    throw new Error(`${MANIFEST} at ${label} is not a JSON object`);
  }
  const out: Declared[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const value = Object.prototype.hasOwnProperty.call(parsed, field) ? parsed[field] : undefined;
    if (isMapping(value)) {
      for (const key of Object.keys(value)) {
        const specifier = value[key];
        if (typeof specifier === "string") {
          out.push({ field, chain: [key], specifier });
        }
      }
    }
  }
  for (const field of ["overrides", "resolutions"]) {
    const value = Object.prototype.hasOwnProperty.call(parsed, field) ? parsed[field] : undefined;
    if (isMapping(value)) {
      walk(value, field, [], out);
    }
  }
  return out;
}

/** The package a dependency key stands for: a path of packages, optionally scoped, optionally with a version. */
function packageName(key: string): string {
  let name = key;
  const at = name.lastIndexOf("@");
  if (at > 0) {
    name = name.slice(0, at);
  }
  const match = /(@[^/]+\/[^/]+|[^/]+)$/.exec(name);
  return match === null ? name : (match[1] as string);
}

const PATH_FORM = /^(file:|link:|portal:|\.\/|\.\.\/|\/|~\/)/;
const GIT_PREFIX = /^(git\+|git:|github:|gitlab:|bitbucket:|gist:)/;
const GIT_SHORTHAND = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(#.*)?$/;

/** The rule a specifier breaks, or undefined when it is an ordinary one. */
function classify(name: string, specifier: string): string | undefined {
  const spec = specifier.trim();
  if (PATH_FORM.test(spec)) return "path";
  if (GIT_PREFIX.test(spec) || GIT_SHORTHAND.test(spec)) return "git";
  if (/^https?:/.test(spec)) return "url";
  if (spec.startsWith("npm:")) {
    const rest = spec.slice(4);
    const at = rest.lastIndexOf("@");
    const target = at > 0 ? rest.slice(0, at) : rest;
    return target === name ? undefined : "alias";
  }
  return undefined;
}

function hostOf(url: string): string | undefined {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.length > 0 ? host : undefined;
  } catch {
    return undefined;
  }
}

/** The lines a range adds to a root file, as [line in candidate, text]. */
async function addedLines(root: string, ancestor: string, candidate: string, path: string): Promise<[number, string][]> {
  const out = (
    await runGit(root, [
      "-c",
      "core.quotepath=off",
      "diff",
      "--no-ext-diff",
      "--no-color",
      "--no-renames",
      "--unified=0",
      ancestor,
      candidate,
      "--",
      `:(literal)${path}`,
    ])
  ).toString("utf8");
  const added: [number, string][] = [];
  let line = 0;
  let inHunk = false;
  for (const text of out.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (header !== null) {
      line = Number(header[1]);
      inHunk = true;
    } else if (inHunk && text.startsWith("+")) {
      added.push([line, text.slice(1).replace(/\r$/, "")]);
      line += 1;
    }
  }
  return added;
}

/**
 * Report each dependency the range adds or changes that does not come from a
 * registry. Fails closed: a manifest that does not parse, a revision that names
 * no commit, or any git invocation that fails is a `fail` record naming the
 * cause - never a `pass`, and never a thrown error.
 */
export async function checkDependencySources(options: DependencySourcesOptions): Promise<CheckRecord> {
  try {
    const { cwd, base, candidate } = options;
    const registries = (options.registries ?? DEFAULT_REGISTRIES).map((host) => host.toLowerCase());
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

    const before = await readFileAt(root, ancestor, MANIFEST);
    const after = await readFileAt(root, candidateCommit, MANIFEST);
    const declaredBefore = before === undefined ? [] : declaredIn(before, quote(base));
    const declaredAfter = after === undefined ? [] : declaredIn(after, quote(candidate));

    const findings: string[] = [];
    const held = new Set(declaredBefore.map((d) => JSON.stringify([d.field, d.chain, d.specifier])));
    for (const dep of declaredAfter) {
      if (held.has(JSON.stringify([dep.field, dep.chain, dep.specifier]))) continue;
      const rule = classify(packageName(dep.chain[dep.chain.length - 1] ?? ""), dep.specifier);
      if (rule !== undefined) {
        findings.push(`${MANIFEST} ${dep.field} ${quote(dep.chain.join(" > "))} ${quote(dep.specifier)} [${rule}]`);
      }
    }

    let lockLines = 0;
    for (const file of [...JSON_LOCKFILES, YARN_LOCKFILE]) {
      const lines = await addedLines(root, ancestor, candidateCommit, file);
      lockLines += lines.length;
      for (const [number, text] of lines) {
        const match =
          file === YARN_LOCKFILE
            ? /^\s*"?resolved"?[\s:]+"?([^"\s]+)"?/.exec(text)
            : /"resolved"\s*:\s*"([^"]*)"/.exec(text);
        if (match === null) continue;
        const host = hostOf(match[1] as string);
        if (host === undefined || !registries.includes(host)) {
          findings.push(`${file} line ${number} host ${quote(host ?? `unparseable ${match[1] as string}`)} [registry]`);
        }
      }
    }

    if (before === undefined && after === undefined && lockLines === 0) {
      return {
        name: NAME,
        status: "skip",
        evidence: [`no ${MANIFEST} found in ${quote(base)}..${quote(candidate)} and no lockfile line added`],
      };
    }
    if (findings.length > 0) {
      return { name: NAME, status: "fail", evidence: findings };
    }
    return { name: NAME, status: "pass", evidence: ["no dependency from outside the registry"] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name: NAME, status: "fail", evidence: [escapeText(message)] };
  }
}
