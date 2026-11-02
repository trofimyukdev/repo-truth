# repo-truth

repo-truth reads a range of git commits - `base..candidate`, the change a branch or a
pull request makes - and reports the moves that make a repository look healthier than
it is: a test skipped, focused or deleted, a coverage minimum lowered, a timeout
raised, a workflow or a compiler setting loosened, a lint rule turned off, a
credential or a secret file committed, a dependency from outside the registry, an
action that is not pinned, a figure in the documentation with no command behind it.
It is one command, `repo-truth check`, and a GitHub Action that runs it over a pull
request.

Each check answers with a record: its name, a status - `pass`, `fail` or `skip` - and
evidence lines that name the file, the line or the commit. Each check reads the range
through git and fails closed: a git call that fails is a `fail` record, never a `pass`.
A revision that names no commit stops the command before any check runs, with exit 2.
The exit code says whether any check failed.

## Install

Node.js 20 or newer, and git on the `PATH`.

```sh
npm install --save-dev @trofimyukdev/repo-truth
```

The package installs one command, `repo-truth`. In a project that installs it,
`npx repo-truth` runs it. Outside one, name the package: the unscoped name
`repo-truth` on npm is another project, so a bare `npx repo-truth` would fetch and
run that one.

```sh
npm exec --package=@trofimyukdev/repo-truth -- repo-truth check --base origin/main --candidate HEAD
```

## Usage

```sh
repo-truth check --base <rev> --candidate <rev>
repo-truth check --target <rev> --candidate <rev>
repo-truth list
repo-truth --help
```

`check` runs every registered check over `base..candidate` and prints one record per
check, in the order `repo-truth list` prints the names.

- `--base <rev>`: the range starts after this commit.
- `--target <rev>`, in place of `--base`: the branch a pull request merges into. The
  range then starts at the merge base of the target and the candidate, so commits that
  reached the target after the branch forked are not charged to it. A missing merge
  base is a refusal; in a shallow clone the message asks for `fetch-depth: 0`. When
  `GITHUB_EVENT_NAME` is set, it must be `pull_request` or `pull_request_target`.
- `--candidate <rev>`: the last commit of the range.
- `--check <name>`, repeatable: run only the named checks.
- `--except <name>`, repeatable: run every check but the named ones. It cannot be given
  with `--check`, and it cannot name every check.
- `--format text|json`: `json` prints one document instead of the text:
  `"schema": "repo-truth.check/v1"`, the resolved `base` and `candidate`, `config`,
  `ok`, `exitCode` and the `records`.
- `--config <path>`: read the settings from this file instead of `repo-truth.json` at
  the base commit (see Configuration).
- `--no-fetch`: skip the `git fetch --all --quiet` the command otherwise runs before it
  resolves either revision.

The text form is one line per record, its status and its name, then its evidence lines
indented, and a last line, `repo-truth: all checks passed` or
`repo-truth: at least one check failed`. Text outside printable ASCII is printed as
`\u{hex}`.

The exit code is the contract. The header of `src/cli.ts` is the one place it is
stated; in short:

```text
0  every check that ran passed or skipped
1  at least one check failed
2  bad invocation or unrunnable environment - an unknown option or check,
   --except with --check or naming every check, a revision that names no
   commit, a failed fetch, a configuration the command refuses; never a
   check's finding
```

On exit 2 nothing is written to standard output and no check has run. `repo-truth list`
answers 0 after printing the names, and 2 for any argument but `--help`.

## GitHub Action

The Action runs `repo-truth check` over the pull request that triggered it: `--target`
is the pull request's base branch on `origin`, `--candidate` its head commit. It needs
the whole history, so check out with `fetch-depth: 0`. It builds repo-truth from its
own source with `npm ci && npm run build`, and it writes the records to the job
summary.

```yaml
on: pull_request

jobs:
  repo-truth:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: trofimyukdev/repo-truth@v0.1.0
        with:
          except: RT-03
```

RT-03 fails a pull request whose head commit names no task in a `Task-Id` trailer.
The example leaves it out; a repository that writes that trailer drops the `with:`
block.

Its inputs, all optional:

- `checks`: names separated by white space or commas, each passed as `--check`.
- `except`: names, each passed as `--except`. Not allowed together with `checks`.
- `format`: `text` (the default) or `json`.
- `config`: a path passed as `--config`. It is read from the checked-out tree, which in
  a pull request is the pull request's own copy; the default, empty, reads
  `repo-truth.json` at the merge base instead.
- `base`: a revision passed as `--base`. The range is then from that revision to the
  commit the run is for, on any event: a push, a merge queue, a scheduled or a manual
  run. Empty keeps the pull request's range.

A tag can be moved after you adopt it, and RT-88 below reports exactly that kind of
reference. To hold the Action to one commit, write the full commit id the tag names
in place of `v0.1.0`.

## Configuration

Options for the checks that take them live in `repo-truth.json` at the top of the
repository. It is read from the base commit through git, not from the working tree or
the candidate, so a range is judged by the settings it started from; RT-66 fails a
range that changes the file. `--config <path>` reads another file instead.

```json
{
  "schema": "repo-truth.config/v1",
  "checks": {
    "RT-57": { "forbidden": ["migrations/**", ".github/CODEOWNERS"] },
    "RT-88": { "allowedOwners": ["actions"] }
  }
}
```

A missing or wrong `schema`, a key other than `schema` and `checks`, a check the
registry does not hold, an option the check does not declare or a value of the wrong
kind is a refusal, exit 2, naming each issue. The options:

- `RT-12` `maxBytes` (integer): the largest blob the range may bring in.
- `RT-18` `registries` (strings): the registries a dependency may come from.
- `RT-19` `timeoutMs` (integer): how long one replayed command may run.
- `RT-55` `allowedSuffixes` (strings): binary files whose names end so are not reported.
- `RT-57` `forbidden` and `allowed` (strings): path patterns. `?` is one character but
  `/`, `*` is any run but `/`, and a segment that is exactly `**` is any number of
  whole segments.
- `RT-88` `allowedOwners` (strings): action owners whose references need no pin.

Many findings are for a human to accept rather than to fix. Eighteen checks accept a
sanction: RT-04, RT-14, RT-16, RT-24, RT-31, RT-33, RT-34, RT-55, RT-56, RT-57, RT-66,
RT-87, RT-88, RT-89, RT-91, RT-92, RT-93 and RT-94. A line
`Sanctioned-Weakening: <id> <reason>` in a commit message of the range accepts the
finding with that id, and the record then shows the reason. The header comment of
each check's module states the form of its ids: `<category>:<file>` for some,
`<category>:<file>:<line>` for others such as RT-04, RT-24 and RT-31. RT-04's id opens
its evidence line, as in `skip:test/math.test.js:4`; other checks print the same parts
in another order, as `<file>: <category>`, so the id is not always the evidence line's
first word. The other thirteen checks have no sanction: the fix is to change the range.

## Checks

There are 31 checks in version 0.1.0: `repo-truth list | wc -l` printed 31 on
2026-11-02, run from the package as it was packed for this release. In the order
they run:

- `RT-01` commit hygiene: the message and both identities of every commit hold only
  printable ASCII and tab.
- `RT-02` measurement rule: a figure with a unit, in a commit body or in a line the
  range adds to a `.md` file, has a command (a code span or a fenced block) and an ISO
  date in the same paragraph or commit body.
- `RT-03` trailer: the candidate commit names the task it closes in a `Task-Id` or a
  `Millwright-Task-ID` trailer.
- `RT-04` weakened tests: no skip or focus marker added, no test file, test or
  assertion removed.
- `RT-05` stray files: no added path is a log, an editor backup, a set-aside copy, a
  scratch script, coverage or build output, OS metadata, or a path the repository's
  own ignore rules exclude.
- `RT-06` lockfile drift: the dependency fields of `package.json` and the root
  lockfile change together.
- `RT-09` conflict markers: no added line is a leftover merge conflict marker.
- `RT-10` portable paths: no new name differs from another only in letter case, is a
  Windows device name, ends in a dot or a space, or holds a character Windows forbids.
- `RT-11` symlinks: no added or changed link points at an absolute path, outside the
  repository, or into `.git`.
- `RT-12` large blobs: no blob the range brings into the history is larger than
  `maxBytes`, counting blobs the candidate's tree no longer holds.
- `RT-14` lowered thresholds: no coverage minimum goes down or goes away.
- `RT-16` snapshot refreshes: every snapshot the range rewrites or deletes, and whether
  the commit that did it also changed a file that is neither a snapshot nor a test.
- `RT-18` dependency sources: every added dependency comes from a registry, not a git
  URL, a tarball URL, a path or an alias.
- `RT-19` replayed figures: a figure written as a git command in a code span, the word
  `printed` and the output in a code span is run again when it is a read-only git
  command the check knows how to replay, and a different output fails; any other
  command is counted as not replayable.
- `RT-88` unpinned actions: every `uses:` the range adds to a workflow or an
  `action.yml` names a full commit id, a digest or a local path.
- `RT-29` autosquash leftovers: no commit subject begins `fixup! `, `squash! ` or
  `amend! `.
- `RT-93` bidirectional controls: no file the range touches gains one of the nine
  Unicode controls that reorder how a line is shown ("Trojan Source").
- `RT-55` binary files: no file the range adds or changes is binary by git's own test.
- `RT-66` configuration changed: the range does not add, change, delete or rename the
  file the run's settings were read from.
- `RT-26` credentials: no added line holds a credential in a form only a real one has;
  the finding names the file, the line and the kind, never the text.
- `RT-94` install scripts: no package the range adds to an npm lockfile runs an install
  script.
- `RT-92` lint rules: no rule is set to `off` or `0` in an ESLint, Biome or oxlint
  configuration file. A rule set to `warn` or deleted, and a rule turned off through
  `extends`, are not seen.
- `RT-57` path policy: no changed path is one the repository's `forbidden` patterns
  name, or outside its `allowed` ones.
- `RT-24` raised timeouts: no timeout in a test file or the runner's configuration goes
  up, and none is added to a file the base already holds.
- `RT-33` ladder commands: every entry of `scripts` in a `package.json` that the range
  adds, removes or changes is reported for a human to sanction.
- `RT-89` secret files: no added or changed file is named like one that holds secrets
  by what it is - `.env`, `.netrc`, a private key, a Terraform state.
- `RT-34` compiler strictness: no strict option of a tsconfig loses its strict value,
  and `extends` does not change.
- `RT-87` submodules: no submodule is added or moved, and `.gitmodules` gains no `url`.
- `RT-31` suppression directives: every suppression comment the range adds without
  removing one like it from the same file.
- `RT-91` workflow permissions: no workflow line gives the job's token write access or
  runs the workflow on `pull_request_target`.
- `RT-56` weakened workflows: no workflow is removed, and no workflow gains a line of a
  weakening shape.

Each check is also an async function in the package's `dist/` directory: it takes
`{ cwd, base, candidate }` and resolves to a record of the same shape.

## Known limitations

- RT-04 reads a test renamed in its file - `test("adds")` becoming
  `test("adds two numbers")` - as a test removed, a `test-removed` finding to
  sanction. A test file renamed with its content unchanged is no finding.
- RT-06 reads any change to the root lockfile with no change to a dependency field of
  `package.json` as an unrequested change, even one that only renames the package or
  changes its version at the top of the lockfile.
- There is no `--version`: `repo-truth --version` is an unknown command, exit 2. The
  installed version is in the package's `package.json`.
- The package declares no main entry, so `import "@trofimyukdev/repo-truth"` fails; a
  module is imported by its path, `@trofimyukdev/repo-truth/dist/<module>.js`.
- The workflow checks (RT-56, RT-88, RT-91) read workflow files as lines of text; the
  YAML is not parsed.

## How it is built

repo-truth's checks are built by Millwright, an autonomous coding factory, each from
a task in `factory/tasks/` (https://github.com/trofimyukdev/autonomous-coding-factory).

## Development

```sh
npm ci
npm run typecheck
npx vitest run
npm run build
node --test test/e2e/cli.e2e.mjs
```

The last line runs the end-to-end suite against the built command.

License: MIT
