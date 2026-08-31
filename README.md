# repo-truth

Repository truth: the gates an autonomous coding factory runs before it merges,
in portable form - a CLI and an npm package any repository can adopt.

**And: the showcase. This repository is developed BY the factory.** Its tasks are
not issues; they are TaskSpecs in `factory/tasks/`, and the factory picks them up,
builds them in an isolated worktree, verifies them, gates them and merges them.
See [autonomous-coding-factory](https://github.com/trofimyukdev/autonomous-coding-factory)
for what the factory is and how it decides.

## Status

**Skeleton. Not one repository check is implemented.**

What exists is the result type every check will answer in (`src/index.ts`), one
self-check that asserts that type, and the factory contract under `factory/`. What
does not exist is any of the six checks below. That is the honest state of it, and
it is stated here rather than in a footnote because a README that describes the
intended package as if it were the built one is the first thing this package
exists to catch.

## What it will check

Each of these is one queued task, and each answers as a `CheckRecord`
(`name`, `status`, `evidence`) that a gate consumes without parsing prose.

| Check | Task | What it answers |
|---|---|---|
| Commit-range hygiene | `RT-01` | Every commit in `base..candidate` - message, author and committer identity - is within the allowed character set. Enforced over the range because `cherry-pick`, `revert`, `rebase` and `git am` never invoke a `commit-msg` hook. |
| Measurement rule | `RT-02` | "A number without a command and a date is not a fact", over commit bodies and the documentation lines the range changed. |
| Trailer check | `RT-03` | A landing names the task it closes, in git's trailer block rather than in prose, so a range can be reconciled against a queue. |
| Weakened tests | `RT-04` | The suite did not get greener by asking less: a newly added `.skip` or `.only`, a lowered threshold, a snapshot refreshed alongside the code it covers, a deleted assertion. |
| Stray files | `RT-05` | What the range ADDED that nobody meant to keep - scratch scripts, logs, backups, build output - and any added path the repository's own ignore rules already cover. |
| Lockfile drift | `RT-06` | The manifest and the lockfile still agree, and which of the two moved alone: a stale pin and an unrequested version bump are different findings. |
| CLI entry point | `RT-07` | `repo-truth check --base <rev> --candidate <rev>` runs the registry and answers on a stated exit code, with a check failure distinguishable from a failed invocation. |
| Action wrapper | `RT-08` | A pull request's range is the merge base, not the target's tip - and a shallow checkout that lacks the merge base fails loudly instead of passing. |

Every check has a stated failure mode it must not have; those are the
`not_done_if` lists in the task files, and they are the part worth reading.

## How the factory drives this repository

`factory/` is the consumer half of the contract. The controller lives elsewhere,
installed at a pinned version; this repository holds configuration only:

```text
factory/
  millwright.toml   # repo, base branch, merge mode, deploy switch
  compat.json       # tested and minimum controller and CLI versions
  tasks/            # the queue: one TaskSpec per file
  checks.yaml       # this repository's deterministic check ladder
  policy/           # the worker deny list
  state/            # database and event log      (gitignored, absent)
  runs/             # run artefacts               (gitignored, absent)
  generated/        # generated views             (gitignored, absent)
```

The order of operations, and it is not negotiable in either direction:

1. **Shadow first.** The factory builds and verifies a task and merges nothing.
   Shadow mode is the default and stays on; what it produces is a candidate branch
   and a verdict for a human to read.
2. **Live ticks after.** The operator switches shadow off once shadow runs have
   been read. `[merge] mode = "auto"` in `millwright.toml` describes the
   destination, not the present.

Nothing here has run yet. When it has, the run will say so with the command that
prints it - because a number without a command and a date is not a fact, which is
also what `RT-02` checks.

## Local development

```sh
npm install
npm run typecheck
npm test
npm run build
```

Node 20 or newer.

License: MIT
