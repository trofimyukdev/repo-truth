# repo-truth

Repository truth: the gates an autonomous coding factory runs before it merges, in
portable form - checks over a commit range that any repository can adopt. Today they
are a TypeScript library, one command that runs them, `repo-truth check`, and a
GitHub Action that runs that command over a pull request.

**And: the showcase. This repository is developed BY the factory.** Its tasks are
not issues; they are TaskSpecs in `factory/tasks/`, and the factory picks them up,
builds them, verifies them, gates them and merges what passes. See
[autonomous-coding-factory](https://github.com/trofimyukdev/autonomous-coding-factory)
for what the factory is and how it decides.

## Status

**Ten checks are implemented, and one command runs them: `repo-truth check`.** The
count is `git grep -l '^export async function check' 825cfbf -- src | wc -l`, which
printed `10` on 2026-10-05 at `825cfbf`, the merge of `RT-13`. Each check
is one module in `src/` with its tests in `test/unit/`, and each answers as a
`CheckRecord` (`name`, `status`, `evidence`) that a gate consumes without parsing
prose. The command runs what the registry in `src/registry.ts` holds, the same ten:
`git grep -c '^  entry("RT-' 825cfbf -- src/registry.ts` printed
`825cfbf:src/registry.ts:10` on 2026-10-05.

The Action is `action.yml`, at the root. It builds repo-truth with
`npm ci && npm run build`, then runs the command over the pull request that
triggered it: `--target` is the pull request's base branch on `origin`, and
`--candidate` its head commit. Its description ends "Needs actions/checkout with
fetch-depth 0." No workflow in this repository runs it:
`git ls-tree -r --name-only 825cfbf -- .github` printed nothing on 2026-10-05.

## What it checks

Each check reads the range `base..candidate` through git and fails closed: an unknown
revision or a failed git call is a `fail` record, never a `pass`. By record name:

- `RT-01` commit-range hygiene, `checkCommitRange`: the message and both identities
  of every commit hold only printable ASCII and tab - read over the whole range,
  because `cherry-pick`, `revert`, `rebase` and `git am` never run a `commit-msg` hook.
- `RT-02` measurement rule, `checkMeasurementRule`: a figure with a unit, in a commit
  body or in a line the range adds to a `.md` file, has a command (a code span or a
  fenced block) and an ISO date in the same paragraph or commit body.
- `RT-03` trailer check, `checkTrailers`: the landing - the candidate commit - names
  the task it closes in a `Task-Id` trailer, or in the `Millwright-Task-ID` trailer
  the factory writes on its merges, as git itself parses trailers.
- `RT-04` weakened tests, `checkWeakenedTests`: no skip or focus marker added, no test
  file, test or assertion removed - unless a `Sanctioned-Weakening:` line sanctions it.
- `RT-05` stray files, `checkStrayFiles`: no added path is a log, an editor backup, a
  set-aside copy, a scratch script, coverage or build output or OS metadata, or a
  path the repository's own ignore rules exclude.
- `RT-06` lockfile drift, `checkLockfileDrift`: the dependency fields of `package.json`
  and the root lockfile change together; a stale pin and an unrequested version
  change are reported apart.
- `RT-09` conflict markers, `checkConflictMarkers`: no added line is a leftover
  `<<<<<<<`, `|||||||` or `>>>>>>>` marker, or a `=======` between them.
- `RT-10` portable paths, `checkPortablePaths`: no name the range introduces differs
  from another only in letter case, is a Windows device name, ends in a dot or a
  space, or holds a character Windows forbids.
- `RT-11` symlinks, `checkSymlinks`: no link the range adds or changes points at an
  absolute path, outside the repository, or into `.git`.
- `RT-12` large blobs, `checkLargeBlobs`: no blob the range brings into the history
  is larger than `maxBytes` (default `DEFAULT_MAX_BLOB_BYTES`), counting blobs the
  candidate's own tree no longer holds.

Every check has a stated failure mode it must not have; those are the
`not_done_if` lists in the task files, and they are the part worth reading.

## How to run it

`repo-truth check --base <rev> --candidate <rev>` runs every check in the registry
over `base..candidate` and answers with one record per check. Run it from a clone,
not with `npx`; "What is not done yet" says why. `package.json` maps the `repo-truth`
command to `dist/cli.js` in its `bin` field (`npm pkg get bin`), and the build
produces that file. In a clone of this repository, over the range of the merge
that brought the command in:

```sh
npm ci && npm run build
node dist/cli.js check --base a355722 --candidate fcf6d3b; echo "exit $?"
```

On 2026-10-05, built at `825cfbf`, the second line printed this - all ten checks
pass:

```text
PASS RT-01
     2 commit(s) in a3557227ad2fd423522417c145d3c945a9cb6b61..fcf6d3b1aef0efd74198144c318dad2204a7c8e5 are printable ASCII/tab, identities included
PASS RT-02
     no unmeasured figure in the commit bodies or added documentation lines of a3557227ad2fd423522417c145d3c945a9cb6b61..fcf6d3b1aef0efd74198144c318dad2204a7c8e5
PASS RT-03
     fcf6d3b1aef0 merge: RT-07 - One entry point - `repo-truth check` runs the checks and answers with records: closes RT-07
PASS RT-04
     no move in "a3557227ad2fd423522417c145d3c945a9cb6b61".."fcf6d3b1aef0efd74198144c318dad2204a7c8e5" lowers what the suite asserts
PASS RT-05
     3 path(s) added in "a3557227ad2fd423522417c145d3c945a9cb6b61".."fcf6d3b1aef0efd74198144c318dad2204a7c8e5" match no stray shape and no ignore rule
PASS RT-06
     neither the dependency fields of package.json nor package-lock.json changed
PASS RT-09
     617 added line(s) in "a3557227ad2fd423522417c145d3c945a9cb6b61"..."fcf6d3b1aef0efd74198144c318dad2204a7c8e5" hold no conflict marker
PASS RT-10
     3 name(s) introduced in "a3557227ad2fd423522417c145d3c945a9cb6b61".."fcf6d3b1aef0efd74198144c318dad2204a7c8e5", all portable
PASS RT-11
     0 link(s) added or changed in "a3557227ad2fd423522417c145d3c945a9cb6b61".."fcf6d3b1aef0efd74198144c318dad2204a7c8e5" stay inside the repository
PASS RT-12
     4 blob(s) added in "a3557227ad2fd423522417c145d3c945a9cb6b61".."fcf6d3b1aef0efd74198144c318dad2204a7c8e5", none over 1048576 bytes
repo-truth: all checks passed
exit 0
```

The exit code is the contract, and the header of `src/cli.ts` is the one place it
is stated; this prints it:
`git show fcf6d3b:src/cli.ts | sed -n '/EXIT CODES/,/no check has run/p'`

```text
 * EXIT CODES - the one place they are stated:
 *   0  every check that ran passed or skipped
 *   1  at least one check failed
 *   2  bad invocation or unrunnable environment (unknown option, unknown check,
 *      a revision that names no commit, a failed fetch). Never a check's finding.
 *
 * On exit 2 nothing is written to stdout and no check has run.
```

A revision that names no commit, on 2026-10-05:

```sh
node dist/cli.js check --base no-such-rev --candidate fcf6d3b; echo "exit $?"
```

```text
repo-truth: --base "no-such-rev" does not name a commit in this repository
usage: repo-truth check (--base <rev> | --target <rev>) --candidate <rev> [--check <name>]... [--format text|json] [--no-fetch]
exit 2
```

`--target <rev>`, in place of `--base`, names the branch a pull request merges
into: the range then starts at the merge base of the target and the candidate, so
commits that reached the target after the branch forked are not charged to it. A
missing merge base is a bad invocation - in a shallow checkout the message asks for
`fetch-depth: 0` - and so is `--target` when `GITHUB_EVENT_NAME` names an event
other than `pull_request` or `pull_request_target`.
`--check <name>`, which may be repeated, runs only the named checks. `--format json`
prints one JSON document instead of the text: `"schema": "repo-truth.check/v1"`, the
resolved `base` and `candidate`, `ok`, `exitCode` and the `records`. `--no-fetch`
skips the `git fetch --all --quiet` the command runs before it resolves either
revision.
Each check is also an async function exported from its module in `dist/`: it takes
`{ cwd, base, candidate }` and resolves to a `CheckRecord`.

## How these checks were built

They were built by Millwright, an autonomous coding factory (public showcase:
https://github.com/trofimyukdev/autonomous-coding-factory), each from its TaskSpec
in `factory/tasks/`. Nine were merged into `main` by the factory's gate:
`git log --merges --oneline 8338b5a | wc -l` printed `9` on 2026-10-03. This lists
them with the trailer that names each one's task, and prints nine lines, `RT-10`
first and `RT-12` last, every one dated 2026-10-02:
```sh
git log --merges --reverse --date=short --format='%h %ad %(trailers:key=Millwright-Task-ID,separator=)' 8338b5a
```

Each of those merges adds two files, a check and its test, and changes nothing
else: `for m in $(git rev-list --merges 8338b5a); do git diff --name-status $m^1 $m; done`
(run 2026-10-03). Their second parents are the builders' commits, and in a
`Co-Authored-By` trailer each of those names the model that worked on it:
`git log --no-merges --format='%h %(trailers:key=Co-Authored-By,valueonly,separator=)' 9eb3692..8338b5a`.

`RT-01` landed differently. The factory built it while it still ran in shadow
mode, which merges nothing, and it was put on `main` by hand as a plain commit:
`git log -1 --format='%h parents: %p trailers: [%(trailers)]' 1049432` printed
`1049432 parents: 181be30 trailers: []` on 2026-10-03.

The command that runs them, `RT-07`, was the gate's tenth merge, on 2026-10-03:
`git log --merges --oneline fcf6d3b | wc -l` printed `10`, and
`git diff --name-status fcf6d3b^1 fcf6d3b` lists `package.json` modified, for its
new `bin` field, beside three added files: `src/cli.ts`, `src/registry.ts` and
`test/unit/cli.test.ts`.

The Action, `RT-08`, was the gate's eleventh merge and `RT-13` its twelfth, both on
2026-10-05: `git log --merges --oneline 825cfbf | wc -l` printed `12`.
`git diff --name-status 07ab827^1 07ab827` lists `action.yml`, `src/action.ts` and
`test/unit/action.test.ts` added and `src/cli.ts` modified, for `--target`;
`src/registry.ts` is not among them, so no check was added. `RT-13` mended four
things in code that had already merged: `git diff --name-status 825cfbf^1 825cfbf`
lists `src/index.ts`, `src/large-blobs.ts`, `src/portable-paths.ts` and
`src/trailers.ts` modified, beside two of their tests; with it, `RT-03` reads the
factory's trailer, `selfCheck()` names how many checks the registry holds, `RT-10`
says so when a range introduces no name, and a passing `RT-12` names how many
blobs the range added.

## How the factory drives this repository

`factory/` is the consumer half of the contract. The controller lives elsewhere;
this repository holds configuration only:

```text
factory/
  millwright.toml   # repo, base branch, merge mode, shadow and deploy switches, models, budget
  compat.json       # tested and minimum controller and CLI versions
  tasks/            # the queue: one TaskSpec per file
  checks.yaml       # this repository's deterministic check ladder
  policy/           # the worker deny list and the holdout rule
  state/            # database and event log      (gitignored, absent)
  runs/             # run artefacts               (gitignored, absent)
  generated/        # generated views             (gitignored, absent)
```

Shadow came first: the factory built and verified tasks, merged nothing, and left
a candidate and a verdict for a human to read. The operator switched shadow off on
2026-10-02 in `9eb3692`, whose message calls the mode supervised auto-merge
(`git log -1 --format=%b 9eb3692`); since then a candidate that passes the gate is
merged. The ladder in `factory/checks.yaml` is typecheck, unit tests and build:
`git grep -n -E '^  [a-z_]+:$' 825cfbf -- factory/checks.yaml` listed those three
rungs and no other on 2026-10-05.

Every spec the gate merged declares a holdout acceptance item - a command the gate
runs and the builder is never shown: `git grep -c 'holdout: true' 825cfbf -- factory/tasks`
printed a count of `1` for each of the twelve on 2026-10-05.

## What is not done yet

- The ladder does not run `repo-truth check`. A comment in `factory/checks.yaml`
  says this package exists to become its `project_truth` rung, and no such rung is
  declared: `git grep -n project_truth 825cfbf -- factory/checks.yaml` printed one
  line, that comment's, on 2026-10-05.
- `repo-truth` is not published to npm, and the name there belongs to another
  project: on 2026-10-05 `npm view repo-truth repository.url` named a different
  repository, so `npx repo-truth` would fetch and run that one.

## Local development

```sh
npm install
npm run typecheck
npm test
npm run build
```

Node 20 or newer: `npm pkg get engines.node` prints `">=20"`.

License: MIT
