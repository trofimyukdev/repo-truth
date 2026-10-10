/**
 * Replay plans.
 *
 * A page or a commit quotes a git command beside a figure, and RT-19 runs
 * that command again to see whether the figure still holds. A line of
 * documentation is text anybody can write, so this module decides which
 * command text may run at all, and it decides by lists of what is safe,
 * never by a list of what is dangerous:
 *
 * - the text is split into words the way a POSIX shell splits it, with
 *   nothing expanded; anything a shell would read as a second command, a
 *   redirection, a substitution, an expansion or a glob ends the decision;
 * - the words are `git`, one of a fixed set of read-only subcommands, and
 *   then only options on that subcommand's list, a lone `--`, or arguments
 *   that do not begin with a minus sign, optionally piped to `wc -l`;
 * - every revision names a commit by its id, so the answer is the same on
 *   any clone, whatever its branches, tags and `HEAD`.
 *
 * The decision is pure: it starts no process, reads and writes no file and
 * imports nothing. A command it does not plan is not replayable, which is an
 * answer and never an error.
 */

/** What RT-19 runs for a replayable command. */
export interface ReplayPlan {
  /** The command's words after `git` and before its pipe, quotes removed. */
  readonly args: readonly string[];
  /** Whether the command ends with `| wc -l`. */
  readonly countLines: boolean;
  /** Every commit id the revisions name, each once, in order of first naming. */
  readonly commits: readonly string[];
}

type Token = { readonly kind: "word"; readonly text: string } | { readonly kind: "pipe" };

/** The characters a word may hold outside quotes. */
const BARE = /^[A-Za-z0-9.\-_/:=^@,%]$/;

/** What a double-quoted part may not hold: a shell expands or escapes these. */
const DOUBLE_QUOTE_UNSAFE = /[$`\\]/;

/** A commit id, optionally with a caret and digits after it. */
const ID = "([0-9a-fA-F]{7,40})(?:\\^[0-9]+)?";

/** A revision: an id, or two ids joined by `..` or `...`. */
const REVISION = new RegExp(`^${ID}(?:\\.\\.\\.?${ID})?$`);

const REV_LIST_OPTIONS = new Set(["--count", "--merges", "--no-merges", "--first-parent", "--reverse"]);

const LOG_OPTIONS = new Set(["--oneline", "--merges", "--no-merges", "--first-parent", "--reverse"]);

const GREP_OPTIONS = new Set(["-c", "-l", "-n", "-E", "-F", "-i", "-w", "-e", "--count", "--files-with-matches"]);

const LS_TREE_OPTIONS = new Set(["-r", "-d", "-t", "--name-only", "--full-tree"]);

function isLogOption(option: string): boolean {
  if (LOG_OPTIONS.has(option) || /^-[0-9]+$/.test(option) || option.startsWith("--date=")) {
    return true;
  }
  // `%G` verifies a signature, and verifying one starts a program.
  return (option.startsWith("--format=") || option.startsWith("--pretty=")) && !option.includes("%G");
}

/** Each subcommand that may be replayed, and the options it is planned with. */
const SUBCOMMANDS = new Map<string, (option: string) => boolean>([
  ["rev-list", (option) => REV_LIST_OPTIONS.has(option)],
  ["log", isLogOption],
  ["grep", (option) => GREP_OPTIONS.has(option)],
  ["ls-tree", (option) => LS_TREE_OPTIONS.has(option)],
]);

/**
 * Split a command into words and pipes as a POSIX shell would, expanding
 * nothing. Returns null for anything a shell would read as more than words
 * and pipes, and for a quote that is not closed.
 */
function tokenize(command: string): Token[] | null {
  const tokens: Token[] = [];
  let word: string | null = null;
  const endWord = (): void => {
    if (word !== null) {
      tokens.push({ kind: "word", text: word });
      word = null;
    }
  };
  let i = 0;
  while (i < command.length) {
    const c = command[i] as string;
    if (c === " " || c === "\t") {
      endWord();
      i += 1;
    } else if (c === "|") {
      endWord();
      tokens.push({ kind: "pipe" });
      i += 1;
    } else if (c === "'" || c === '"') {
      const close = command.indexOf(c, i + 1);
      if (close < 0) {
        return null;
      }
      const part = command.slice(i + 1, close);
      if (c === '"' && DOUBLE_QUOTE_UNSAFE.test(part)) {
        return null;
      }
      word = (word ?? "") + part;
      i = close + 1;
    } else if (BARE.test(c)) {
      word = (word ?? "") + c;
      i += 1;
    } else {
      return null;
    }
  }
  endWord();
  return tokens;
}

function isWord(token: Token | undefined, text: string): boolean {
  return token !== undefined && token.kind === "word" && token.text === text;
}

/**
 * Decide whether a quoted git command may be run again, and with what.
 * Returns null when it is not replayable; never throws.
 */
export function planReplay(command: string): ReplayPlan | null {
  if (typeof command !== "string" || command.includes("\0")) {
    return null;
  }
  const tokens = tokenize(command);
  if (tokens === null) {
    return null;
  }

  let body = tokens;
  let countLines = false;
  const pipes = tokens.filter((token) => token.kind === "pipe").length;
  if (pipes > 1) {
    return null;
  }
  if (pipes === 1) {
    const n = tokens.length;
    if (tokens[n - 3]?.kind !== "pipe" || !isWord(tokens[n - 2], "wc") || !isWord(tokens[n - 1], "-l")) {
      return null;
    }
    body = tokens.slice(0, n - 3);
    countLines = true;
  }

  const words = body.map((token) => (token.kind === "word" ? token.text : "|"));
  if (words[0] !== "git" || words.length < 2) {
    return null;
  }
  const subcommand = words[1] as string;
  const isOption = SUBCOMMANDS.get(subcommand);
  if (isOption === undefined) {
    return null;
  }

  // Arguments before the first lone `--`, and every word after it, in order.
  const before: string[] = [];
  const after: string[] = [];
  let dashDash = false;
  let patternGiven = false;
  const rest = words.slice(2);
  for (let k = 0; k < rest.length; k += 1) {
    const word = rest[k] as string;
    if (word === "--" && !dashDash) {
      dashDash = true;
      continue;
    }
    if (word.startsWith("-") && word !== "--" && !isOption(word)) {
      return null;
    }
    if (dashDash) {
      after.push(word);
      continue;
    }
    if (word.startsWith("-")) {
      if (subcommand === "grep" && word === "-e") {
        const pattern = rest[k + 1];
        if (pattern === undefined || (pattern.startsWith("-") && pattern !== "--" && !isOption(pattern))) {
          return null;
        }
        patternGiven = true;
        k += 1;
      }
      continue;
    }
    before.push(word);
  }

  let revisions: string[];
  if (subcommand === "ls-tree") {
    const first = before[0] ?? after[0];
    revisions = first === undefined ? [] : [first];
  } else if (subcommand === "grep" && !patternGiven) {
    revisions = before.slice(1);
  } else {
    revisions = before;
  }
  if (revisions.length === 0) {
    return null;
  }

  const commits: string[] = [];
  for (const revision of revisions) {
    const match = REVISION.exec(revision);
    if (match === null) {
      return null;
    }
    for (const id of [match[1], match[2]]) {
      if (id !== undefined && !commits.includes(id)) {
        commits.push(id);
      }
    }
  }

  return { args: words.slice(1), countLines, commits };
}
