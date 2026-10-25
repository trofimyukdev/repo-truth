import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REGISTRY, loadCheckDirectory } from "../../src/registry.js";

const OWN_NAMES = [
  "RT-01", "RT-02", "RT-03", "RT-04", "RT-05", "RT-06", "RT-09",
  "RT-10", "RT-11", "RT-12", "RT-14", "RT-16", "RT-18",
];

const repo = { cwd: "/nowhere" };
const range = { base: "a", candidate: "b" };

function moduleSource(name: string, status = "pass"): string {
  return `export const name = ${JSON.stringify(name)};\n` +
    `export const check = () => ({ name: ${JSON.stringify(name)}, status: ${JSON.stringify(status)}, evidence: ["ran"] });\n`;
}

describe("REGISTRY", () => {
  it("starts with the registry's own entries in their order", () => {
    expect(REGISTRY.slice(0, OWN_NAMES.length).map((e) => e.name)).toEqual(OWN_NAMES);
  });
});

describe("loadCheckDirectory", () => {
  let dir: string;
  const url = () => pathToFileURL(dir + "/");

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "repo-truth-checks-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("yields nothing for a missing directory", async () => {
    expect(await loadCheckDirectory(pathToFileURL(join(dir, "absent") + "/"), ".ts")).toEqual([]);
  });

  it("yields nothing for an empty directory", async () => {
    expect(await loadCheckDirectory(url(), ".ts")).toEqual([]);
  });

  it("loads .ts modules in the order of their file names", async () => {
    await writeFile(join(dir, "zeta.ts"), moduleSource("Z-1"));
    await writeFile(join(dir, "alpha.ts"), moduleSource("A-1", "fail"));
    await writeFile(join(dir, "Beta.ts"), moduleSource("B-1"));
    const entries = await loadCheckDirectory(url(), ".ts");
    expect(entries.map((e) => e.name)).toEqual(["B-1", "A-1", "Z-1"]);
    expect(await entries[1]!.run(repo, range)).toEqual({ name: "A-1", status: "fail", evidence: ["ran"] });
  });

  it("loads .js modules and passes over the files the build writes beside them", async () => {
    await writeFile(join(dir, "one.js"), moduleSource("ONE"));
    await writeFile(join(dir, "one.d.ts"), "export declare const name: string;\n");
    await writeFile(join(dir, "one.js.map"), "{}");
    const entries = await loadCheckDirectory(url(), ".js");
    expect(entries.map((e) => e.name)).toEqual(["ONE"]);
    expect(await entries[0]!.run(repo, range)).toEqual({ name: "ONE", status: "pass", evidence: ["ran"] });
  });

  it("passes over test files, subdirectories and files of another extension", async () => {
    await writeFile(join(dir, "good.ts"), moduleSource("GOOD"));
    await writeFile(join(dir, "good.test.ts"), moduleSource("TEST"));
    await writeFile(join(dir, "good.spec.ts"), moduleSource("SPEC"));
    await writeFile(join(dir, "other.js"), moduleSource("OTHER"));
    await writeFile(join(dir, "notes.md"), "x");
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "nested.ts"), moduleSource("NESTED"));
    await mkdir(join(dir, "dir.ts"));
    const entries = await loadCheckDirectory(url(), ".ts");
    expect(entries.map((e) => e.name)).toEqual(["GOOD"]);
  });

  it("turns a module that throws while loading into a failing entry", async () => {
    await writeFile(join(dir, "boom.ts"), 'throw new Error("kaput");\n');
    await writeFile(join(dir, "fine.ts"), moduleSource("FINE"));
    const entries = await loadCheckDirectory(url(), ".ts");
    expect(entries.map((e) => e.name)).toEqual(["checks/boom", "FINE"]);
    const record = await entries[0]!.run(repo, range);
    expect(record.name).toBe("checks/boom");
    expect(record.status).toBe("fail");
    expect(record.evidence).toHaveLength(1);
    expect(record.evidence[0]).toContain("boom.ts");
    expect(record.evidence[0]).toContain("kaput");
  });

  it("turns a module without the stated exports into a failing entry", async () => {
    await writeFile(join(dir, "a-nocheck.ts"), 'export const name = "NC";\n');
    await writeFile(join(dir, "b-noname.ts"), "export const check = () => ({});\n");
    await writeFile(join(dir, "c-badname.ts"), 'export const name = ""; export const check = () => ({});\n');
    await writeFile(join(dir, "d-badcheck.ts"), 'export const name = "BC"; export const check = 3;\n');
    const entries = await loadCheckDirectory(url(), ".ts");
    expect(entries.map((e) => e.name)).toEqual([
      "checks/a-nocheck", "checks/b-noname", "checks/c-badname", "checks/d-badcheck",
    ]);
    for (const e of entries) {
      const record = await e.run(repo, range);
      expect(record.status).toBe("fail");
      expect(record.evidence).toHaveLength(1);
      expect(record.evidence[0]).toContain(e.name.slice("checks/".length) + ".ts");
    }
  });

  it("turns a module whose name is already registered into a failing entry", async () => {
    await writeFile(join(dir, "a.ts"), moduleSource("DUP"));
    await writeFile(join(dir, "b.ts"), moduleSource("DUP"));
    await writeFile(join(dir, "c.ts"), moduleSource("RT-01"));
    const entries = await loadCheckDirectory(url(), ".ts");
    expect(entries.map((e) => e.name)).toEqual(["DUP", "checks/b", "checks/c"]);
    const second = await entries[1]!.run(repo, range);
    expect(second.status).toBe("fail");
    expect(second.evidence[0]).toContain("b.ts");
    expect(second.evidence[0]).toContain("DUP");
    expect((await entries[2]!.run(repo, range)).evidence[0]).toContain("RT-01");
  });

  const NOT_PLAIN = "its optionKinds is not a plain object";
  const BYTES_GIVEN = 7;
  const OTHER_GIVEN = 1;

  async function onlyEntry(file: string, source: string) {
    await writeFile(join(dir, file), source);
    const entries = await loadCheckDirectory(url(), ".ts");
    expect(entries).toHaveLength(1);
    return entries[0]!;
  }

  it("turns a module whose optionKinds is an instance of a class into a failing entry", async () => {
    const source = moduleSource("KLASS") +
      'class Kinds { maxBytes = "integer"; }\nexport const optionKinds = new Kinds();\n';
    const only = await onlyEntry("klass.ts", source);
    expect(only.name).toBe("checks/klass");
    expect(await only.run(repo, range)).toEqual({
      name: "checks/klass", status: "fail", evidence: ["klass.ts: " + NOT_PLAIN],
    });
  });

  it("turns a module whose optionKinds is a Map into a failing entry", async () => {
    const source = moduleSource("MAPPED") + 'export const optionKinds = new Map([["maxBytes", "integer"]]);\n';
    const only = await onlyEntry("mapped.ts", source);
    expect(only.name).toBe("checks/mapped");
    expect(await only.run(repo, range)).toEqual({
      name: "checks/mapped", status: "fail", evidence: ["mapped.ts: " + NOT_PLAIN],
    });
  });

  it("turns a module whose optionKinds is an array, null or a string into a failing entry", async () => {
    await writeFile(join(dir, "a-array.ts"), moduleSource("AR") + 'export const optionKinds = ["integer"];\n');
    await writeFile(join(dir, "b-null.ts"), moduleSource("NU") + "export const optionKinds = null;\n");
    await writeFile(join(dir, "c-text.ts"), moduleSource("TX") + 'export const optionKinds = "integer";\n');
    const entries = await loadCheckDirectory(url(), ".ts");
    expect(entries.map((e) => e.name)).toEqual(["checks/a-array", "checks/b-null", "checks/c-text"]);
    for (const e of entries) {
      const record = await e.run(repo, range);
      expect(record.status).toBe("fail");
      expect(record.evidence).toEqual([e.name.slice("checks/".length) + ".ts: " + NOT_PLAIN]);
    }
  });

  it("registers a module whose optionKinds has a null prototype with its declaration", async () => {
    const source = 'export const name = "NULLPROTO";\n' +
      'export const check = (o) => ({ name: "NULLPROTO", status: "pass", evidence: [JSON.stringify(o.maxBytes)] });\n' +
      'export const optionKinds = Object.assign(Object.create(null), { maxBytes: "integer" });\n';
    const only = await onlyEntry("nullproto.ts", source);
    expect(only.name).toBe("NULLPROTO");
    expect({ ...only.options }).toEqual({ maxBytes: "integer" });
    const record = await only.run(repo, range, { maxBytes: BYTES_GIVEN, other: OTHER_GIVEN });
    expect(record).toEqual({ name: "NULLPROTO", status: "pass", evidence: [String(BYTES_GIVEN)] });
  });

  it("registers a module whose optionKinds is a plain object with its declaration", async () => {
    const source = moduleSource("PLAIN") + 'export const optionKinds = { maxBytes: "integer" };\n';
    const only = await onlyEntry("plain.ts", source);
    expect(only.name).toBe("PLAIN");
    expect({ ...only.options }).toEqual({ maxBytes: "integer" });
  });

  it("keeps the name of an entry that could not be registered from a later module", async () => {
    await writeFile(join(dir, "a.ts"), 'throw new Error("kaput");\n');
    await writeFile(join(dir, "b.ts"), moduleSource("checks/a"));
    await writeFile(join(dir, "c.ts"), moduleSource("checks/b"));
    await writeFile(join(dir, "d.ts"), moduleSource("checks/b"));
    const entries = await loadCheckDirectory(url(), ".ts");
    expect(entries.map((e) => e.name)).toEqual(["checks/a", "checks/b", "checks/c", "checks/d"]);
    expect(await entries[1]!.run(repo, range)).toEqual({
      name: "checks/b", status: "fail", evidence: ["b.ts: its name checks/a is already registered"],
    });
    expect(await entries[2]!.run(repo, range)).toEqual({
      name: "checks/c", status: "fail", evidence: ["c.ts: its name checks/b is already registered"],
    });
    expect(await entries[3]!.run(repo, range)).toEqual({
      name: "checks/d", status: "fail", evidence: ["d.ts: its name checks/b is already registered"],
    });
    expect(new Set(entries.map((e) => e.name)).size).toBe(entries.length);
  });
});
