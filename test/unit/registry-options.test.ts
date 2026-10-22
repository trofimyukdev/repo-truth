import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONFIG_SCHEMA, parseConfig } from "../../src/config.js";
import { REGISTRY, loadCheckDirectory, optionKindsOf } from "../../src/registry.js";
import type { RegistryEntry } from "../../src/registry.js";

const repo = { cwd: "/nowhere" };
const range = { base: "a", candidate: "b" };

/** A check that records the options it was called with. */
function source(name: string, kinds?: string): string {
  return (
    `export const name = ${JSON.stringify(name)};\n` +
    (kinds === undefined ? "" : `export const optionKinds = ${kinds};\n`) +
    `export const check = (o) => ({ name: ${JSON.stringify(name)}, status: "pass", evidence: [JSON.stringify(o)] });\n`
  );
}

let dir: string;
let entries: RegistryEntry[];

function find(name: string): RegistryEntry {
  const found = entries.find((e) => e.name === name);
  if (found === undefined) throw new Error("no entry " + name);
  return found;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "repo-truth-options-"));
  const files: Record<string, string> = {
    "a-valid.ts": source("X-01", '{ limit: "integer", tags: "strings" }'),
    "b-none.ts": source("X-02"),
    "c-null.ts": source("X-03", "null"),
    "d-array.ts": source("X-04", "[]"),
    "e-unknown.ts": source("X-05", '{ limit: "float" }'),
    "f-cwd.ts": source("X-06", '{ cwd: "string" }'),
    "g-sanctions.ts": source("X-07", '{ sanctions: "boolean" }'),
  };
  for (const [file, text] of Object.entries(files)) await writeFile(join(dir, file), text);
  entries = await loadCheckDirectory(pathToFileURL(dir + "/"), ".ts");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the registry's own options", () => {
  it("declares exactly the options of RT-12, RT-18 and RT-19", () => {
    const declared = Object.fromEntries(
      REGISTRY.filter((e) => e.name.startsWith("RT-") && Object.keys(e.options ?? {}).length > 0).map((e) => [e.name, e.options]),
    );
    expect(declared).toMatchObject({
      "RT-12": { maxBytes: "integer" },
      "RT-18": { registries: "strings" },
      "RT-19": { timeoutMs: "integer" },
    });
    expect(declared["RT-01"]).toBeUndefined();
    expect(REGISTRY.find((e) => e.name === "RT-01")?.options).toEqual({});
  });
});

describe("a check directory's optionKinds", () => {
  it("gives a valid optionKinds to its entry and none to a module without", () => {
    expect(find("X-01").options).toEqual({ limit: "integer", tags: "strings" });
    expect(find("X-02").options).toEqual({});
  });

  it.each([
    ["c-null", "optionKinds"],
    ["d-array", "optionKinds"],
    ["e-unknown", "optionKinds"],
    ["f-cwd", "cwd"],
    ["g-sanctions", "sanctions"],
  ])("registers %s as a failing entry with no options", async (stem, cause) => {
    const failing = entries.find((e) => e.name === "checks/" + stem);
    expect(failing?.options).toEqual({});
    const record = await failing?.run(repo, range);
    expect(record?.status).toBe("fail");
    expect(record?.evidence[0]).toContain(stem + ".ts");
    expect(record?.evidence[0]).toContain(cause);
  });
});

describe("run with options", () => {
  it("hands a declared option and nothing undeclared", async () => {
    const record = await find("X-01").run(repo, range, { limit: 5, other: 1 });
    expect(JSON.parse(record.evidence[0] as string)).toEqual({ limit: 5, cwd: "/nowhere", base: "a", candidate: "b" });
  });

  it("never lets an option replace base", async () => {
    const record = await find("X-01").run(repo, range, { base: "evil", cwd: "/x", candidate: "y", limit: 1 });
    expect(JSON.parse(record.evidence[0] as string)).toEqual({ limit: 1, cwd: "/nowhere", base: "a", candidate: "b" });
  });

  it("calls the check as before with none or an empty object", async () => {
    const plain = { cwd: "/nowhere", base: "a", candidate: "b" };
    for (const given of [undefined, {}]) {
      const record = await find("X-01").run(repo, range, given);
      expect(JSON.parse(record.evidence[0] as string)).toEqual(plain);
    }
  });
});

describe("optionKindsOf", () => {
  it("answers every entry, empty for one without options", () => {
    const bare: RegistryEntry = { name: "H-1", run: () => ({ name: "H-1", status: "pass", evidence: [] }) };
    const kinds = optionKindsOf([...entries, bare]);
    expect(Object.keys(kinds).sort()).toEqual([...entries.map((e) => e.name), "H-1"].sort());
    expect(kinds["H-1"]).toEqual({});
    expect(kinds["X-01"]).toEqual({ limit: "integer", tags: "strings" });
    expect(kinds["X-01"]).not.toBe(find("X-01").options);
  });

  it("is read by parseConfig", () => {
    const text = JSON.stringify({ schema: CONFIG_SCHEMA, checks: { "X-01": { limit: 3, tags: ["a"] } } });
    const kinds = optionKindsOf(entries);
    expect(parseConfig(text, kinds)).toEqual({ "X-01": { limit: 3, tags: ["a"] } });
    expect(Object.keys(optionKindsOf(REGISTRY))).toEqual(REGISTRY.map((e) => e.name));
  });
});
