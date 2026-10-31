import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { check, name } from "../../src/checks/bidi-controls.js";
import { SANCTION_KEY } from "../../src/weakened-tests.js";

const execFileAsync = promisify(execFile);

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "Test Committer",
  GIT_COMMITTER_EMAIL: "committer@example.com",
};

const NINE: [string, string][] = [
  ["U+202A", "‪"],
  ["U+202B", "‫"],
  ["U+202C", "‬"],
  ["U+202D", "‭"],
  ["U+202E", "‮"],
  ["U+2066", "⁦"],
  ["U+2067", "⁧"],
  ["U+2068", "⁨"],
  ["U+2069", "⁩"],
];
const PASS = ["no bidirectional control character added"];

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args as string[], { cwd, env: ENV });
  return stdout.trim();
}

async function commit(cwd: string, files: Record<string, string | Buffer | null>, message = "change"): Promise<string> {
  for (const [file, content] of Object.entries(files)) {
    if (content === null) await rm(join(cwd, file));
    else {
      await mkdir(dirname(join(cwd, file)), { recursive: true });
      await writeFile(join(cwd, file), content);
    }
  }
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "--quiet", "--allow-empty", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

describe("RT-93 bidirectional controls", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "repo-truth-bidi-"));
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const run = (base: string, candidate = "HEAD", sanctions?: Record<string, string>) =>
    check({ cwd: repo, base, candidate, sanctions });
  const failing = (file: string, characters: string) => ({
    name,
    status: "fail",
    evidence: [`${file}: bidi-control ${characters}`],
    findings: [{ id: `bidi-control:${file}`, category: "bidi-control", file, characters: characters.split(","), sanction: null }],
  });

  it("is named RT-93", () => {
    expect(name).toBe("RT-93");
  });

  for (const [label, char] of NINE) {
    for (const file of ["a.ts", "src/deep/a.ts"]) {
      it(`fails a file added with ${label} at ${file}`, async () => {
        const base = await commit(repo, { "keep.txt": "x\n" });
        await commit(repo, { [file]: `let a = 1; /*${char}*/\n` });
        expect(await run(base)).toEqual(failing(file, label));
      });
      it(`fails a file changed with ${label} at ${file}`, async () => {
        const base = await commit(repo, { [file]: "let a = 1;\n" });
        await commit(repo, { [file]: `let a = 1;\nlet b = "${char}";\n` });
        expect(await run(base)).toEqual(failing(file, label));
      });
    }
  }

  it("names several characters once each, ascending, in one finding", async () => {
    const base = await commit(repo, { "a.ts": "x\n" });
    await commit(repo, { "a.ts": "x\n⁩ ⁦ ‮\n‮ again ⁦\n" });
    expect(await run(base)).toEqual(failing("a.ts", "U+202E,U+2066,U+2069"));
  });

  it("passes lines holding other invisible characters and right-to-left letters", async () => {
    const base = await commit(repo, { "a.ts": "x\n" });
    await commit(repo, { "a.ts": "x\n‎\n‏\n؜\n​\n‍\n﻿\nאבג ال\n" });
    expect(await run(base)).toEqual({ name, status: "pass", evidence: PASS, findings: [] });
  });

  it("passes a range that adds nothing", async () => {
    const base = await commit(repo, { "a.ts": "x\n" });
    expect((await run(base)).evidence).toEqual(PASS);
    expect((await run("HEAD")).status).toBe("pass");
  });

  it("does not read a line the merge base already holds, moved or re-indented", async () => {
    const line = "let a = 1; // ‮";
    const base = await commit(repo, { "a.ts": `${line}\nlet b = 2;\n` });
    await commit(repo, { "a.ts": `let b = 2;\n    ${line}\r\n` });
    expect((await run(base)).status).toBe("pass");
  });

  it("reads a line added more often than the merge base held it", async () => {
    const line = "let a = 1; // ⁧";
    const base = await commit(repo, { "a.ts": `${line}\n` });
    await commit(repo, { "a.ts": `${line}\n${line}\n` });
    expect(await run(base)).toEqual(failing("a.ts", "U+2067"));
  });

  it("does not read a removed line", async () => {
    const base = await commit(repo, { "a.ts": "let a = 1; // ‮\nlet b = 2;\n" });
    await commit(repo, { "a.ts": "let b = 2;\n" });
    expect((await run(base)).status).toBe("pass");
    await commit(repo, { "a.ts": null });
    expect((await run(base)).status).toBe("pass");
  });

  it("reads a renamed file against its source", async () => {
    const body = ["one", "two", "three", "let a = 1; // ‮", "four", "five", "six", ""].join("\n");
    const base = await commit(repo, { "old/a.ts": body });
    await git(repo, ["mv", "old/a.ts", "new.ts"]);
    await commit(repo, {});
    expect((await run(base)).status).toBe("pass");
    await commit(repo, { "new.ts": `${body}let c = "⁨";\n` });
    expect(await run(base)).toEqual(failing("new.ts", "U+2068"));
  });

  it("does not read a file holding a NUL byte, and counts such a source as none", async () => {
    const base = await commit(repo, { "bin.dat": Buffer.from("x\0\n"), "src.ts": Buffer.from("// ‮\0\n") });
    await commit(repo, { "bin.dat": Buffer.from("x\0\n// ‮\n"), "src.ts": "// ‮\n" });
    expect(await run(base)).toEqual(failing("src.ts", "U+202E"));
  });

  it("does not read a symbolic link or a gitlink", async () => {
    const base = await commit(repo, { "keep.txt": "x\n" });
    await writeFile(join(repo, "target.txt"), "// ‮\n");
    await symlink("target.txt", join(repo, "link.ts"));
    const sha = await git(repo, ["rev-parse", base]);
    await git(repo, ["update-index", "--add", "--cacheinfo", `160000,${sha},sub`]);
    await git(repo, ["add", "link.ts"]);
    await git(repo, ["commit", "--quiet", "-m", "links"]);
    expect(await run(base)).toEqual({ name, status: "pass", evidence: PASS, findings: [] });
  });

  it("is passed by a commit message line, or by the caller's sanctions, naming the file", async () => {
    const base = await commit(repo, { "keep.txt": "x\n" });
    await commit(repo, { "a.ts": "// ‮\n" }, `add\n\n${SANCTION_KEY}: bidi-control:a.ts right-to-left fixture`);
    expect(await run(base)).toEqual({
      name,
      status: "pass",
      evidence: ["a.ts: bidi-control U+202E - sanctioned: right-to-left fixture"],
      findings: [{ id: "bidi-control:a.ts", category: "bidi-control", file: "a.ts", characters: ["U+202E"], sanction: "right-to-left fixture" }],
    });
    const given = await run(base, "HEAD", { "bidi-control:a.ts": "by hand" });
    expect(given.status).toBe("pass");
    expect(given.evidence).toEqual(["a.ts: bidi-control U+202E - sanctioned: by hand"]);
  });

  it("is not passed by a line naming another file or giving no reason", async () => {
    const base = await commit(repo, { "keep.txt": "x\n" });
    await commit(repo, { "a.ts": "// ‮\n" }, `add\n\n${SANCTION_KEY}: bidi-control:b.ts reason\n${SANCTION_KEY}: bidi-control:a.ts`);
    expect(await run(base)).toEqual(failing("a.ts", "U+202E"));
  });

  it("does not read what the other side added after the merge base", async () => {
    const base = await commit(repo, { "keep.txt": "x\n" });
    await git(repo, ["checkout", "--quiet", "-b", "other"]);
    const other = await commit(repo, { "o.ts": "// ‮\n" });
    await git(repo, ["checkout", "--quiet", "main"]);
    await commit(repo, { "m.ts": "let m = 1;\n" });
    expect(await run(other)).toEqual({ name, status: "pass", evidence: PASS, findings: [] });
    expect(base).not.toBe(other);
  });

  it("fails, naming the cause, for a revision that names no commit", async () => {
    await commit(repo, { "keep.txt": "x\n" });
    const record = await run("no-such-revision");
    expect(record.status).toBe("fail");
    expect(record.findings).toEqual([]);
    expect(record.evidence).toHaveLength(1);
    expect(record.evidence[0]).toContain('revision "no-such-revision" does not name a commit');
  });

  it("escapes a file name outside printable ASCII", async () => {
    const base = await commit(repo, { "keep.txt": "x\n" });
    await commit(repo, { "café.ts": "// ‮\n" });
    const record = await run(base);
    expect(record.evidence).toEqual(["caf\\u{00e9}.ts: bidi-control U+202E"]);
  });
});
