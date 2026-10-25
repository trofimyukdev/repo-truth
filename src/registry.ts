/**
 * The registry of checks `repo-truth check` runs.
 *
 * This array is data the command reads when it runs; the command holds no list
 * of its own. Adding a check means adding an entry here and nothing else.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CheckRecord } from "./index.js";
import { OPTION_KINDS } from "./config.js";
import type { OptionKind, OptionKinds } from "./config.js";
import { checkCommitRange } from "./commit-range.js";
import { checkMeasurementRule } from "./measurement-rule.js";
import { checkTrailers } from "./trailers.js";
import { checkWeakenedTests } from "./weakened-tests.js";
import { checkStrayFiles } from "./stray-files.js";
import { checkLockfileDrift } from "./lockfile-drift.js";
import { checkConflictMarkers } from "./conflict-markers.js";
import { checkPortablePaths } from "./portable-paths.js";
import { checkSymlinks } from "./symlinks.js";
import { checkLargeBlobs } from "./large-blobs.js";
import { checkLoweredThresholds } from "./lowered-thresholds.js";
import { checkSnapshotRefreshes } from "./snapshot-refreshes.js";
import { checkDependencySources } from "./dependency-sources.js";
import { checkReplayedFigures } from "./replayed-figures.js";

/** The repository a check runs in. */
export interface Repository {
  /** The working directory git runs in. */
  readonly cwd: string;
  /** The path --config named, as it was given; absent when the settings were read from repo-truth.json at the base. */
  readonly config?: string;
}

/** The range a check answers for, as resolved commit ids. */
export interface ResolvedRange {
  /** The commit the range starts after (exclusive). */
  readonly base: string;
  /** The commit the range ends at (inclusive). */
  readonly candidate: string;
}

/** The options a check takes, from the name of each to its kind. */
export type EntryOptions = { readonly [option: string]: OptionKind };

export interface RegistryEntry {
  readonly name: string;
  /** The options the check takes; absent on an entry written by hand that takes none. */
  readonly options?: EntryOptions;
  readonly run: (
    repo: Repository,
    range: ResolvedRange,
    options?: { readonly [option: string]: unknown },
  ) => CheckRecord | Promise<CheckRecord>;
}

type CheckFunction = (options: { cwd: string; base: string; candidate: string; config?: string }) => CheckRecord | Promise<CheckRecord>;

function entry(name: string, check: CheckFunction, declared: EntryOptions = {}): RegistryEntry {
  const options: EntryOptions = Object.fromEntries(Object.entries(declared));
  return {
    name,
    options,
    run: (repo, range, given) => {
      const handed: { [option: string]: unknown } = {};
      if (typeof given === "object" && given !== null) {
        for (const option of Object.keys(options)) {
          if (Object.hasOwn(given, option)) handed[option] = given[option];
        }
      }
      delete handed.config;
      if (repo.config !== undefined) handed.config = repo.config;
      return check(
        Object.assign(handed, { cwd: repo.cwd, base: range.base, candidate: range.candidate }) as Parameters<CheckFunction>[0],
      );
    },
  };
}

const RESERVED_OPTIONS = ["cwd", "base", "candidate", "sanctions", "config"];

/** What is wrong with a module's optionKinds, or undefined when it is valid. */
function optionKindsProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "its optionKinds is not a plain object";
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return "its optionKinds is not a plain object";
  for (const [option, kind] of Object.entries(value)) {
    if (RESERVED_OPTIONS.includes(option)) return "its optionKinds declares the option " + option + ", which is not its to declare";
    if (typeof kind !== "string" || !(OPTION_KINDS as readonly string[]).includes(kind)) {
      return "its optionKinds gives the option " + option + " a kind that is none of " + OPTION_KINDS.join(", ");
    }
  }
  return undefined;
}

/** The options of every entry given, by entry name, in the form parseConfig reads. */
export function optionKindsOf(entries: readonly RegistryEntry[]): OptionKinds {
  return Object.fromEntries(entries.map((e) => [e.name, Object.fromEntries(Object.entries(e.options ?? {}))]));
}

const OWN_ENTRIES: RegistryEntry[] = [
  entry("RT-01", checkCommitRange),
  entry("RT-02", checkMeasurementRule),
  entry("RT-03", checkTrailers),
  entry("RT-04", checkWeakenedTests),
  entry("RT-05", checkStrayFiles),
  entry("RT-06", checkLockfileDrift),
  entry("RT-09", checkConflictMarkers),
  entry("RT-10", checkPortablePaths),
  entry("RT-11", checkSymlinks),
  entry("RT-12", checkLargeBlobs, { maxBytes: "integer" }),
  entry("RT-14", checkLoweredThresholds),
  entry("RT-16", checkSnapshotRefreshes),
  entry("RT-18", checkDependencySources, { registries: "strings" }),
  entry("RT-19", checkReplayedFigures, { timeoutMs: "integer" }),
];

function failingEntry(file: string, extension: string, cause: string): RegistryEntry {
  const name = "checks/" + file.slice(0, -extension.length);
  const record: CheckRecord = { name, status: "fail", evidence: [file + ": " + cause] };
  return { name, options: {}, run: () => record };
}

function isModuleFile(file: string, extension: string): boolean {
  return (
    file.endsWith(extension) &&
    !file.endsWith(".d.ts") &&
    !file.includes(".test.") &&
    !file.includes(".spec.")
  );
}

/**
 * The entries for the check modules directly in one directory, in the order of
 * their file names. A module that cannot be registered becomes an entry whose
 * record fails and names the file and the cause. A missing directory yields none.
 */
export async function loadCheckDirectory(directory: URL, extension: string): Promise<RegistryEntry[]> {
  const path = fileURLToPath(directory);
  let dirents;
  try {
    dirents = await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = dirents
    .filter((d) => d.isFile() && isModuleFile(d.name, extension))
    .map((d) => d.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const entries: RegistryEntry[] = [];
  const taken = new Set<string>(OWN_ENTRIES.map((e) => e.name));
  for (const file of files) {
    let problem: string | undefined;
    let mod: { name?: unknown; check?: unknown; optionKinds?: unknown } = {};
    try {
      mod = ((await import(pathToFileURL(join(path, file)).href)) ?? {}) as typeof mod;
      if (typeof mod.name !== "string" || mod.name === "") problem = "exports no name that is a non-empty string";
      else if (typeof mod.check !== "function") problem = "exports no check that is a function";
      else if (taken.has(mod.name)) problem = "its name " + mod.name + " is already registered";
      else if ("optionKinds" in mod) problem = optionKindsProblem(mod.optionKinds);
    } catch (error) {
      problem = "could not be loaded: " + (error instanceof Error ? error.message : String(error));
    }
    if (problem !== undefined) {
      const failed = failingEntry(file, extension, problem);
      taken.add(failed.name);
      entries.push(failed);
      continue;
    }
    taken.add(mod.name as string);
    entries.push(entry(mod.name as string, mod.check as CheckFunction, mod.optionKinds as EntryOptions | undefined));
  }
  return entries;
}

export const REGISTRY: RegistryEntry[] = [...OWN_ENTRIES];

REGISTRY.push(
  ...(await loadCheckDirectory(
    new URL("checks/", import.meta.url),
    import.meta.url.endsWith(".ts") ? ".ts" : ".js",
  )),
);
