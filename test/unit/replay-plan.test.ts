import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { planReplay } from "../../src/replay-plan.js";

const A = "0123abc";
const B = "89abcdef0123456789abcdef0123456789abcdef";
const C = "fedcba9";

describe("planReplay: plans", () => {
  it("plans each subcommand on a commit id, with the words after git", () => {
    expect(planReplay(`git rev-list ${A}`)).toEqual({ args: ["rev-list", A], countLines: false, commits: [A] });
    expect(planReplay(`git log ${B}`)).toEqual({ args: ["log", B], countLines: false, commits: [B] });
    expect(planReplay(`git grep foo ${A}`)).toEqual({ args: ["grep", "foo", A], countLines: false, commits: [A] });
    expect(planReplay(`git ls-tree ${A}`)).toEqual({ args: ["ls-tree", A], countLines: false, commits: [A] });
  });

  it("admits every rev-list option", () => {
    for (const option of ["--count", "--merges", "--no-merges", "--first-parent", "--reverse"]) {
      expect(planReplay(`git rev-list ${option} ${A}..${B}`)).toEqual({
        args: ["rev-list", option, `${A}..${B}`],
        countLines: false,
        commits: [A, B],
      });
    }
  });

  it("admits every log option", () => {
    for (const option of [
      "--oneline",
      "--merges",
      "--no-merges",
      "--first-parent",
      "--reverse",
      "-1",
      "-20",
      "--date=short",
      "--date=format:%Y",
      "--format=%h",
      "--format=",
      "--pretty=oneline",
      "--pretty=format:%H%x09%an",
    ]) {
      expect(planReplay(`git log ${option} ${A}`)).toEqual({ args: ["log", option, A], countLines: false, commits: [A] });
    }
  });

  it("admits every grep option", () => {
    for (const option of ["-c", "-l", "-n", "-E", "-F", "-i", "-w", "--count", "--files-with-matches"]) {
      expect(planReplay(`git grep ${option} TODO ${A}`)).toEqual({
        args: ["grep", option, "TODO", A],
        countLines: false,
        commits: [A],
      });
    }
    expect(planReplay(`git grep -e TODO ${A}`)).toEqual({ args: ["grep", "-e", "TODO", A], countLines: false, commits: [A] });
  });

  it("admits every ls-tree option", () => {
    for (const option of ["-r", "-d", "-t", "--name-only", "--full-tree"]) {
      expect(planReplay(`git ls-tree ${option} ${A} src`)).toEqual({
        args: ["ls-tree", option, A, "src"],
        countLines: false,
        commits: [A],
      });
    }
  });

  it("keeps a final | wc -l, written with and without spaces", () => {
    const plan = { args: ["log", "--oneline", A], countLines: true, commits: [A] };
    expect(planReplay(`git log --oneline ${A} | wc -l`)).toEqual(plan);
    expect(planReplay(`git log --oneline ${A}|wc -l`)).toEqual(plan);
    expect(planReplay(`git log --oneline ${A} |wc -l`)).toEqual(plan);
    expect(planReplay(`git log --oneline ${A}| wc -l`)).toEqual(plan);
    expect(planReplay(`git log --oneline ${A}\t|\twc\t-l`)).toEqual(plan);
  });

  it("removes quotes and joins quoted parts into one word", () => {
    expect(planReplay(`git log --format='%h %s' ${A}`)).toEqual({
      args: ["log", "--format=%h %s", A],
      countLines: false,
      commits: [A],
    });
    expect(planReplay(`git log "--format=%h %an" ${A}`)?.args).toEqual(["log", "--format=%h %an", A]);
    expect(planReplay(`git grep 'a b'"c d"e ${A}`)?.args).toEqual(["grep", "a bc de", A]);
    expect(planReplay(`'git' "log" '${A}'`)?.args).toEqual(["log", A]);
    expect(planReplay(`git grep '' ${A}`)?.args).toEqual(["grep", "", A]);
  });

  it("reads a quoted substitution, semicolon or pipe as text", () => {
    expect(planReplay(`git grep '$(rm -rf .)' ${A}`)?.args).toEqual(["grep", "$(rm -rf .)", A]);
    expect(planReplay(`git grep '\`id\`; x | y > z' ${A}`)?.args).toEqual(["grep", "`id`; x | y > z", A]);
    expect(planReplay(`git grep "a;b|c>d&e" ${A}`)?.args).toEqual(["grep", "a;b|c>d&e", A]);
    expect(planReplay(`git grep 'a|b' ${A} | wc -l`)?.args).toEqual(["grep", "a|b", A]);
  });

  it("names each commit once, in the order first named, without a caret and digits", () => {
    expect(planReplay(`git log ${A}^1..${B}^2 ${A} ${C}...${B}`)?.commits).toEqual([A, B, C]);
    expect(planReplay(`git rev-list --count ${A}...${B}`)?.commits).toEqual([A, B]);
    expect(planReplay(`git log ${A}^0`)?.commits).toEqual([A]);
    expect(planReplay(`git log ${A.toUpperCase()}`)?.commits).toEqual([A.toUpperCase()]);
  });

  it("takes revisions only before a lone --", () => {
    expect(planReplay(`git log ${A} -- src/main`)).toEqual({ args: ["log", A, "--", "src/main"], countLines: false, commits: [A] });
    expect(planReplay(`git rev-list --count ${A} -- README.md docs`)?.commits).toEqual([A]);
    expect(planReplay(`git grep foo ${A} -- '*.ts'`)?.commits).toEqual([A]);
    expect(planReplay(`git log ${A} -- -1`)?.commits).toEqual([A]);
  });

  it("takes grep's pattern from -e, or from the first argument", () => {
    expect(planReplay(`git grep -e foo -e bar ${A} ${B}`)?.commits).toEqual([A, B]);
    expect(planReplay(`git grep -n -e -c ${A}`)?.commits).toEqual([A]);
    expect(planReplay(`git grep -e -- ${A}`)?.commits).toEqual([A]);
    expect(planReplay(`git grep ${B} ${A}`)?.commits).toEqual([A]);
  });

  it("takes ls-tree's first argument as its revision, and the rest as paths", () => {
    expect(planReplay(`git ls-tree -r --name-only ${A} src docs`)?.commits).toEqual([A]);
    expect(planReplay(`git ls-tree ${A} -- src`)?.commits).toEqual([A]);
    expect(planReplay(`git ls-tree -- ${A}`)?.commits).toEqual([A]);
    expect(planReplay(`git ls-tree --name-only ${A} | wc -l`)?.countLines).toBe(true);
  });

  it("allows leading and trailing blanks", () => {
    expect(planReplay(`  git  log   ${A}\t`)?.args).toEqual(["log", A]);
  });
});

describe("planReplay: not replayable", () => {
  const notReplayable = (command: string): void => {
    expect(planReplay(command), command).toBeNull();
  };

  it("refuses a second command", () => {
    notReplayable(`git log ${A}; rm -rf .`);
    notReplayable(`git log ${A};rm -rf .`);
    notReplayable(`git log ${A} && rm -rf .`);
    notReplayable(`git log ${A} || rm -rf .`);
    notReplayable(`git log ${A}||rm -rf .`);
    notReplayable(`git log ${A} & rm -rf .`);
    notReplayable(`git log ${A}\nrm -rf .`);
    notReplayable(`git log ${A}\r`);
  });

  it("refuses a command substitution in both spellings", () => {
    notReplayable(`git log $(echo ${A})`);
    notReplayable(`git log \`echo ${A}\``);
    notReplayable(`git log ${A} --format=$(id)`);
  });

  it("refuses a redirection", () => {
    notReplayable(`git log ${A} > out.txt`);
    notReplayable(`git log ${A} >> out.txt`);
    notReplayable(`git log ${A} < in.txt`);
    notReplayable(`git log ${A} 2>&1`);
    notReplayable(`git log ${A} | wc -l > out.txt`);
  });

  it("refuses a pipe to another program, and a second pipe", () => {
    notReplayable(`git log ${A} | sh`);
    notReplayable(`git log ${A} | wc`);
    notReplayable(`git log ${A} | wc -c`);
    notReplayable(`git log ${A} | wc -l -c`);
    notReplayable(`git log ${A} | wc -l | sh`);
    notReplayable(`git log ${A} | wc -l |`);
    notReplayable(`git log ${A} |`);
    notReplayable(`git log | wc -l ${A}`);
    notReplayable(`| wc -l`);
    notReplayable(`git | wc -l`);
  });

  it("refuses an expansion, an escape, a glob, a tilde, a comment or a parenthesis", () => {
    notReplayable(`git log $REV`);
    notReplayable(`git log \${REV}`);
    notReplayable(`git log ${A} \\; x`);
    notReplayable(`git grep foo ${A} -- *.ts`);
    notReplayable(`git grep foo ${A} -- src/?`);
    notReplayable(`git grep foo ${A} -- [ab]`);
    notReplayable(`git log ${A} -- ~/x`);
    notReplayable(`git log ${A} # comment`);
    notReplayable(`(git log ${A})`);
    notReplayable(`git log {${A},${B}}`);
    notReplayable(`git log ${A} !`);
  });

  it("refuses a dollar sign, a backtick or a backslash inside double quotes", () => {
    notReplayable(`git grep "$(id)" ${A}`);
    notReplayable(`git grep "$HOME" ${A}`);
    notReplayable(`git grep "\`id\`" ${A}`);
    notReplayable(`git grep "a\\"b" ${A}`);
  });

  it("refuses a quote that is not closed", () => {
    notReplayable(`git grep 'foo ${A}`);
    notReplayable(`git grep "foo ${A}`);
    notReplayable(`git log ${A} '`);
  });

  it("refuses anything but git and a listed subcommand", () => {
    notReplayable(``);
    notReplayable(`   `);
    notReplayable(`git`);
    notReplayable(`git ${A}`);
    notReplayable(`sh -c 'git log ${A}'`);
    notReplayable(`GIT_DIR=x git log ${A}`);
    notReplayable(`/usr/bin/git log ${A}`);
    notReplayable(`git show ${A}`);
    notReplayable(`git diff ${A} ${B}`);
    notReplayable(`git config core.pager sh`);
    notReplayable(`git constructor ${A}`);
    notReplayable(`git toString ${A}`);
  });

  it("refuses a word between git and the subcommand", () => {
    notReplayable(`git -c core.pager=sh log ${A}`);
    notReplayable(`git -C .. log ${A}`);
    notReplayable(`git --git-dir=/tmp/x log ${A}`);
    notReplayable(`git --work-tree=/tmp log ${A}`);
    notReplayable(`git --exec-path=/tmp log ${A}`);
    notReplayable(`git --no-pager log ${A}`);
    notReplayable(`git -p log ${A}`);
  });

  it("refuses every option the lists leave out", () => {
    const planned: Record<string, string> = {
      "rev-list": `git rev-list ${A}`,
      log: `git log ${A}`,
      grep: `git grep foo ${A}`,
      "ls-tree": `git ls-tree ${A}`,
    };
    for (const [subcommand, command] of Object.entries(planned)) {
      expect(planReplay(command), command).not.toBeNull();
      const [head, ...tail] = command.slice(`git ${subcommand} `.length).split(" ");
      for (const option of [
        "--output=x",
        "--output",
        "--open-files-in-pager",
        "--open-files-in-pager=sh",
        "-O",
        "-Osh",
        "--ext-diff",
        "--textconv",
        "-c",
        "-C",
        "-p",
        "--exec-path=/tmp",
        "--git-dir=/tmp",
        "--work-tree=/tmp",
        "--show-signature",
        "--all",
        "--branches",
        "--stdin",
        "--no-index",
        "--untracked",
        "-",
        "-x",
        "--count=1",
        "--out",
      ]) {
        const grepOnly = subcommand === "grep" && option === "-c";
        if (grepOnly) {
          continue;
        }
        notReplayable(`git ${subcommand} ${option} ${command.slice(`git ${subcommand} `.length)}`);
        notReplayable(`git ${subcommand} ${[head, option, ...tail].join(" ")}`);
        notReplayable(`${command} ${option}`);
        notReplayable(`${command} -- ${option}`);
        notReplayable(`${command} -- src ${option} | wc -l`);
      }
    }
  });

  it("refuses an option on another subcommand's list", () => {
    notReplayable(`git log --count ${A}`);
    notReplayable(`git rev-list --oneline ${A}`);
    notReplayable(`git rev-list -5 ${A}`);
    notReplayable(`git rev-list --format=%h ${A}`);
    notReplayable(`git grep --oneline foo ${A}`);
    notReplayable(`git grep -r foo ${A}`);
    notReplayable(`git ls-tree -l ${A}`);
    notReplayable(`git ls-tree --count ${A}`);
    notReplayable(`git log -n ${A}`);
    notReplayable(`git log -n5 ${A}`);
    notReplayable(`git log -1a ${A}`);
  });

  it("refuses a format that verifies a signature", () => {
    notReplayable(`git log --format=%G? ${A}`);
    notReplayable(`git log --format='%h %GS' ${A}`);
    notReplayable(`git log --pretty=format:%GK ${A}`);
    notReplayable(`git log --pretty=tformat:%GG ${A}`);
    notReplayable(`git log "--format=%GF" ${A}`);
  });

  it("refuses a branch, a tag, HEAD or no revision", () => {
    notReplayable(`git log main`);
    notReplayable(`git log v1.0.0`);
    notReplayable(`git log HEAD`);
    notReplayable(`git log @`);
    notReplayable(`git log origin/main`);
    notReplayable(`git log ${A} main`);
    notReplayable(`git log ${A}..HEAD`);
    notReplayable(`git log HEAD..${A}`);
    notReplayable(`git log`);
    notReplayable(`git log --oneline`);
    notReplayable(`git log --oneline | wc -l`);
    notReplayable(`git log -- ${A}`);
    notReplayable(`git rev-list --count`);
    notReplayable(`git grep foo`);
    notReplayable(`git grep foo -- ${A}`);
    notReplayable(`git grep -e foo`);
    notReplayable(`git grep foo main`);
    notReplayable(`git grep -e foo bar ${A}`);
    notReplayable(`git ls-tree`);
    notReplayable(`git ls-tree -r`);
    notReplayable(`git ls-tree main ${A}`);
    notReplayable(`git ls-tree -- -r ${A}`);
  });

  it("refuses every revision shape but ids and ranges of ids", () => {
    notReplayable(`git log 012345`);
    notReplayable(`git log ${B}0`);
    notReplayable(`git log 0123abg`);
    notReplayable(`git log ${A}..`);
    notReplayable(`git log ..${A}`);
    notReplayable(`git log ${A}...`);
    notReplayable(`git log ${A}....${B}`);
    notReplayable(`git log ${A}..${B}..${C}`);
    notReplayable(`git log ^${A}`);
    notReplayable(`git log ${A}^`);
    notReplayable(`git log ${A}^^`);
    notReplayable(`git log ${A}^a`);
    notReplayable(`git log ${A}:src`);
    notReplayable(`git log ${A}@`);
    notReplayable(`git log ${A}~2`);
    notReplayable(`git log ${A}^{commit}`);
    notReplayable(`git log ${A}@{1}`);
    notReplayable(`git log :/fix`);
    notReplayable(`git log ${A},${B}`);
  });

  it("refuses an -e with no word after it, or with an unlisted option after it", () => {
    notReplayable(`git grep ${A} -e`);
    notReplayable(`git grep -e`);
    notReplayable(`git grep -e -O ${A}`);
    notReplayable(`git grep -e foo -e ${A} -e`);
  });

  it("answers without throwing whatever it is given", () => {
    for (const input of [
      "\0",
      `git log ${A}\0`,
      `git grep '\0' ${A}`,
      "é",
      `git log ${A}  `,
      "'",
      '"',
      "|",
      "||||",
      "git log --",
      "git grep -- --",
      "x".repeat(100000),
      undefined as unknown as string,
      null as unknown as string,
      42 as unknown as string,
    ]) {
      expect(() => planReplay(input)).not.toThrow();
      expect(planReplay(input)).toBeNull();
    }
  });

  it("gives the same text the same answer", () => {
    const command = `git log --format='%h %s' ${A}..${B} | wc -l`;
    expect(planReplay(command)).toEqual(planReplay(command));
    expect(planReplay(`git log ${A} > x`)).toEqual(planReplay(`git log ${A} > x`));
  });
});

describe("planReplay: purity", () => {
  it("imports no module and names no process or file", () => {
    const source = readFileSync(new URL("../../src/replay-plan.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(source).not.toMatch(/^\s*import\b/m);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\bprocess\b|child_process|node:|\bfs\b|\beval\b|\bFunction\s*\(/);
  });
});
