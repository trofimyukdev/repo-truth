import { describe, expect, it } from "vitest";

import { allPassed, selfCheck, type CheckRecord } from "../../src/index.js";

describe("selfCheck", () => {
  it("answers with a record, not a boolean or an exit code", () => {
    const record = selfCheck();
    expect(record.name).toBe("self");
    expect(record.status).toBe("pass");
    expect(Array.isArray(record.evidence)).toBe(true);
  });

  it("says in its own evidence that no repository check is implemented", () => {
    // The status is `pass` and the package is a skeleton; the evidence line is
    // what keeps those two facts from contradicting each other for a reader.
    expect(selfCheck().evidence.join(" ")).toMatch(/no repository check is implemented/);
  });
});

describe("allPassed", () => {
  const record = (status: CheckRecord["status"]): CheckRecord => ({
    name: "x",
    status,
    evidence: [],
  });

  it("passes an empty set", () => {
    expect(allPassed([])).toBe(true);
  });

  it("fails as soon as one record fails", () => {
    expect(allPassed([record("pass"), record("fail"), record("pass")])).toBe(false);
  });

  it("does not treat a skip as a failure", () => {
    // A check that could not run has not found anything. This case is the one
    // that would silently invert if `!== "fail"` ever became `=== "pass"`.
    expect(allPassed([record("pass"), record("skip")])).toBe(true);
  });
});
