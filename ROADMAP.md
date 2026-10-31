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
  `factory/checks.yaml`). The project-truth rung waits for the weakened-tests check to read a skip
  or focus marker only in code, never inside a string literal (RT-58).
- `--except <name>`, and a command that lists the registered checks (RT-35), so that rungs and
  suites never hold a list of names that goes stale.
- The conflict-markers check reads a path whose type changes - a symbolic link replaced by a
  regular file, or the other way - as one path, so that the project-truth rung does not refuse such
  a change when it holds no conflict marker (RT-64).

Done when five merges in a row are measured `passed` after they land, and the replayed-figures check
passes over this README's own figures from the root commit.

## Stage 3 - configuration and adoption

- Per-check options read from one configuration file (its form is a product decision, the
  maintainer's), handed to each check by the command. The maintainer chose `repo-truth.json` at the
  root on 2026-10-21; its reader is RT-54, which states the form he read before this commit. The
  registry declares each check's options and hands them to the check (RT-59); the command reads the
  file at the base of the range, or the one `--config` names, and refuses a bad one (RT-60); the
  Action's `config` input hands the command a file of its own as `--config` (RT-61).
- The end-to-end suite runs the built command with a configuration file - at the base, and named
  by `--config` - and the checks added since it was written by `--check` (RT-62).
- The end-to-end suite runs the configuration-change check through the built command (RT-74).
- The command hands every check the path `--config` names, as an option no configuration file
  can set (RT-65).
- A range that adds, changes, deletes or renames the file the run's settings were read from fails,
  unless a commit message of the range sanctions the change (RT-66).
- A configuration file that gives one name twice in an object is refused, each repeat named (RT-75).
- The settings are read from repo-truth.json at the repository's top directory, wherever in the
  repository the command runs, and the configuration-change check watches that file (RT-81).
- The end-to-end suite runs the built command in a subdirectory, where it reads and watches the top
  directory's repo-truth.json and reads a relative `--config` against the subdirectory (RT-85).
- The Action's `except` input reaches the command as `--except`, so a workflow leaves out a check
  without naming all the others (RT-86).
- A path-policy check (RT-57), and the Action's records written to the job summary (the latter
  RT-40).

Done when a range is checked with per-check options from one file and the Action writes its records
to the job summary.

## Stage 4 - breadth and strength

- More checks: a CI workflow that is weakened (RT-56), binary files the range adds (RT-55), a
  submodule added or moved to another commit (RT-87), an action reference not pinned to a commit
  (RT-88).
- Suite-strength tasks for the remaining modules, starting with conflict markers (RT-43), stray
  files (RT-44), raised timeouts (RT-45) and credentials (RT-46); then the measurement rule
  (RT-47), snapshot refreshes (RT-48), portable paths (RT-49) and weakened tests (RT-50, reissued
  with one behavior split off as a task of its own, RT-51); then commit-range hygiene (RT-52) and
  figure claims (RT-53).
- Suite strength measured again on main after the modules landed: the configuration reader (RT-67),
  binary files (RT-68), weakened workflows (RT-69), the path policy (RT-70), landing trailers
  (RT-71), autosquash leftovers (RT-72), figure text (RT-73), replayed figures (RT-76), replay plans
  (RT-77), the registry (RT-78), configuration changes (RT-79), portable paths (RT-80), the command
  again (RT-82), conflict markers again (RT-83), the configuration reader again (RT-84).

Done when at least twenty-two checks are registered and the factory has made at least forty
verified merges here.

## Stage 5 - release

A published package under a name of its own, a version, and a README that says what is done and what
is not. These are the maintainer's acts, not tasks.
