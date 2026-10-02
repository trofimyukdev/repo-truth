# repo-truth

Repository truth: the gates an autonomous coding factory runs before it merges, in
portable form - checks over a commit range that any repository can adopt. Today they
are a TypeScript library; the `repo-truth` command and a GitHub Action are next.

**And: the showcase. This repository is developed BY the factory.** Its tasks are
not issues; they are TaskSpecs in `factory/tasks/`, and the factory picks them up,
builds them, verifies them, gates them and merges what passes. See
[autonomous-coding-factory](https://github.com/trofimyukdev/autonomous-coding-factory)
for what the factory is and how it decides.

## Status

**Ten checks are implemented. There is no command that runs them yet.** The count is
`git grep -l '^export async function check' 8338b5a -- src | wc -l`, which printed
`10` on 2026-10-03 at `8338b5a`, the `main` this README describes. Each check is one
module in `src/` with its tests in `test/unit/`, and each answers as a `CheckRecord`
(`name`, `status`, `evidence`) that a gate consumes without parsing prose.

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
  the task it closes in a `Task-Id` trailer, as git itself parses trailers.
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

## How to run a check today

There is no `repo-truth` command yet: `npm pkg get bin` prints `{}`. Each check is an
async function exported from its module in `dist/`; it takes `{ cwd, base, candidate }`
and resolves to a `CheckRecord`. In a clone of this repository:

```sh
npm ci && npm run build
node --input-type=module -e '
  import { checkCommitRange } from "./dist/commit-range.js";
  const record = await checkCommitRange({ cwd: ".", base: "9eb3692", candidate: "8338b5a" });
  console.log(JSON.stringify(record, null, 2));
'
# On 2026-10-03, over the range of the factory's merges, this printed a "pass" record:
# "18 commit(s) in 9eb3692..8338b5a are printable ASCII/tab, identities included"
```

`cwd` is the repository to read; `base` and `candidate` are revisions it holds.

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
merged. The ladder in `factory/checks.yaml` is typecheck, unit tests and build;
this repository does not run its own checks on itself until `repo-truth check` exists.

Every spec the gate merged declares a holdout acceptance item - a command the gate
runs and the builder is never shown: `git grep -c 'holdout: true' 8338b5a -- factory/tasks`.

## What is not done yet

- `RT-07`: `repo-truth check --base <rev> --candidate <rev>` runs every registered
  check, prints records for a human and JSON for a machine, and exits on a stated
  code that tells a failed check from a failed invocation. It is not on `main` yet.
- `RT-08`: a GitHub Action around that command, which takes a pull request's range
  from the merge base, not the target's tip, and fails loudly when a shallow checkout
  lacks that merge base.
- `RT-03` reads `Task-Id` while the factory's merges carry `Millwright-Task-ID`, so
  `RT-03` over any of them answers `fail` today:
  `git log --merges --format='%h [%(trailers:key=Task-Id,valueonly)]' 8338b5a`
  printed an empty `[]` for each on 2026-10-03.
- `selfCheck()` in `src/index.ts` predates the checks and still says none is implemented.

## Local development

```sh
npm install
npm run typecheck
npm test
npm run build
```

Node 20 or newer: `npm pkg get engines.node` prints `">=20"`.

License: MIT
