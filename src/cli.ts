#!/usr/bin/env node
/**
 * `repo-truth check --base <rev> --candidate <rev>` - run the registered
 * checks over a range and answer with records.
 *
 * EXIT CODES - the one place they are stated:
 *   0  every check that ran passed or skipped
 *   1  at least one check failed
 *   2  bad invocation or unrunnable environment (unknown option, unknown check,
 *      a revision that names no commit, a failed fetch). Never a check's finding.
 *
 * On exit 2 nothing is written to stdout and no check has run.
 */

import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { allPassed, type CheckRecord } from "./index.js";
import { REGISTRY, type RegistryEntry } from "./registry.js";

export const EXIT_OK = 0;
export const EXIT_CHECK_FAILED = 1;
export const EXIT_BAD_INVOCATION = 2;

export const JSON_SCHEMA_ID = "repo-truth.check/v1";

export interface CliIo {
  readonly cwd?: string;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

const USAGE =
  "usage: repo-truth check --base <rev> --candidate <rev> [--check <name>]... [--format text|json] [--no-fetch]";

class InvocationError extends Error {}

interface Parsed {
  base: string;
  candidate: string;
  checks: string[];
  format: "text" | "json";
  fetch: boolean;
  help: boolean;
}

function parseArgs(argv: readonly string[]): Parsed {
  const [command, ...rest] = argv;
  const parsed: Parsed = { base: "", candidate: "", checks: [], format: "text", fetch: true, help: false };
  if (command === "--help" || command === "-h") {
    parsed.help = true;
    return parsed;
  }
  if (command !== "check") {
    throw new InvocationError(command === undefined ? "no command given" : `unknown command: ${command}`);
  }
  let base: string | undefined;
  let candidate: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    let arg = rest[i] as string;
    let inline: string | undefined;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 0) {
      inline = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const name = arg;
    const value = (): string => {
      if (inline !== undefined) return inline;
      const next = rest[++i];
      if (next === undefined) throw new InvocationError(`${name} needs a value`);
      return next;
    };
    switch (name) {
      case "--base":
        base = value();
        break;
      case "--candidate":
        candidate = value();
        break;
      case "--check":
        parsed.checks.push(value());
        break;
      case "--format": {
        const format = value();
        if (format !== "text" && format !== "json") {
          throw new InvocationError(`unknown format: ${format} (expected text or json)`);
        }
        parsed.format = format;
        break;
      }
      case "--no-fetch":
        parsed.fetch = false;
        break;
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      default:
        throw new InvocationError(`unknown argument: ${name}`);
    }
  }
  if (parsed.help) return parsed;
  if (base === undefined) throw new InvocationError("--base is required");
  if (candidate === undefined) throw new InvocationError("--candidate is required");
  parsed.base = base;
  parsed.candidate = candidate;
  return parsed;
}

function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args as string[],
      { cwd, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
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

async function resolveCommit(cwd: string, label: string, rev: string): Promise<string> {
  const refusal = new InvocationError(`${label} ${JSON.stringify(rev)} does not name a commit in this repository`);
  if (rev.length === 0 || rev.startsWith("-")) throw refusal;
  let id: string;
  try {
    id = (await git(cwd, ["rev-parse", "--verify", "--quiet", rev + "^{commit}"])).trim();
  } catch {
    throw refusal;
  }
  if (id.length === 0) throw refusal;
  return id;
}

async function runOne(
  entry: RegistryEntry,
  cwd: string,
  range: { base: string; candidate: string },
): Promise<CheckRecord> {
  try {
    return await entry.run({ cwd }, range);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name: entry.name, status: "fail", evidence: [`check threw: ${message}`] };
  }
}

function renderText(records: readonly CheckRecord[], ok: boolean): string {
  const lines: string[] = [];
  for (const record of records) {
    lines.push(`${record.status.toUpperCase().padEnd(4)} ${record.name}`);
    for (const line of record.evidence) lines.push(`     ${line}`);
  }
  lines.push(ok ? "repo-truth: all checks passed" : "repo-truth: at least one check failed");
  return lines.join("\n") + "\n";
}

/** Run the command; resolves to the exit code. Output goes through `io`. */
export async function main(argv: readonly string[], io: CliIo = {}): Promise<number> {
  const cwd = io.cwd ?? process.cwd();
  const out = io.stdout ?? ((text: string) => void process.stdout.write(text));
  const err = io.stderr ?? ((text: string) => void process.stderr.write(text));

  try {
    const parsed = parseArgs(argv);
    if (parsed.help) {
      out(USAGE + "\n");
      return EXIT_OK;
    }

    // Read the registry when the command runs: it runs what the registry holds.
    const registry = [...REGISTRY];
    for (const name of parsed.checks) {
      if (!registry.some((e) => e.name === name)) {
        throw new InvocationError(`unknown check: ${name} (registered: ${registry.map((e) => e.name).join(", ")})`);
      }
    }
    const selected = parsed.checks.length === 0 ? registry : registry.filter((e) => parsed.checks.includes(e.name));

    try {
      await git(cwd, ["rev-parse", "--git-dir"]);
    } catch {
      throw new InvocationError(`${cwd} is not a git repository`);
    }
    if (parsed.fetch) {
      try {
        await git(cwd, ["fetch", "--all", "--quiet"]);
      } catch (error) {
        throw new InvocationError(`could not fetch: ${(error as Error).message}`);
      }
    }
    const base = await resolveCommit(cwd, "--base", parsed.base);
    const candidate = await resolveCommit(cwd, "--candidate", parsed.candidate);

    const records: CheckRecord[] = [];
    for (const e of selected) records.push(await runOne(e, cwd, { base, candidate }));

    const ok = allPassed(records);
    const exitCode = ok ? EXIT_OK : EXIT_CHECK_FAILED;
    if (parsed.format === "json") {
      const doc = {
        schema: JSON_SCHEMA_ID,
        base,
        candidate,
        ok,
        exitCode,
        records: records.map((r) => ({ name: r.name, status: r.status, evidence: [...r.evidence] })),
      };
      out(JSON.stringify(doc, null, 2) + "\n");
    } else {
      out(renderText(records, ok));
    }
    return exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    err(`repo-truth: ${message}\n`);
    if (error instanceof InvocationError) err(USAGE + "\n");
    return EXIT_BAD_INVOCATION;
  }
}

function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`repo-truth: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = EXIT_BAD_INVOCATION;
    },
  );
}
