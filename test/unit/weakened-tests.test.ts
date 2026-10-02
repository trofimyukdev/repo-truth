import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SANCTION_KEY,
  WEAKENING_SPELLINGS,
  checkWeakenedTests,
  type MarkerSpelling,
  type WeakenedTestsOptions,
} from "../../src/weakened-tests.js";

const execFileAsync = promisify(execFile);

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "Test Committer",
  GIT_COMMITTER_EMAIL: "committer@example.com",
};

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args as string[], { cwd, env: ENV });
  return stdout.trim();
}

const SUITE = [
  'import { expect, it } from "vitest";',
  "",
  'it("adds", () => {',
  "  expect(1 + 1).toBe(2);",
  "  expect(2 + 2).toBe(4);",
  "});",
  "",
  'it("subtracts", () => {',
  "  expect(2 - 1).toBe(1);",
  "});",
  "",
].join("\n");

describe("WEAKENING_SPELLINGS", () => {
  it("documents every marker with a category, a scope and an example its pattern matches", () => {
    expect(WEAKENING_SPELLINGS.markers.length).toBeGreaterThan(0);
    for (const marker of WEAKENING_SPELLINGS.markers) {
      expect(["skip", "only"]).toContain(marker.category);
      expect(marker.scope.length).toBeGreaterThan(0);
      for (const scope of marker.scope) {
        expect(["test", "config", "any"]).toContain(scope);
      }
      expect(marker.pattern).toBeInstanceOf(RegExp);
      expect(marker.pattern.test(marker.example)).toBe(true);
    }
    const categories = new Set(WEAKENING_SPELLINGS.markers.map((marker) => marker.category));
    expect(categories).toEqual(new Set(["skip", "only"]));
  });

  it("knows *.test.ts and *.spec.ts as test files, and not plain source", () => {
    const isTest = (path: string) => WEAKENING_SPELLINGS.testFiles.some((pattern) => pattern.test(path));
    expect(isTest("test/unit/a.test.ts")).toBe(true);
    expect(isTest("src/b.spec.ts")).toBe(true);
    expect(isTest("src/a.ts")).toBe(false);
    expect(isTest("src/latest.ts")).toBe(false);
  });

  it("is frozen, so no consumer edits the shared table in place", () => {
    expect(Object.isFrozen(WEAKENING_SPELLINGS)).toBe(true);
    expect(Object.isFrozen(WEAKENING_SPELLINGS.markers)).toBe(true);
  });
});

describe("checkWeakenedTests", () => {
  let repo: string;
  let base: string;

  async function put(path: string, content: string): Promise<void> {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  }

  async function commit(message: string): Promise<string> {
    await git(repo, ["add", "--all"]);
    await git(repo, ["commit", "--quiet", "--allow-empty", "-m", message]);
    return git(repo, ["rev-parse", "HEAD"]);
  }

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "repo-truth-weakened-"));
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
    await put("test/math.test.ts", SUITE);
    await put("src/math.ts", "export const one = 1;\n");
    base = await commit("initial");
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const run = (extra: Partial<WeakenedTestsOptions> = {}) =>
    checkWeakenedTests({ cwd: repo, base, candidate: "HEAD", ...extra });

  it("passes an empty range with no findings", async () => {
    const record = await run();
    expect(record.name).toBe("RT-04");
    expect(record.status).toBe("pass");
    expect(record.findings).toEqual([]);
    expect(record.evidence.join("\n")).toContain("lowers");
  });

  it("passes a range that only strengthens the suite", async () => {
    await put("test/math.test.ts", SUITE + 'it("multiplies", () => {\n  expect(2 * 2).toBe(4);\n});\n');
    await put("src/math.ts", "export const one = 1;\nexport const two = 2;\n");
    await commit("more tests");
    const record = await run();
    expect(record.status).toBe("pass");
    expect(record.findings).toEqual([]);
  });

  it("reports a skip the range adds, with file, line, side and id", async () => {
    await put("test/math.test.ts", SUITE.replace('it("subtracts"', 'it.skip("subtracts"'));
    await commit("skip");
    const record = await run();
    expect(record.status).toBe("fail");
    expect(record.findings).toEqual([
      {
        id: "skip:test/math.test.ts:8",
        category: "skip",
        file: "test/math.test.ts",
        line: 8,
        side: "candidate",
        detail: expect.stringContaining('it.skip("subtracts"'),
        sanction: null,
      },
    ]);
    expect(record.evidence.join("\n")).toContain("skip:test/math.test.ts:8 [skip]");
    expect(record.evidence.join("\n")).toContain("not sanctioned");
  });

  it("reports nothing for a skip that predates the range", async () => {
    await put("test/math.test.ts", SUITE.replace('it("subtracts"', 'it.skip("subtracts"'));
    base = await commit("skip, before the range");
    await put("test/math.test.ts", SUITE.replace('it("subtracts"', 'it.skip("subtracts"') + "// touched\n");
    await commit("touch the file");
    const record = await run();
    expect(record.status).toBe("pass");
    expect(record.findings).toEqual([]);
  });

  it("reports nothing for a marker line the range only moves", async () => {
    const skipped = SUITE.replace('it("subtracts"', 'it.skip("subtracts"');
    await put("test/math.test.ts", skipped);
    base = await commit("skip, before the range");
    const lines = skipped.split("\n");
    const block = lines.splice(7, 3);
    lines.splice(2, 0, ...block, "");
    await put("test/math.test.ts", lines.join("\n"));
    await commit("move the skipped test up");
    const record = await run();
    expect(record.findings).toEqual([]);
    expect(record.status).toBe("pass");
  });

  it("reports the copy beyond a moved marker, across files", async () => {
    await put("test/math.test.ts", SUITE + 'it.skip("later", () => {});\n');
    base = await commit("skip, before the range");
    await put("test/math.test.ts", SUITE);
    await put("test/other.test.ts", 'it.skip("later", () => {});\n  it.skip("later", () => {});\n');
    await commit("move the skip and copy it");
    const record = await run();
    expect(record.findings.filter((finding) => finding.category === "skip").map((finding) => finding.id)).toEqual([
      "skip:test/other.test.ts:2",
    ]);
  });

  it("tells a skip, a focus marker and a deleted file apart", async () => {
    await put("test/extra.test.ts", 'it("extra", () => {});\n');
    base = await commit("extra suite");
    await put("test/math.test.ts", SUITE.replace('it("adds"', 'it.only("adds"').replace('it("subtracts"', 'xit("subtracts"'));
    await rm(join(repo, "test/extra.test.ts"));
    await commit("narrow");
    const record = await run();
    expect(record.findings.map((finding) => [finding.category, finding.file, finding.line])).toEqual([
      ["only", "test/math.test.ts", 3],
      ["skip", "test/math.test.ts", 8],
      ["test-file-deleted", "test/extra.test.ts", 1],
    ]);
    expect(record.findings.map((finding) => finding.id)).toEqual([
      "only:test/math.test.ts:3",
      "skip:test/math.test.ts:8",
      "test-file-deleted:test/extra.test.ts:1",
    ]);
  });

  it("reports a todo, and a focus marker in a *.spec.ts file", async () => {
    await put("src/a.spec.ts", 'describe.only("a", () => {});\n');
    await put("test/math.test.ts", SUITE + 'it.todo("divides");\n');
    await commit("todo and focus");
    const record = await run();
    expect(record.findings.map((finding) => finding.id)).toEqual(["only:src/a.spec.ts:1", "skip:test/math.test.ts:11"]);
  });

  it("finds every marker of the table in a file of its scope", async () => {
    const pathFor = (marker: MarkerSpelling, index: number) =>
      marker.scope.includes("config") && !marker.scope.includes("test") ? `vitest.config.ts` : `test/m${index}.test.ts`;
    for (const [index, marker] of WEAKENING_SPELLINGS.markers.entries()) {
      await put(pathFor(marker, index), `${marker.example}\n`);
      base = await commit(`before ${index}`);
      await put(pathFor(marker, index), `// ${index}\n${marker.example}\n`);
      // The second write re-adds the same line one lower: a move, not a marker.
      await commit(`move ${index}`);
      expect((await run()).findings).toEqual([]);
      await put(pathFor(marker, index), `// ${index}\n${marker.example}\n${marker.example} // again\n`);
      await commit(`add ${index}`);
      const record = await run();
      expect(record.findings.map((finding) => [finding.category, finding.line])).toEqual([[marker.category, 3]]);
    }
  });

  it("ignores a marker spelling in a file outside its scope", async () => {
    await put("src/math.ts", 'export const note = "it.skip(";\n// it.only(\n');
    await commit("source that mentions markers");
    const record = await run();
    expect(record.findings).toEqual([]);
  });

  it("reports a deleted test file, so the whole suite cannot go silently", async () => {
    await rm(join(repo, "test/math.test.ts"));
    await commit("delete the suite");
    const record = await run();
    expect(record.status).toBe("fail");
    expect(record.findings).toHaveLength(1);
    expect(record.findings[0]).toMatchObject({
      id: "test-file-deleted:test/math.test.ts:1",
      category: "test-file-deleted",
      file: "test/math.test.ts",
      side: "base",
    });
  });

  it("reports an empty test file deleted at line 0", async () => {
    await put("test/empty.test.ts", "");
    base = await commit("empty suite");
    await rm(join(repo, "test/empty.test.ts"));
    await commit("delete it");
    expect((await run()).findings.map((finding) => finding.id)).toEqual(["test-file-deleted:test/empty.test.ts:0"]);
  });

  it("reports a test file renamed to a name that is not a test file, not one renamed to another test file", async () => {
    await git(repo, ["mv", "test/math.test.ts", "test/math.check.ts"]);
    await commit("rename away");
    const away = await run();
    expect(away.findings.map((finding) => finding.id)).toEqual(["test-file-deleted:test/math.test.ts:1"]);
    expect(away.findings[0]?.detail).toContain("test/math.check.ts");

    await git(repo, ["mv", "test/math.check.ts", "test/arithmetic.test.ts"]);
    base = await commit("rename back to a test file");
    await git(repo, ["mv", "test/arithmetic.test.ts", "test/sums.spec.ts"]);
    await commit("rename between test files");
    expect((await run()).findings).toEqual([]);
  });

  it("reports a test removed from a file that still exists, and not its assertions", async () => {
    await put("test/math.test.ts", SUITE.split("\n").slice(0, 7).join("\n") + "\n");
    await commit("drop a test");
    const record = await run();
    expect(record.status).toBe("fail");
    expect(record.findings).toEqual([
      {
        id: "test-removed:test/math.test.ts:8",
        category: "test-removed",
        file: "test/math.test.ts",
        line: 8,
        side: "base",
        detail: 'test "subtracts" removed',
        sanction: null,
      },
    ]);
  });

  it("does not report tests and assertions reordered within the file", async () => {
    const lines = SUITE.split("\n");
    const moved = [...lines.slice(0, 2), ...lines.slice(7, 11), ...lines.slice(2, 7)].join("\n");
    await put("test/math.test.ts", moved);
    await commit("reorder");
    expect((await run()).findings).toEqual([]);
  });

  it("reports one of two same-named tests when one goes", async () => {
    await put("test/math.test.ts", SUITE + 'it("adds", () => {\n  expect(3).toBe(3);\n});\n');
    base = await commit("a duplicate name");
    await put("test/math.test.ts", SUITE);
    await commit("drop the duplicate");
    const record = await run();
    expect(record.findings.map((finding) => finding.id)).toEqual(["test-removed:test/math.test.ts:11"]);
  });

  it("reports an assertion deleted from a test that keeps its name", async () => {
    await put("test/math.test.ts", SUITE.replace("  expect(2 + 2).toBe(4);\n", ""));
    await commit("drop an assertion");
    const record = await run();
    expect(record.status).toBe("fail");
    expect(record.findings).toEqual([
      {
        id: "assertion-removed:test/math.test.ts:5",
        category: "assertion-removed",
        file: "test/math.test.ts",
        line: 5,
        side: "base",
        detail: 'assertion removed from test "adds": expect(2 + 2).toBe(4);',
        sanction: null,
      },
    ]);
  });

  it("reports an assertion deleted outside any test", async () => {
    await put("test/math.test.ts", 'expect(0).toBe(0);\n' + SUITE);
    base = await commit("a top-level assertion");
    await put("test/math.test.ts", SUITE);
    await commit("drop it");
    const record = await run();
    expect(record.findings.map((finding) => [finding.id, finding.detail])).toEqual([
      ["assertion-removed:test/math.test.ts:1", "assertion removed outside any test: expect(0).toBe(0);"],
    ]);
  });

  it("does not report an assertion that is replaced, but reports one moved to another test", async () => {
    await put(
      "test/math.test.ts",
      SUITE.replace("  expect(2 + 2).toBe(4);\n", "  expect(2 + 2).toEqual(4);\n").replace(
        "  expect(1 + 1).toBe(2);\n",
        "",
      ).replace("  expect(2 - 1).toBe(1);\n", "  expect(2 - 1).toBe(1);\n  expect(1 + 1).toBe(2);\n"),
    );
    await commit("rewrite assertions");
    const record = await run();
    expect(record.findings.map((finding) => finding.id)).toEqual(["assertion-removed:test/math.test.ts:4"]);
  });

  it("does not report a reworded assertion in the same test", async () => {
    await put("test/math.test.ts", SUITE.replace("expect(2 + 2).toBe(4)", "expect(4).toBe(2 + 2)"));
    await commit("reword");
    expect((await run()).findings).toEqual([]);
  });

  it("ignores assertions and tests removed from a file that is not a test file", async () => {
    await put("src/math.ts", 'it("x", () => {\n  expect(1).toBe(1);\n});\n');
    base = await commit("odd source");
    await put("src/math.ts", "export const one = 1;\n");
    await commit("clean it");
    expect((await run()).findings).toEqual([]);
  });

  describe("sanctions", () => {
    beforeEach(async () => {
      await put("test/math.test.ts", SUITE.replace('it("subtracts"', 'it.skip("subtracts"'));
      await put("test/extra.test.ts", "");
    });

    it(`accepts a ${SANCTION_KEY} line naming the id in a commit of the range`, async () => {
      await commit(`skip\n\n${SANCTION_KEY}: skip:test/math.test.ts:8 upstream bug #12, re-enable next release`);
      const record = await run();
      expect(record.status).toBe("pass");
      expect(record.findings).toHaveLength(1);
      expect(record.findings[0]?.sanction).toBe("upstream bug #12, re-enable next release");
      expect(record.evidence.join("\n")).toContain("sanctioned: upstream bug #12");
    });

    it("accepts <category>:<file> in an earlier commit of the range", async () => {
      await commit(`skip\n\nbody\n${SANCTION_KEY}: skip:test/math.test.ts flaky on CI`);
      await put("src/math.ts", "export const one = 1;\n// later\n");
      await commit("later");
      const record = await run();
      expect(record.status).toBe("pass");
      expect(record.findings[0]?.sanction).toBe("flaky on CI");
    });

    it("ignores a sanction line outside the range, without a reason, or for another finding", async () => {
      await git(repo, ["commit", "--quiet", "--allow-empty", "-m", `early\n\n${SANCTION_KEY}: skip:test/math.test.ts:8 too early`]);
      base = await git(repo, ["rev-parse", "HEAD"]);
      await commit(
        `skip\n\n${SANCTION_KEY}: skip:test/math.test.ts:8\n${SANCTION_KEY}: only:test/math.test.ts:8 wrong category\n` +
          `${SANCTION_KEY}: skip:test/math.test.ts:80 wrong line\n${SANCTION_KEY}: skip:test/math.test.tsx other file`,
      );
      const record = await run();
      expect(record.findings.map((finding) => finding.id)).toEqual(["skip:test/math.test.ts:8"]);
      expect(record.status).toBe("fail");
      expect(record.findings[0]?.sanction).toBeNull();
    });

    it("accepts the caller's sanctions by id or by <category>:<file>", async () => {
      await commit("skip");
      const byId = await run({ sanctions: { "skip:test/math.test.ts:8": "known flake" } });
      expect(byId.status).toBe("pass");
      expect(byId.findings[0]?.sanction).toBe("known flake");

      const byFile = await run({ sanctions: { "skip:test/math.test.ts": "whole file" } });
      expect(byFile.status).toBe("pass");
      expect(byFile.findings[0]?.sanction).toBe("whole file");

      const blank = await run({ sanctions: { "skip:test/math.test.ts:8": "  " } });
      expect(blank.status).toBe("fail");
    });

    it("prefers the exact id over the file-wide key", async () => {
      await commit(`skip\n\n${SANCTION_KEY}: skip:test/math.test.ts broad\n${SANCTION_KEY}: skip:test/math.test.ts:8 exact`);
      expect((await run()).findings[0]?.sanction).toBe("exact");
    });

    it("fails while any finding is unsanctioned and lists the sanctioned ones", async () => {
      await put("test/math.test.ts", SUITE.replace('it("adds"', 'it.only("adds"').replace('it("subtracts"', 'it.skip("subtracts"'));
      await commit(`focus and skip\n\n${SANCTION_KEY}: only:test/math.test.ts:3 bisecting`);
      const partly = await run();
      expect(partly.findings.map((finding) => [finding.id, finding.sanction])).toEqual([
        ["only:test/math.test.ts:3", "bisecting"],
        ["skip:test/math.test.ts:8", null],
      ]);
      expect(partly.status).toBe("fail");

      const all = await run({ sanctions: { "skip:test/math.test.ts:8": "flaky" } });
      expect(all.status).toBe("pass");
      expect(all.findings.map((finding) => finding.sanction)).toEqual(["bisecting", "flaky"]);
    });

    it("passes once every finding is sanctioned, still listing each", async () => {
      await commit(`skip\n\n${SANCTION_KEY}: skip:test/math.test.ts:8 flaky`);
      const record = await run({ base, sanctions: {} });
      expect(record.status).toBe("pass");
      expect(record.findings).toEqual([expect.objectContaining({ id: "skip:test/math.test.ts:8", sanction: "flaky" })]);
    });
  });

  describe("spellings", () => {
    const pending: MarkerSpelling = {
      category: "skip",
      scope: ["any"],
      pattern: /\bpending\(\)/,
      example: "pending();",
    };

    it("reads the caller's table in place of the default", async () => {
      await put("lib/check.rb", "pending()\n");
      await put("test/math.test.ts", SUITE.replace('it("subtracts"', 'it.skip("subtracts"'));
      await commit("pending");

      const withDefault = await run();
      expect(withDefault.findings.map((finding) => finding.id)).toEqual(["skip:test/math.test.ts:8"]);

      const extended = await run({
        spellings: { ...WEAKENING_SPELLINGS, markers: [...WEAKENING_SPELLINGS.markers, pending] },
      });
      expect(extended.findings.map((finding) => finding.id)).toEqual(["skip:lib/check.rb:1", "skip:test/math.test.ts:8"]);

      const replaced = await run({ spellings: { markers: [pending] } });
      expect(replaced.findings.map((finding) => finding.id)).toEqual(["skip:lib/check.rb:1"]);
    });

    it("takes the caller's test files, test and assertion spellings", async () => {
      await put("spec/math_spec.rb", 'it "adds" do\n  assert_equal 2, 1 + 1\n  assert_equal 4, 2 + 2\nend\nit "subtracts" do\nend\n');
      base = await commit("ruby suite");
      await put("spec/math_spec.rb", 'it "adds" do\n  assert_equal 2, 1 + 1\nend\n');
      await commit("weaken the ruby suite");

      expect((await run()).findings).toEqual([]);
      const record = await run({
        spellings: {
          testFiles: [/_spec\.rb$/],
          tests: [/^\s*it\s+"(.*)"/],
          assertions: [/\bassert_equal\b/g],
        },
      });
      expect(record.findings.map((finding) => finding.id)).toEqual([
        "test-removed:spec/math_spec.rb:5",
        "assertion-removed:spec/math_spec.rb:3",
      ]);
    });

    it("fails closed on a table it cannot use", async () => {
      await put("test/math.test.ts", SUITE + "// x\n");
      await commit("touch");
      const record = await run({ spellings: { markers: [{ ...pending, pattern: "pending" as unknown as RegExp }] } });
      expect(record.status).toBe("fail");
      expect(record.findings).toEqual([]);
    });
  });

  describe("fails closed", () => {
    it("on a base that names no commit, naming it", async () => {
      const record = await run({ base: "no-such-base" });
      expect(record).toMatchObject({ name: "RT-04", status: "fail", findings: [] });
      expect(record.evidence.join("\n")).toContain("no-such-base");
    });

    it("on a candidate that names no commit, naming it", async () => {
      const record = await run({ candidate: "deadbeef" });
      expect(record.status).toBe("fail");
      expect(record.evidence.join("\n")).toContain("deadbeef");
    });

    it("on a revision that would read as an option or is empty", async () => {
      for (const candidate of ["--all", ""]) {
        const record = await run({ candidate });
        expect(record.status).toBe("fail");
        expect(record.evidence.join("\n")).toContain(`"${candidate}"`);
      }
    });

    it("on a revision that names a tree rather than a commit", async () => {
      const tree = await git(repo, ["rev-parse", "HEAD^{tree}"]);
      const record = await run({ candidate: tree });
      expect(record.status).toBe("fail");
      expect(record.evidence.join("\n")).toContain(tree);
    });

    it("on a directory that is not a repository, naming the cause", async () => {
      const elsewhere = await mkdtemp(join(tmpdir(), "repo-truth-not-a-repo-"));
      try {
        const record = await checkWeakenedTests({ cwd: elsewhere, base: "HEAD", candidate: "HEAD" });
        expect(record.status).toBe("fail");
        expect(record.evidence.join("\n")).toMatch(/not a git repository/i);
      } finally {
        await rm(elsewhere, { recursive: true, force: true });
      }
    });

    it("on unrelated histories, naming the merge base", async () => {
      await git(repo, ["checkout", "--quiet", "--orphan", "other"]);
      const other = await commit("unrelated");
      const record = await run({ candidate: other });
      expect(record.status).toBe("fail");
      expect(record.evidence.join("\n")).toContain("merge base");
    });

    it("on missing options, without throwing", async () => {
      const record = await checkWeakenedTests(undefined as unknown as WeakenedTestsOptions);
      expect(record).toMatchObject({ name: "RT-04", status: "fail", findings: [] });
    });
  });
});
