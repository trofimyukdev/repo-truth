import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { REGISTRY } from "../../src/registry.js";
import { checkDependencySources, DEFAULT_REGISTRIES } from "../../src/dependency-sources.js";

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

async function commit(cwd: string, files: Record<string, string | null>, message = "change"): Promise<string> {
  for (const [name, content] of Object.entries(files)) {
    if (content === null) {
      await rm(join(cwd, name));
    } else {
      await mkdir(dirname(join(cwd, name)), { recursive: true });
      await writeFile(join(cwd, name), content);
    }
  }
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "--quiet", "-m", message, "--allow-empty"]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

const manifest = (fields: Record<string, unknown>): string => JSON.stringify({ name: "x", version: "1.0.0", ...fields }, null, 2) + "\n";
const deps = (d: Record<string, string>): string => manifest({ dependencies: d });

describe("checkDependencySources", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "repo-truth-depsrc-"));
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function run(
    before: Record<string, string | null>,
    after: Record<string, string | null>,
    registries?: string[],
  ) {
    const base = await commit(repo, before, "base");
    const candidate = await commit(repo, after, "change");
    return checkDependencySources({ cwd: repo, base, candidate, ...(registries === undefined ? {} : { registries }) });
  }

  async function depsOf(before: Record<string, string>, after: Record<string, string>) {
    return run({ "package.json": deps(before) }, { "package.json": deps(after) });
  }

  it("lists the default registries", () => {
    expect(DEFAULT_REGISTRIES).toEqual(["registry.npmjs.org", "registry.yarnpkg.com"]);
  });

  it("is registered as RT-18", () => {
    expect(REGISTRY.map((e) => e.name)).toContain("RT-18");
  });

  it.each([
    ["git+https://git.invalid/o/r.git", "git"],
    ["git:git.invalid/o/r", "git"],
    ["github:owner/repo", "git"],
    ["gitlab:owner/repo", "git"],
    ["bitbucket:owner/repo", "git"],
    ["gist:abc123", "git"],
    ["owner/repo", "git"],
    ["owner/repo#v1", "git"],
    ["https://host.invalid/a.tgz", "url"],
    ["http://host.invalid/a.tgz", "url"],
    ["file:../a", "path"],
    ["link:../a", "path"],
    ["portal:../a", "path"],
    ["./a", "path"],
    ["../a", "path"],
    ["/abs/a", "path"],
    ["~/a", "path"],
    ["npm:other@^1.0.0", "alias"],
    ["npm:other", "alias"],
  ])("reports %s as [%s]", async (specifier, rule) => {
    const record = await depsOf({}, { foo: specifier });
    expect(record.name).toBe("RT-18");
    expect(record.status).toBe("fail");
    expect(record.evidence).toEqual([`package.json dependencies "foo" "${specifier}" [${rule}]`]);
  });

  it.each(["^1.2.3", "~1.0.0", "1.x", ">=1.0.0 <2", "1.0.0 - 2.0.0", "latest", "next", "*", "", "workspace:*", "workspace:^1.0.0", "npm:foo@^1.0.0", "npm:foo", "npm:@s/foo@1.0.0"])(
    "says nothing about %j",
    async (specifier) => {
      const name = specifier.startsWith("npm:@s") ? "@s/foo" : "foo";
      const record = await depsOf({}, { [name]: specifier });
      expect(record).toEqual({ name: "RT-18", status: "pass", evidence: ["no dependency from outside the registry"] });
    },
  );

  it("does not report a git dependency the base already holds when another is bumped", async () => {
    const record = await depsOf({ a: "github:o/r", b: "^1.0.0" }, { a: "github:o/r", b: "^2.0.0" });
    expect(record.status).toBe("pass");
  });

  it("reports a git reference the range changes", async () => {
    const record = await depsOf({ a: "github:o/r#v1" }, { a: "github:o/r#v2" });
    expect(record.status).toBe("fail");
    expect(record.evidence).toEqual([`package.json dependencies "a" "github:o/r#v2" [git]`]);
  });

  it("reports a version range changed to a path", async () => {
    const record = await depsOf({ a: "^1.0.0" }, { a: "file:../a" });
    expect(record.evidence).toEqual([`package.json dependencies "a" "file:../a" [path]`]);
  });

  it("reads other dependency fields", async () => {
    const record = await run(
      { "package.json": manifest({}) },
      { "package.json": manifest({ devDependencies: { d: "o/r" }, optionalDependencies: { e: "file:e" } }) },
    );
    expect(record.evidence).toEqual([
      `package.json devDependencies "d" "o/r" [git]`,
      `package.json optionalDependencies "e" "file:e" [path]`,
    ]);
  });

  it("reads overrides, including nested ones, and resolutions", async () => {
    const record = await run(
      { "package.json": manifest({}) },
      {
        "package.json": manifest({
          overrides: { a: "github:o/r", b: { ".": "^1.0.0", c: "https://h.invalid/c.tgz" } },
          resolutions: { "**/d": "file:../d", "e@^1": "npm:f@1.0.0" },
        }),
      },
    );
    expect(record.status).toBe("fail");
    expect(record.evidence).toEqual([
      `package.json overrides "a" "github:o/r" [git]`,
      `package.json overrides "b > c" "https://h.invalid/c.tgz" [url]`,
      `package.json resolutions "**/d" "file:../d" [path]`,
      `package.json resolutions "e@^1" "npm:f@1.0.0" [alias]`,
    ]);
  });

  it("accepts a same-name alias in overrides", async () => {
    const record = await run(
      { "package.json": manifest({}) },
      { "package.json": manifest({ resolutions: { "x/**/@s/foo@1": "npm:@s/foo@1.2.3" } }) },
    );
    expect(record.status).toBe("pass");
  });

  it("ignores non-dependency fields and bundledDependencies arrays", async () => {
    const record = await run(
      { "package.json": manifest({}) },
      { "package.json": manifest({ scripts: { a: "github:o/r" }, bundledDependencies: ["github:o/r"] }) },
    );
    expect(record.status).toBe("pass");
  });

  it("escapes characters outside printable ASCII", async () => {
    const record = await depsOf({}, { foo: "file:\u001b[2Jx" });
    expect(record.evidence).toEqual([`package.json dependencies "foo" "file:\\u{001b}[2Jx" [path]`]);
  });

  describe("lockfiles", () => {
    const npmLock = (resolved: string): string =>
      `{\n  "packages": {\n    "node_modules/a": {\n      "version": "1.0.0",\n      "resolved": "${resolved}"\n    }\n  }\n}\n`;

    it("passes a registry host in package-lock.json", async () => {
      const record = await run(
        { "package.json": deps({}) },
        { "package.json": deps({ a: "^1.0.0" }), "package-lock.json": npmLock("https://registry.npmjs.org/a/-/a-1.0.0.tgz") },
      );
      expect(record.status).toBe("pass");
    });

    it("reports another host with the line in the candidate", async () => {
      const record = await run(
        { "package.json": deps({}) },
        { "package.json": deps({ a: "^1.0.0" }), "package-lock.json": npmLock("https://evil.invalid/a-1.0.0.tgz") },
      );
      expect(record.status).toBe("fail");
      expect(record.evidence).toEqual([`package-lock.json line 5 host "evil.invalid" [registry]`]);
    });

    it("reads npm-shrinkwrap.json", async () => {
      const record = await run(
        { "package.json": deps({}) },
        { "package.json": deps({}), "npm-shrinkwrap.json": npmLock("git+ssh://git@git.invalid/o/r.git#abc") },
      );
      expect(record.evidence).toEqual([`npm-shrinkwrap.json line 5 host "git.invalid" [registry]`]);
    });

    it("reads yarn.lock", async () => {
      const yarn = (url: string): string => `a@^1.0.0:\n  version "1.0.0"\n  resolved "${url}#abc"\n`;
      const bad = await run({ "package.json": deps({}) }, { "package.json": deps({}), "yarn.lock": yarn("https://evil.invalid/a.tgz") });
      expect(bad.evidence).toEqual([`yarn.lock line 3 host "evil.invalid" [registry]`]);
    });

    it("passes the yarn registry host", async () => {
      const record = await run(
        { "package.json": deps({}) },
        { "package.json": deps({}), "yarn.lock": `a@^1.0.0:\n  version "1.0.0"\n  resolved "https://registry.yarnpkg.com/a/-/a-1.0.0.tgz#abc"\n` },
      );
      expect(record.status).toBe("pass");
    });

    it("does not judge a resolved line the base already had", async () => {
      const lock = npmLock("https://evil.invalid/a.tgz");
      const record = await run(
        { "package.json": deps({}), "package-lock.json": lock },
        { "package.json": deps({}), "package-lock.json": lock.replace("1.0.0", "1.0.1") },
      );
      expect(record.status).toBe("pass");
    });

    it("uses a caller's registries in place of the defaults", async () => {
      const files = { "package.json": deps({}), "package-lock.json": npmLock("https://mirror.invalid/a.tgz") };
      const allowed = await run({ "package.json": deps({}) }, files, ["mirror.invalid"]);
      expect(allowed.status).toBe("pass");
    });

    it("no longer allows a default host when the caller replaces the list", async () => {
      const files = { "package.json": deps({}), "package-lock.json": npmLock("https://registry.npmjs.org/a.tgz") };
      const record = await run({ "package.json": deps({}) }, files, ["mirror.invalid"]);
      expect(record.evidence).toEqual([`package-lock.json line 5 host "registry.npmjs.org" [registry]`]);
    });
  });

  it("skips a repository with no manifest and no lockfile line", async () => {
    const record = await run({ "a.txt": "a\n" }, { "a.txt": "b\n" });
    expect(record.status).toBe("skip");
    expect(record.evidence.join("\n")).toContain("package.json");
  });

  it("fails on a manifest that does not parse at the candidate", async () => {
    const record = await run({ "package.json": deps({}) }, { "package.json": "{ nope" });
    expect(record.status).toBe("fail");
    expect(record.evidence[0]).toContain("package.json");
    expect(record.evidence[0]).toContain("is not valid JSON");
  });

  it("fails on a manifest that does not parse at the base", async () => {
    const record = await run({ "package.json": "{ nope" }, { "package.json": deps({}) });
    expect(record.status).toBe("fail");
    expect(record.evidence[0]).toContain("package.json");
  });

  it("fails on a revision that names no commit", async () => {
    const head = await commit(repo, { "package.json": deps({}) });
    const record = await checkDependencySources({ cwd: repo, base: "no-such-rev", candidate: head });
    expect(record.status).toBe("fail");
    expect(record.evidence[0]).toContain("no-such-rev");
  });

  it("fails rather than throws outside a repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "repo-truth-depsrc-none-"));
    try {
      const record = await checkDependencySources({ cwd: dir, base: "HEAD", candidate: "HEAD" });
      expect(record.status).toBe("fail");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
