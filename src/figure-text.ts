/**
 * Claim text: the figure claims one page or one commit body holds.
 *
 * A measured figure is written in one form: a git command in a code span, the
 * word `printed`, and the output in a code span. This reads that form in a
 * text. It is pure: no git, no file, no process, no import. Code spans are
 * read as CommonMark reads them: a backslash before ASCII punctuation outside
 * a span escapes it, and inside a span a backslash is an ordinary character.
 */

/** One figure claim found in a text. */
export interface FigureTextClaim {
  /** The line, counted from 1, on which the claimed output's code span opens. */
  line: number;
  /** The text of the command's code span. */
  command: string;
  /** The text of the claimed output's code span. */
  claimed: string;
}

/** A page is read by its paragraphs, a commit body as one block. */
export type FigureBlocks = "paragraphs" | "whole";

const WORD = "printed";
const ESCAPABLE = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
const WORD_CHARACTER = /^[\p{L}\p{N}_]$/u;

interface Block {
  text: string;
  firstLine: number;
}

/** Split into lines at a line feed; a carriage return just before one is dropped. */
function linesOf(text: string): string[] {
  const lines = text.split("\n");
  return lines.map((line, index) => (index < lines.length - 1 && line.endsWith("\r") ? line.slice(0, -1) : line));
}

function blocksOf(text: string, blocks: FigureBlocks): Block[] {
  const lines = linesOf(text);
  if (blocks !== "paragraphs") return [{ text: lines.join("\n"), firstLine: 1 }];
  const found: Block[] = [];
  let current: string[] = [];
  let first = 1;
  lines.forEach((line, index) => {
    if (/^[ \t]*$/.test(line)) {
      if (current.length > 0) found.push({ text: current.join("\n"), firstLine: first });
      current = [];
    } else {
      if (current.length === 0) first = index + 1;
      current.push(line);
    }
  });
  if (current.length > 0) found.push({ text: current.join("\n"), firstLine: first });
  return found;
}

/** The length of the backtick string that starts at `from`. */
function runLength(text: string, from: number): number {
  let end = from;
  while (text[end] === "`") end += 1;
  return end - from;
}

/** The content of a code span, read as CommonMark reads it. */
function spanContent(raw: string): string {
  const content = raw.replace(/\n/g, " ");
  if (content.length >= 2 && content.startsWith(" ") && content.endsWith(" ") && /[^ ]/.test(content)) {
    return content.slice(1, -1);
  }
  return content;
}

function claimsInBlock(block: Block): FigureTextClaim[] {
  const { text } = block;
  const claims: FigureTextClaim[] = [];
  let command: string | undefined;
  let commandAtWord: string | undefined;
  let claimStart = -1;
  let i = 0;
  while (i < text.length) {
    const char = text[i] as string;
    if (char === "\\") {
      i += ESCAPABLE.includes(text[i + 1] ?? "") ? 2 : 1;
    } else if (char === "`") {
      const length = runLength(text, i);
      let search = i + length;
      let close = -1;
      while (search < text.length) {
        if (text[search] !== "`") {
          search += 1;
          continue;
        }
        const other = runLength(text, search);
        if (other === length) {
          close = search;
          break;
        }
        search += other;
      }
      if (close < 0) {
        i += length;
        continue;
      }
      const content = spanContent(text.slice(i + length, close));
      if (i === claimStart && commandAtWord !== undefined) {
        const line = block.firstLine + (text.slice(0, i).match(/\n/g)?.length ?? 0);
        claims.push({ line, command: commandAtWord, claimed: content });
      }
      claimStart = -1;
      if (content.startsWith("git ")) command = content;
      i = close + length;
    } else if (text.startsWith(WORD, i) && !WORD_CHARACTER.test(text[i - 1] ?? "")) {
      const wordEnd = i + WORD.length;
      let end = wordEnd;
      while (text[end] === " ") end += 1;
      commandAtWord = command;
      claimStart = end > wordEnd && command !== undefined ? end : -1;
      i = wordEnd;
    } else {
      i += 1;
    }
  }
  return claims;
}

/** The figure claims in `text`, in the order their claimed outputs appear. */
export function claimsInText(text: string, blocks: FigureBlocks): FigureTextClaim[] {
  if (typeof text !== "string") return [];
  return blocksOf(text, blocks).flatMap(claimsInBlock);
}
