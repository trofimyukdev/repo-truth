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

/** The repository a check runs in. */
export interface Repository {
  /** The working directory git runs in. */
  readonly cwd: string;
}

/** The range a check answers for, as resolved commit ids. */
export interface ResolvedRange {
  /** The commit the range starts after (exclusive). */
  readonly base: string;
  /** The commit the range ends at (inclusive). */
  readonly candidate: string;
}

export interface RegistryEntry {
  readonly name: string;
  readonly run: (repo: Repository, range: ResolvedRange) => CheckRecord | Promise<CheckRecord>;
}

function entry(
  name: string,
  check: (options: { cwd: string; base: string; candidate: string }) => CheckRecord | Promise<CheckRecord>,
): RegistryEntry {
  return {
    name,
    run: (repo, range) => check({ cwd: repo.cwd, base: range.base, candidate: range.candidate }),
  };
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
  entry("RT-12", checkLargeBlobs),
  entry("RT-14", checkLoweredThresholds),
  entry("RT-16", checkSnapshotRefreshes),
  entry("RT-18", checkDependencySources),
];

type CheckFunction = (options: { cwd: string; base: string; candidate: string }) => CheckRecord | Promise<CheckRecord>;

function failingEntry(file: string, extension: string, cause: string): RegistryEntry {
  const name = "checks/" + file.slice(0, -extension.length);
  const record: CheckRecord = { name, status: "fail", evidence: [file + ": " + cause] };
  return { name, run: () => record };
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
    let mod: { name?: unknown; check?: unknown } = {};
    try {
      mod = ((await import(pathToFileURL(join(path, file)).href)) ?? {}) as typeof mod;
      if (typeof mod.name !== "string" || mod.name === "") problem = "exports no name that is a non-empty string";
      else if (typeof mod.check !== "function") problem = "exports no check that is a function";
      else if (taken.has(mod.name)) problem = "its name " + mod.name + " is already registered";
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
    entries.push(entry(mod.name as string, mod.check as CheckFunction));
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
