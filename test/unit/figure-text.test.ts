import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { claimsInText } from "../../src/figure-text.js";

const claim = (line: number, command: string, claimed: string) => ({ line, command, claimed });
const page = (text: string) => claimsInText(text, "paragraphs");
const body = (text: string) => claimsInText(text, "whole");

describe("claimsInText form", () => {
  it("reads the plain form", () => {
    expect(page("`git log -1` printed `abc`")).toEqual([claim(1, "git log -1", "abc")]);
    expect(body("`git log -1` printed `abc`")).toEqual([claim(1, "git log -1", "abc")]);
  });
  it("takes several spaces, not tabs or line breaks", () => {
    expect(page("`git a` printed    `x`")).toEqual([claim(1, "git a", "x")]);
    expect(page("`git a` printed\t`x`")).toEqual([]);
    expect(page("`git a` printed\n`x`")).toEqual([]);
    expect(page("`git a` printed")).toEqual([]);
    expect(page("`git a` printed `unclosed")).toEqual([]);
    expect(page("`git a` printed x `y`")).toEqual([]);
    expect(page("`git a` printed`x`")).toEqual([]);
  });
  it("needs the word outside code and not inside another word", () => {
    expect(page("`git a` `printed` `x`")).toEqual([]);
    expect(page("`git a` reprinted `x`")).toEqual([]);
    expect(page("`git a` _printed `x`")).toEqual([]);
    expect(page("`git a`printed `x`")).toEqual([claim(1, "git a", "x")]);
    expect(page("`git a` (printed `x`")).toEqual([claim(1, "git a", "x")]);
  });
  it("needs a command beginning with git and a space", () => {
    expect(page("`gitx a` printed `x`")).toEqual([]);
    expect(page("`git` printed `x`")).toEqual([]);
    expect(page("printed `x`")).toEqual([]);
    expect(page("`ls` printed `x`")).toEqual([]);
  });
  it("takes the nearest git span before the word", () => {
    expect(page("`git a` and `ls` and `git b` then `echo` printed `x`")).toEqual([claim(1, "git b", "x")]);
    expect(page("`git a` printed `git b` printed `y`")).toEqual([claim(1, "git a", "git b"), claim(1, "git b", "y")]);
  });
  it("makes many claims in a block", () => {
    expect(page("`git a` printed `1`\n`git b` printed `2`")).toEqual([claim(1, "git a", "1"), claim(2, "git b", "2")]);
  });
  it("keeps a command in another paragraph from a page, not from a body", () => {
    const text = "`git a`\n\nprinted `x`";
    expect(page(text)).toEqual([]);
    expect(body(text)).toEqual([claim(3, "git a", "x")]);
    const spaced = "`git a`\n \t \nprinted `x`";
    expect(page(spaced)).toEqual([]);
    expect(body(spaced)).toEqual([claim(3, "git a", "x")]);
    expect(page("`git a`\n  \nprinted `x`\n\n`git b` printed `y`")).toEqual([claim(5, "git b", "y")]);
  });
});

describe("claimsInText lines", () => {
  it("counts from 1 on the line the output opens", () => {
    expect(page("one\n\n`git a` printed `x`")).toEqual([claim(3, "git a", "x")]);
    expect(page("`git a` printed `x\ny`")).toEqual([claim(1, "git a", "x y")]);
    expect(page("`git\na` printed `x`")).toEqual([claim(2, "git a", "x")]);
  });
  it("drops a carriage return before a line feed", () => {
    expect(page("a\r\n\r\n`git a` printed `x`\r\n")).toEqual([claim(3, "git a", "x")]);
    expect(body("a\r\n\r\n`git a` printed `x`\r\n")).toEqual([claim(3, "git a", "x")]);
    expect(page("`git a`\r\n\r\nprinted `x`")).toEqual([]);
    expect(page("`git a` printed `x\r\ny`")).toEqual([claim(1, "git a", "x y")]);
    expect(page("`git a` printed `x`\r")).toEqual([claim(1, "git a", "x")]);
  });
});

describe("claimsInText code spans", () => {
  it("closes on a string of the same length only", () => {
    expect(page("`git a` printed ``x ` y``")).toEqual([claim(1, "git a", "x ` y")]);
    expect(page("`git a` printed ```x `` y```")).toEqual([claim(1, "git a", "x `` y")]);
    expect(page("`git a` printed `x`` y`")).toEqual([claim(1, "git a", "x`` y")]);
  });
  it("reads a string with no closing string as text and goes on", () => {
    expect(page("``` `git a` printed `x`")).toEqual([claim(1, "git a", "x")]);
    expect(page("`` `git a` printed `x`")).toEqual([claim(1, "git a", "x")]);
    expect(page("```a `b` ``c`` `git a` printed `x`")).toEqual([claim(1, "git a", "x")]);
  });
  it("reads interleaved strings", () => {
    expect(page("`a ``b` `git a` printed ``x``")).toEqual([claim(1, "git a", "x")]);
    expect(page("`` `git a` `` printed `x`")).toEqual([]);
    expect(page("```` `git a` printed `x` ``` ````")).toEqual([]);
  });
  it("strips one space at each end, not from all-space content", () => {
    expect(page("`git a` printed `` x ``")).toEqual([claim(1, "git a", "x")]);
    expect(page("`git a` printed ``  x  ``")).toEqual([claim(1, "git a", " x ")]);
    expect(page("`git a` printed `  `")).toEqual([claim(1, "git a", "  ")]);
    expect(page("`git a` printed ` `")).toEqual([claim(1, "git a", " ")]);
    expect(page("`git a` printed ` x`")).toEqual([claim(1, "git a", " x")]);
    expect(page("`git a` printed `x `")).toEqual([claim(1, "git a", "x ")]);
    expect(page("`git a` printed `\nx\n`")).toEqual([claim(1, "git a", "x")]);
    expect(page("` git a ` printed `x`")).toEqual([claim(1, "git a", "x")]);
  });
  it("reads a span broken across two lines", () => {
    expect(page("`git\nlog` printed `x`")).toEqual([claim(2, "git log", "x")]);
  });
});

describe("claimsInText backslashes", () => {
  it("lets an escaping backslash keep a backtick from opening a span", () => {
    expect(page("\\`git a` printed `x`")).toEqual([]);
    expect(page("\\`not code and `git a` printed `x`")).toEqual([claim(1, "git a", "x")]);
  });
  it("lets an escaped backslash escape nothing", () => {
    expect(page("\\\\`git log -1 abc1234` printed `x`")).toEqual([claim(1, "git log -1 abc1234", "x")]);
    expect(page("\\\\\\`git a` printed `x`")).toEqual([]);
  });
  it("keeps a backslash before a non-punctuation character", () => {
    expect(page("\\a`git a` printed `x`")).toEqual([claim(1, "git a", "x")]);
    expect(page("`git a` printed \\")).toEqual([]);
  });
  it("reads a backslash inside a span as a character", () => {
    expect(page("`foo\\`bar `git a` printed `x`")).toEqual([claim(1, "git a", "x")]);
    expect(page("`git a\\` printed `x`")).toEqual([claim(1, "git a\\", "x")]);
    expect(page("`git a` printed `x\\`")).toEqual([claim(1, "git a", "x\\")]);
  });
  it("finds no claim in the first review's own text", () => {
    expect(page("a\\`git log` printed `9`")).toEqual([]);
    expect(body("a\\`git log` printed `9`")).toEqual([]);
  });
});

describe("claimsInText unescaped characters, leading breaks, odd input", () => {
  it("reads a backslash before a non-punctuation character as itself", () => {
    expect(page("`git a` \\printed `x`")).toEqual([claim(1, "git a", "x")]);
    expect(body("`git a` \\printed `x`")).toEqual([claim(1, "git a", "x")]);
    expect(page("`git a` printed \\`x`")).toEqual([]);
  });
  it("counts a line break that opens the text", () => {
    expect(body("\n`git a` printed `x`")).toEqual([claim(2, "git a", "x")]);
    expect(body("\n\n`git a` printed `x`")).toEqual([claim(3, "git a", "x")]);
    expect(page("\n`git a` printed `x`")).toEqual([claim(2, "git a", "x")]);
    expect(page("\n\n`git a` printed `x`")).toEqual([claim(3, "git a", "x")]);
  });
  it("answers text that is not a string with no claims", () => {
    for (const odd of [undefined, 7, null, {}, ["`git a` printed `x`"]]) {
      expect(claimsInText(odd as unknown as string, "paragraphs")).toEqual([]);
      expect(claimsInText(odd as unknown as string, "whole")).toEqual([]);
    }
  });
});

describe("claimsInText edges", () => {
  it("answers empty and backtick-free text", () => {
    expect(page("")).toEqual([]);
    expect(body("")).toEqual([]);
    expect(page("git log printed 9")).toEqual([]);
    expect(page("\n\n\n")).toEqual([]);
  });
  it("answers the same twice and does not throw", () => {
    const text = "`git a` printed `x`\n```\n\\\r\n`";
    expect(page(text)).toEqual(page(text));
    for (const odd of ["`", "``", "\\", "\r", "printed", "`git ` printed ` `", "\u0000"]) {
      expect(() => page(odd)).not.toThrow();
      expect(() => body(odd)).not.toThrow();
    }
  });
  it("imports no module", async () => {
    const source = await readFile(new URL("../../src/figure-text.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/from\s+["']/);
  });
});
