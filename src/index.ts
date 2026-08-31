/**
 * repo-truth - the shape every check in this package answers in.
 *
 * Nothing here decides anything yet. What this module fixes is the RESULT
 * TYPE, because that is the half a caller depends on and the half that is
 * expensive to change once six checks have their own version of it. A check
 * returns a record; a gate reads records; neither side reads a process exit
 * code or a line of prose.
 *
 * The checks themselves arrive one task at a time - see `factory/tasks/`.
 */

/** What a check concluded. */
export type CheckStatus = "pass" | "fail" | "skip";

/**
 * One machine-readable answer.
 *
 * `evidence` is a list rather than a string because a failure that names one
 * offending commit and a failure that names forty are the same kind of answer,
 * and a caller that has to split a paragraph to tell them apart is a caller
 * that will get it wrong. A passing check MAY carry evidence - what it looked
 * at is worth printing - and an empty list is not a defect.
 */
export interface CheckRecord {
  /** Stable identifier, matching the check's task id in `factory/tasks/`. */
  readonly name: string;
  readonly status: CheckStatus;
  /** Human-readable lines naming what was found, or what was looked at. */
  readonly evidence: readonly string[];
}

/**
 * The one check that exists, and it checks the package's own premise: that a
 * check is a record and not an exit code.
 *
 * It is a placeholder in what it MEASURES and not in what it RETURNS. It is
 * kept once the real checks land, because a package whose whole contract is a
 * record type should have one test that fails if the record type moves.
 */
export function selfCheck(): CheckRecord {
  return {
    name: "self",
    status: "pass",
    evidence: ["repo-truth is installed; no repository check is implemented yet"],
  };
}

/**
 * Whether a set of records lets a candidate through.
 *
 * A `skip` does not block: a check that could not run has not found anything,
 * and treating "did not run" as "found a defect" is how a gate gets switched
 * off wholesale. A check that must not be skippable says so by failing instead.
 */
export function allPassed(records: readonly CheckRecord[]): boolean {
  return records.every((record) => record.status !== "fail");
}
