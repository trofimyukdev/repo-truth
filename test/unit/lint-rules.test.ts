import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as mod from "../../src/checks/lint-rules.js";
import { check, name } from "../../src/checks/lint-rules.js";

const execFileAsync = promisify(execFile);

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "Test Committer",
  GIT_COMMITTER_EMAIL: "committer@example.com",
};

type Files = Record<string, string | null>;

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args as string[], { cwd, env: ENV });
  return stdout.trim();
}

async function commit(cwd: string, files: Files, message = "change"): Promise<string> {
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

const NAMES = [
  ".eslintrc",
  ".eslintrc.json",
  ".eslintrc.yml",
  ".eslintrc.yaml",
  ".eslintrc.js",
  ".eslintrc.cjs",
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  "eslint.config.mts",
  "eslint.config.cts",
  "biome.json",
  "biome.jsonc",
  ".oxlintrc.json",
];

const F = ".eslintrc.json";
const PASS = { name: "RT-92", status: "pass", evidence: ["no lint rule turned off"] };

describe("RT-92 lint rules turned off", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "repo-truth-lint-rules-"));
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function run(
    before: Files,
    after: Files,
    extra: { message?: string; sanctions?: Record<string, string> } = {},
  ) {
    const base = await commit(repo, { "keep.txt": "keep\n", ...before }, "base");
    const candidate = await commit(repo, after, extra.message ?? "change");
    return check({ cwd: repo, base, candidate, sanctions: extra.sanctions });
  }

  const fail = (...evidence: string[]) => ({ name: "RT-92", status: "fail", evidence });

  async function sorted(before: Files, after: Files, extra = {}) {
    const record = await run(before, after, extra);
    return { ...record, evidence: [...record.evidence].sort() };
  }

  it("exports its name and no optionKinds", () => {
    expect(name).toBe("RT-92");
    expect(typeof check).toBe("function");
    expect("optionKinds" in mod).toBe(false);
  });

  it("passes a range with no change", async () => {
    expect(await run({ [F]: '{"rules":{"a":"off"}}\n' }, {})).toEqual(PASS);
  });

  for (const file of NAMES) {
    for (const dir of ["", "packages/app/"]) {
      it(`reports a rule turned off in ${dir}${file}`, async () => {
        const path = dir + file;
        const record = await run({ [path]: "a: error\n" }, { [path]: "a: off\n" });
        expect(record).toEqual(fail(`${path}: rule-off a`));
      });
    }
  }

  const values: [string, string][] = [
    ['"off"', '"r": "off"'],
    ["'off'", "'r': 'off'"],
    ["bare off", "r: off"],
    ["0", '"r": 0'],
    ['["off"]', '"r": ["off", {}]'],
    ["['off']", "'r': [ 'off' ]"],
    ["[0]", '"r": [0, {}]'],
    ["[off]", "r:[off]"],
    ["no spaces", '"r":"off"'],
    ["spaces", '"r"   :   0'],
  ];
  for (const [label, text] of values) {
    it(`reports the value ${label}`, async () => {
      expect(await run({ [F]: "{}\n" }, { [F]: `{ ${text} }\n` })).toEqual(fail(`${F}: rule-off r`));
    });
  }

  it("reads every way of writing a name", async () => {
    const record = await sorted(
      { [F]: "{}\n" },
      { [F]: '{ "@scope/plugin.rule-1": "off", \'quoted name\': 0, $bare_x.y: off, @a/b: [0] }\n' },
    );
    expect(record).toEqual(
      fail(
        `${F}: rule-off $bare_x.y`,
        `${F}: rule-off @a/b`,
        `${F}: rule-off @scope/plugin.rule-1`,
        `${F}: rule-off quoted name`,
      ),
    );
  });

  it("reports several pairs on one line", async () => {
    const record = await sorted({ [F]: "{}\n" }, { [F]: '{ "a": "off", "b": 0, c: off }\n' });
    expect(record).toEqual(fail(`${F}: rule-off a`, `${F}: rule-off b`, `${F}: rule-off c`));
  });

  it("reports a pair in a comment", async () => {
    expect(await run({ [".eslintrc.js"]: "x\n" }, { [".eslintrc.js"]: "// eqeqeq: 'off'\n" })).toEqual(
      fail(".eslintrc.js: rule-off eqeqeq"),
    );
  });

  for (const was of ['"error"', "2", '"warn"', "1"]) {
    it(`reports a rule changed from ${was} to off`, async () => {
      const record = await run({ [F]: `{ "a": ${was} }\n` }, { [F]: '{ "a": "off" }\n' });
      expect(record).toEqual(fail(`${F}: rule-off a`));
    });
  }

  for (const value of ['"warn"', '"error"', "1", "2", "0.5", "01", "offset", '"off-by-one"', "off_x", "0.", "off.x", "[1]", '["warn"]']) {
    it(`does not report the value ${value}`, async () => {
      expect(await run({ [F]: "{}\n" }, { [F]: `{ "a": ${value} }\n` })).toEqual(PASS);
    });
  }

  for (const file of ["package.json", "my.eslintrc.json", ".eslintrc.json.bak", "tsconfig.json", "x/eslint.config.json"]) {
    it(`does not read ${file}`, async () => {
      expect(await run({ [file]: "{}\n" }, { [file]: '{ "a": "off" }\n' })).toEqual(PASS);
    });
  }

  it("does not report a pair the merge base already holds, moved and re-indented", async () => {
    const before = '{\n  "rules": {\n    "a": "off",\n    "b": "error"\n  }\n}\n';
    const after = '{\n"rules": {\n"b": "error",\n        "a": "off"\n}\n}\n';
    expect(await run({ [F]: before }, { [F]: after })).toEqual(PASS);
  });

  it("reports a name turned off twice more once", async () => {
    const record = await run(
      { [F]: '{ "a": "off", "b": 1 }\n' },
      { [F]: '{ "a": "off", "a": "off", "a": 0, "b": 1 }\n' },
    );
    expect(record).toEqual(fail(`${F}: rule-off a`));
  });

  it("reports two names each once", async () => {
    const record = await sorted({ [F]: "{}\n" }, { [F]: '{ "a": 0, "a": 0, "b": 0, "b": 0 }\n' });
    expect(record).toEqual(fail(`${F}: rule-off a`, `${F}: rule-off b`));
  });

  it("reads a file the range adds whole", async () => {
    expect(await run({}, { "sub/biome.json": '{ "noExplicitAny": "off" }\n' })).toEqual(
      fail("sub/biome.json: rule-off noExplicitAny"),
    );
  });

  it("reads a file renamed onto a matching name against its source", async () => {
    const pad = "{\n  line one\n  line two\n  line three\n  line four\n";
    await commit(repo, { "keep.txt": "keep\n", "old.json": `${pad}  "a": "off",\n  "b": 1\n}\n` }, "seed");
    const base = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["mv", "old.json", ".oxlintrc.json"]);
    await writeFile(join(repo, ".oxlintrc.json"), `${pad}  "a": "off",\n  "b": 0\n}\n`);
    const candidate = await commit(repo, {});
    expect(await check({ cwd: repo, base, candidate })).toEqual(fail(".oxlintrc.json: rule-off b"));
  });

  it("does not report a rename that keeps its pairs", async () => {
    const text = '{ "a": "off", "b": 1, "c": "x", "d": 2, "e": 3 }\n';
    await commit(repo, { "keep.txt": "keep\n", ".eslintrc": text }, "seed");
    const base = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["mv", ".eslintrc", ".eslintrc.yml"]);
    const candidate = await commit(repo, {});
    expect(await check({ cwd: repo, base, candidate })).toEqual(PASS);
  });

  it("does not read a file renamed away from a matching name", async () => {
    const text = '{ "a": "off", "b": 1, "c": "x", "d": 2, "e": 3 }\n';
    await commit(repo, { "keep.txt": "keep\n", ".eslintrc": text }, "seed");
    const base = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["mv", ".eslintrc", "eslintrc.txt"]);
    const candidate = await commit(repo, {});
    expect(await check({ cwd: repo, base, candidate })).toEqual(PASS);
  });

  it("is sanctioned by a commit message line, with the reason", async () => {
    const record = await run(
      { [F]: "{}\n" },
      { [F]: '{ "a": "off" }\n' },
      { message: `change\n\nSanctioned-Weakening: rule-off:${F} legacy code\n` },
    );
    expect(record).toEqual({ name: "RT-92", status: "pass", evidence: [`${F}: rule-off a - sanctioned: legacy code`] });
  });

  it("is sanctioned by the caller's sanctions", async () => {
    const record = await run({ [F]: "{}\n" }, { [F]: '{ "a": "off" }\n' }, { sanctions: { [`rule-off:${F}`]: "agreed" } });
    expect(record).toEqual({ name: "RT-92", status: "pass", evidence: [`${F}: rule-off a - sanctioned: agreed`] });
  });

  it("is not sanctioned by a line naming another file or with no reason", async () => {
    const other = await run(
      { [F]: "{}\n" },
      { [F]: '{ "a": "off" }\n' },
      { message: "change\n\nSanctioned-Weakening: rule-off:other/.eslintrc.json reason\n" },
    );
    expect(other).toEqual(fail(`${F}: rule-off a`));
  });

  it("is not sanctioned by a line with no reason", async () => {
    const record = await run(
      { [F]: "{}\n" },
      { [F]: '{ "a": "off" }\n' },
      { message: `change\n\nSanctioned-Weakening: rule-off:${F}\n` },
    );
    expect(record).toEqual(fail(`${F}: rule-off a`));
  });

  it("sanctions every finding of the file", async () => {
    const record = await sorted(
      { [F]: "{}\n" },
      { [F]: '{ "a": "off", "b": 0 }\n' },
      { message: `change\n\nSanctioned-Weakening: rule-off:${F} why\n` },
    );
    expect(record).toEqual({
      name: "RT-92",
      status: "pass",
      evidence: [`${F}: rule-off a - sanctioned: why`, `${F}: rule-off b - sanctioned: why`],
    });
  });

  it("reads from the merge base, not the other side's additions", async () => {
    const root = await commit(repo, { "keep.txt": "keep\n", [F]: '{ "a": 1 }\n' }, "root");
    await git(repo, ["checkout", "--quiet", "-b", "side"]);
    const side = await commit(repo, { [F]: '{ "a": 1, "z": "off" }\n' }, "side");
    await git(repo, ["checkout", "--quiet", "main"]);
    const tip = await commit(repo, { "other.txt": "x\n" }, "tip");
    expect(await check({ cwd: repo, base: side, candidate: tip })).toEqual(PASS);
    expect(await check({ cwd: repo, base: tip, candidate: side })).toEqual(fail(`${F}: rule-off z`));
    expect(root).not.toBe(side);
  });

  it("fails naming the cause for a revision that names no commit", async () => {
    const base = await commit(repo, { "keep.txt": "keep\n" }, "base");
    const record = await check({ cwd: repo, base, candidate: "no-such-revision" });
    expect(record.name).toBe("RT-92");
    expect(record.status).toBe("fail");
    expect(record.evidence).toHaveLength(1);
    expect(record.evidence[0]).toContain("no-such-revision");
    const dash = await check({ cwd: repo, base: "--all", candidate: base });
    expect(dash.status).toBe("fail");
  });

  it("fails rather than throws when git fails", async () => {
    const record = await check({ cwd: join(repo, "missing"), base: "HEAD", candidate: "HEAD" });
    expect(record.status).toBe("fail");
  });
});
