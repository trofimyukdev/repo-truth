# Roadmap

## The goal

repo-truth is to become the portable gate, run on itself and built only by the factory: one command
and a configurable GitHub Action that run at least twenty-two checks over any range of commits, with
this repository's own end-to-end suite and its own command as rungs of its ladder. Along the way the
repository is to show at least forty verified merges made by the factory, each one measured again
after it lands, with no merge by hand after the first task.

## How this roadmap is kept

- Only the current stage is broken into tasks. Every task that lands changes the code the next tasks
  describe, so a stage's tasks are written when the stage before it is done or nearly done, and the
  outlines of the later stages change as they go.
- Every task is a TaskSpec in `factory/tasks/`, with a holdout item the gate runs and the builder is
  never shown. Each holdout is rehearsed both ways before the task is queued: it fails the code as it
  stands, and it passes a reference that does what the task asks.
- A task is sized so the factory's mutation probe can finish measuring it: a new module of at most
  about two hundred and fifty lines.
- Tasks that can be built side by side touch no common file and claim no common resource.

## Stage 1 - finish the split, make check tasks independent, open two builders

- Land what is in flight: the claim reader (RT-21), the replayed-figures check (RT-19) and the
  end-to-end suite (RT-17).
- A check directory (RT-22): a new check becomes one module and its tests, so two check tasks no
  longer edit the same file.
- New checks on that directory, starting with raised timeouts (RT-24) and credentials in added
  lines (RT-26); then autosquash leftovers (RT-29), suppression directives (RT-31), changed ladder
  scripts (RT-33) and lowered compiler strictness (RT-34).
- Suite strength: tests that fail on the defects the mutation probe found unasserted, starting with
  large blobs (RT-23), lowered thresholds (RT-25), lockfile drift (RT-27) and symlinks (RT-30); then
  suppression directives (RT-36), dependency sources (RT-37), compiler strictness (RT-38), the
  command itself (RT-39), the Action's program (RT-41) and changed ladder scripts (RT-42).
- Action inputs for the checks to run and the output format (RT-32), which reach the command
  through the step's environment.

Done when RT-21, RT-19 and RT-17 have each landed or been set aside with the reason; most of the
stage's new tasks have landed; and the factory has run several passes with two builders at once.

## Stage 2 - the repository runs its own command, and every merge is measured

- A full-suite rung that runs the end-to-end suite, and a project-truth rung that runs `repo-truth
  check` on the repository's own candidates (both are the maintainer's edits to
  `factory/checks.yaml`).
- `--except <name>`, and a command that lists the registered checks (RT-35), so that rungs and
  suites never hold a list of names that goes stale.

Done when five merges in a row are measured `passed` after they land, and the replayed-figures check
passes over this README's own figures from the root commit.

## Stage 3 - configuration and adoption

- Per-check options read from one configuration file (its form is a product decision, the
  maintainer's), handed to each check by the command.
- A path-policy check, and the Action's records written to the job summary (the latter RT-40).

Done when a range is checked with per-check options from one file and the Action writes its records
to the job summary.

## Stage 4 - breadth and strength

- More checks: a CI workflow that is weakened, binary files the range adds.
- Suite-strength tasks for the remaining modules.

Done when at least twenty-two checks are registered and the factory has made at least forty
verified merges here.

## Stage 5 - release

A published package under a name of its own, a version, and a README that says what is done and what
is not. These are the maintainer's acts, not tasks.
