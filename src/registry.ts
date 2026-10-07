/**
 * The registry of checks `repo-truth check` runs.
 *
 * This array is data the command reads when it runs; the command holds no list
 * of its own. Adding a check means adding an entry here and nothing else.
 */

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

export const REGISTRY: RegistryEntry[] = [
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
];
