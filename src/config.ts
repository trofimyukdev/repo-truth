/**
 * The configuration file: `repo-truth.json`, read from the base commit through
 * git (never from the working tree or the candidate) or from a file the caller
 * names, and checked against the options each check declares. Every refusal is
 * a `ConfigError` holding one issue per problem.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export const CONFIG_FILE = "repo-truth.json";
export const CONFIG_SCHEMA = "repo-truth.config/v1";

export type OptionKind = "integer" | "boolean" | "string" | "strings";
export const OPTION_KINDS: readonly OptionKind[] = ["integer", "boolean", "string", "strings"];

/** Check name to option name to the kind of that option. */
export type OptionKinds = { readonly [check: string]: { readonly [option: string]: OptionKind } };
export type ConfigOptions = { [check: string]: { [option: string]: unknown } };

/** Everything outside printable ASCII becomes `\u{hex}`, the form the checks already use. */
function escapeText(text: string): string {
  let escaped = "";
  for (const char of text) {
    const codePoint = char.codePointAt(0) as number;
    escaped += codePoint >= 0x20 && codePoint <= 0x7e ? char : `\\u{${codePoint.toString(16).padStart(4, "0")}}`;
  }
  return escaped;
}

export class ConfigError extends Error {
  readonly issues: string[];
  constructor(issues: readonly string[], source?: string) {
    const lines = issues.map((issue) => escapeText(issue));
    const head = `${source === undefined ? "" : `${escapeText(source)}: `}${lines.length} configuration ${lines.length === 1 ? "issue" : "issues"}`;
    super([head, ...lines.map((line) => `  ${line}`)].join("\n"));
    this.name = "ConfigError";
    this.issues = lines;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

function kindProblem(kind: OptionKind, value: unknown): string | null {
  switch (kind) {
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? null : "a non-negative safe integer";
    case "boolean":
      return typeof value === "boolean" ? null : "true or false";
    case "string":
      return typeof value === "string" ? null : "a string";
    case "strings":
      return Array.isArray(value) && value.every((item) => typeof item === "string") ? null : "an array of strings";
  }
}

type Frame = { array: boolean; path: string; names: Set<string>; index: number; wantsName: boolean; member: string };

/**
 * `JSON.parse` keeps the last of two equal member names and says nothing, which
 * is why the repeats are found here, over the tokens of a text already known to
 * be valid JSON. Each repeat is one issue naming its path.
 */
function repeatedNames(text: string): string[] {
  const repeats: string[] = [];
  const stack: Frame[] = [];
  for (const [token] of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\],:]|[^\s{}[\],:"]+/g)) {
    const top = stack[stack.length - 1];
    if (token === "{" || token === "[") {
      let path = "";
      if (top !== undefined) path = top.array ? `${top.path}[${top.index}]` : top.member;
      stack.push({ array: token === "[", path, names: new Set(), index: 0, wantsName: true, member: "" });
    } else if (token === "}" || token === "]") {
      stack.pop();
    } else if (token === ",") {
      if (top !== undefined) {
        top.index += 1;
        top.wantsName = true;
      }
    } else if (token === ":") {
      if (top !== undefined) top.wantsName = false;
    } else if (top !== undefined && !top.array && top.wantsName) {
      const name = JSON.parse(token) as string;
      top.member = top.path === "" ? name : `${top.path}.${name}`;
      if (top.names.has(name)) repeats.push(`${top.member}: given more than once`);
      top.names.add(name);
    }
  }
  return repeats;
}

/** Reads `text` as a configuration document; throws a `ConfigError` naming every problem. */
export function parseConfig(text: string, kinds: OptionKinds): ConfigOptions {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new ConfigError([`the document: not valid JSON (${error instanceof Error ? error.message : String(error)})`]);
  }
  if (!isObject(document)) throw new ConfigError([`the document: expected a JSON object, found ${describe(document)}`]);

  const issues: string[] = repeatedNames(text);
  const options: ConfigOptions = {};
  if (!own(document, "schema")) issues.push(`schema: required, must be "${CONFIG_SCHEMA}"`);
  for (const key of Object.keys(document)) {
    const value = document[key];
    if (key === "schema") {
      if (value !== CONFIG_SCHEMA) issues.push(`schema: expected "${CONFIG_SCHEMA}", found ${JSON.stringify(value)}`);
    } else if (key === "checks") {
      if (!isObject(value)) {
        issues.push(`checks: expected an object, found ${describe(value)}`);
        continue;
      }
      for (const check of Object.keys(value)) {
        const given = value[check];
        if (!own(kinds, check)) {
          issues.push(`checks.${check}: unknown check`);
        } else if (!isObject(given)) {
          issues.push(`checks.${check}: expected an object, found ${describe(given)}`);
        } else {
          const declared = kinds[check] as { readonly [option: string]: OptionKind };
          const chosen: { [option: string]: unknown } = {};
          for (const option of Object.keys(given)) {
            const path = `checks.${check}.${option}`;
            if (!own(declared, option)) {
              issues.push(`${path}: unknown option of ${check}`);
              continue;
            }
            const expected = kindProblem(declared[option] as OptionKind, given[option]);
            if (expected === null) chosen[option] = given[option];
            else issues.push(`${path}: expected ${expected}, found ${JSON.stringify(given[option])}`);
          }
          options[check] = chosen;
        }
      }
    } else {
      issues.push(`${key}: unknown key, only schema and checks are allowed`);
    }
  }
  if (issues.length > 0) throw new ConfigError(issues);
  return options;
}

type GitResult = { code: number; stdout: string; stderr: string };

function git(cwd: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((done, fail) => {
    execFile("git", args as string[], { cwd, maxBuffer: 1024 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error === null) return done({ code: 0, stdout, stderr });
      const code = (error as { code?: unknown }).code;
      if (typeof code === "number") return done({ code, stdout, stderr });
      fail(new ConfigError([`git could not be run: ${error.message}`]));
    });
  });
}

function failed(args: readonly string[], result: GitResult): ConfigError {
  return new ConfigError([`git ${args[0]} failed (exit ${result.code}): ${result.stderr.trim() || "no message"}`]);
}

function parseFrom(text: string, kinds: OptionKinds, source: string): ConfigOptions {
  try {
    return parseConfig(text, kinds);
  } catch (error) {
    if (error instanceof ConfigError) throw new ConfigError(error.issues, source);
    throw error;
  }
}

/**
 * With no `path`, the settings are repo-truth.json at the top directory of the
 * base commit, whatever directory of the repository `cwd` is in; a
 * subdirectory's repo-truth.json is never read. A `path` is read as given, a
 * relative one against `cwd`.
 */
export async function readConfig(
  options: { cwd: string; base: string; path?: string },
  kinds: OptionKinds,
): Promise<{ source: string | null; options: ConfigOptions }> {
  try {
    const { cwd, base, path } = options;
    if (path !== undefined) {
      let text: string;
      try {
        text = await readFile(isAbsolute(path) ? path : resolve(cwd, path), "utf8");
      } catch (error) {
        throw new ConfigError([`${path}: cannot read the configuration file (${error instanceof Error ? error.message : String(error)})`]);
      }
      return { source: path, options: parseFrom(text, kinds, path) };
    }

    const revParse = ["rev-parse", "--verify", "--quiet", "--end-of-options", `${base}^{commit}`];
    const resolved = await git(cwd, revParse);
    if (resolved.code === 1 && resolved.stderr.trim() === "") throw new ConfigError([`revision ${base}: names no commit`]);
    if (resolved.code !== 0) throw failed(revParse, resolved);
    const commit = resolved.stdout.trim();

    const lsTree = ["ls-tree", "-z", "--full-tree", commit, "--", CONFIG_FILE];
    const listing = await git(cwd, lsTree);
    if (listing.code !== 0) throw failed(lsTree, listing);
    const entry = listing.stdout.split("\0")[0] as string;
    if (entry === "") return { source: null, options: {} };
    const short = commit.slice(0, 12);
    const match = /^(\d+) (\w+) ([0-9a-f]+)\t/.exec(entry);
    if (match === null) throw new ConfigError([`${CONFIG_FILE}: unreadable tree entry at ${short}`]);
    if (match[1] !== "100644" && match[1] !== "100755") {
      throw new ConfigError([`${CONFIG_FILE}: expected a regular file, found a ${match[2]} (mode ${match[1]}) at ${short}`]);
    }
    const catFile = ["cat-file", "blob", match[3] as string];
    const blob = await git(cwd, catFile);
    if (blob.code !== 0) throw failed(catFile, blob);
    const source = `${CONFIG_FILE} at ${short}`;
    return { source, options: parseFrom(blob.stdout, kinds, source) };
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError([`unexpected failure: ${error instanceof Error ? error.message : String(error)}`]);
  }
}
