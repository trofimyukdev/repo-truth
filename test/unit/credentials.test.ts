import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli.js";
import { CREDENTIAL_SHAPES, check, name } from "../../src/checks/credentials.js";

const execFileAsync = promisify(execFile);

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "Test Committer",
  GIT_COMMITTER_EMAIL: "committer@example.com",
};

// Every value is put together here, so no line of this file holds a whole one.
const rep = (char: string, n: number): string => char.repeat(n);
const PRIVATE_KEY = ["-----", "BEGIN RSA ", "PRIVATE", " KEY", "-----"].join("");
const ACCESS_KEY = ["AK", "IA"].join("") + rep("Q", 16);
const SESSION_KEY = ["AS", "IA"].join("") + rep("7", 16);
const HOST_TOKEN = ["gh", "p_"].join("") + rep("a", 36);
const HOST_PAT = ["github", "_pat_"].join("") + rep("B_", 20);
const CHAT_TOKEN = ["xo", "xb-"].join("") + rep("1", 12);
const SECRET = rep("z", 24);
const assign = (word: string, value: string, sep = " = ", quote = '"'): string => `${word}${sep}${quote}${value}${quote}`;

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args as string[], { cwd, env: ENV });
  return stdout.trim();
}

async function commit(cwd: string, files: Record<string, string | Buffer | null>, message = "change"): Promise<string> {
  for (const [file, content] of Object.entries(files)) {
    if (content === null) {
      await rm(join(cwd, file));
    } else {
      await mkdir(dirname(join(cwd, file)), { recursive: true });
      await writeFile(join(cwd, file), content);
    }
  }
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "--quiet", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

describe("RT-26 credentials", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "repo-truth-credentials-"));
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function run(before: Record<string, string | Buffer>, after: Record<string, string | Buffer | null>) {
    const base = await commit(repo, before, "base");
    const candidate = await commit(repo, after, "change");
    return check({ cwd: repo, base, candidate });
  }

  function expectNoLeak(evidence: readonly string[], planted: readonly string[]): void {
    for (const line of evidence) for (const text of planted) expect(line).not.toContain(text);
  }

  it("is named RT-26", () => {
    expect(name).toBe("RT-26");
    expect(CREDENTIAL_SHAPES.length).toBeGreaterThanOrEqual(5);
  });

  const forms: [string, string, string, string][] = [
    ["private key", "id.txt", `${PRIVATE_KEY}\nmore\n`, PRIVATE_KEY],
    ["cloud access key id", "aws.txt", `id: ${ACCESS_KEY}\n`, ACCESS_KEY],
    ["cloud access key id", "aws2.txt", `id: ${SESSION_KEY}\n`, SESSION_KEY],
    ["code host token", "gh.txt", `t ${HOST_TOKEN}\n`, HOST_TOKEN],
    ["code host token", "pat.txt", `t=${HOST_PAT}\n`, HOST_PAT],
    ["chat token", "chat.txt", `${CHAT_TOKEN}\n`, CHAT_TOKEN],
    ["assigned secret", "c.env", `${assign("password", SECRET)}\n`, SECRET],
    ["assigned secret", "c.json", `{ "API_KEY": "${SECRET}" }\n`, SECRET],
    ["assigned secret", "c.yml", `${assign("auth_token", SECRET, ": ", "'")}\n`, SECRET],
    ["assigned secret", "c.js", `const o = { ${assign("apikey", SECRET, ":", "'")} };\n`, SECRET],
  ];

  for (const [kind, file, body, planted] of forms) {
    it(`reports ${kind} in ${file} without printing it`, async () => {
      const record = await run({ "README.txt": "x\n" }, { [file]: `# header\n${body}` });
      expect(record.name).toBe("RT-26");
      expect(record.status).toBe("fail");
      expect(record.evidence).toEqual([`${file}:2: ${kind}`]);
      expectNoLeak(record.evidence, [planted, SECRET]);
    });
  }

  it("reports one line per matching entry and the line number in the candidate", async () => {
    const line = `${assign("password", SECRET)} ${ACCESS_KEY}`;
    const record = await run({ "a.txt": "one\ntwo\n" }, { "a.txt": `one\ntwo\n${line}\n` });
    expect(record.evidence).toEqual(["a.txt:3: cloud access key id", "a.txt:3: assigned secret"]);
  });

  it("passes a clean range with one evidence line", async () => {
    const record = await run({ "a.txt": "x\n" }, { "a.txt": "y\n" });
    expect(record).toEqual({ name: "RT-26", status: "pass", evidence: ["no credential in the lines the range adds"] });
  });

  it("says nothing of a credential the base already holds on a line the range leaves alone", async () => {
    const record = await run({ "a.txt": `${ACCESS_KEY}\nx\n` }, { "a.txt": `${ACCESS_KEY}\nx\ny\n` });
    expect(record.status).toBe("pass");
  });

  it("says nothing of a line the range removes", async () => {
    const record = await run({ "a.txt": `${HOST_TOKEN}\nx\n` }, { "a.txt": "x\n", "b.txt": `${HOST_TOKEN.slice(0, 8)}\n` });
    expect(record.status).toBe("pass");
    const deleted = await run({ "d.txt": `${ACCESS_KEY}\n` }, { "d.txt": null });
    expect(deleted.status).toBe("pass");
  });

  it("says nothing of placeholders, short values, names and unquoted values", async () => {
    const lines = [
      assign("password", "hunter2"),
      assign("api_key", rep("x", 19)),
      `password = ${SECRET}`,
      `const password = process.env.${rep("A", 24)};`,
      "api_key: <your key here>",
      `${["AK", "IA"].join("")}${rep("Q", 15)}`,
      `${["AK", "IA"].join("")}${rep("Q", 17)}`,
      `${["gh", "p_"].join("")}${rep("a", 10)}`,
      `${["xo", "xb-"].join("")}${rep("1", 4)}`,
      "-----BEGIN CERTIFICATE-----",
      `password = "${rep("a", 10)} ${rep("b", 10)}"`,
    ];
    const record = await run({ "a.txt": "x\n" }, { "a.txt": `${lines.join("\n")}\n` });
    expect(record.status).toBe("pass");
  });

  it("does not read a binary file", async () => {
    const bytes = Buffer.concat([Buffer.from(`${ACCESS_KEY}\n`), Buffer.from([0, 1, 2]), Buffer.from(`${HOST_TOKEN}\n`)]);
    const record = await run({ "a.txt": "x\n" }, { "blob.bin": bytes });
    expect(record.status).toBe("pass");
    const changed = await run({ "m.bin": Buffer.from([0, 1, 2]) }, { "m.bin": bytes });
    expect(changed.status).toBe("pass");
  });

  it("reads only the added lines of a renamed file", async () => {
    const pad = Array.from({ length: 10 }, (_, i) => `pad ${i}`).join("\n");
    const record = await run(
      { "old.txt": `${pad}\n${ACCESS_KEY}\n` },
      { "old.txt": null, "new.txt": `${pad}\n${ACCESS_KEY}\n` },
    );
    expect(record.status).toBe("pass");
    const added = await run({ "o2.txt": `${pad}\n` }, { "o2.txt": null, "n2.txt": `${pad}\n${HOST_TOKEN}\n` });
    expect(added.evidence).toEqual(["n2.txt:11: code host token"]);
  });

  it("escapes a path outside printable ASCII", async () => {
    const record = await run({ "a.txt": "x\n" }, { "café \u{1f511}.txt": `${ACCESS_KEY}\n` });
    expect(record.evidence).toEqual(["caf\\u{00e9} \\u{1f511}.txt:1: cloud access key id"]);
    expect(/^[\x20-\x7e]*$/.test(record.evidence[0] ?? "")).toBe(true);
  });

  it("applies an entry a consumer appends", async () => {
    CREDENTIAL_SHAPES.push({ name: "custom", pattern: /zzcustom\d+/g });
    try {
      const record = await run({ "a.txt": "x\n" }, { "a.txt": "zzcustom42\nzzcustom43\n" });
      expect(record.status).toBe("fail");
      expect(record.evidence).toEqual(["a.txt:1: custom", "a.txt:2: custom"]);
    } finally {
      CREDENTIAL_SHAPES.pop();
    }
  });

  it("fails closed on a revision that names no commit", async () => {
    const good = await commit(repo, { "a.txt": "x\n" });
    const missing = await check({ cwd: repo, base: "no-such-revision", candidate: good });
    expect(missing.status).toBe("fail");
    expect(missing.evidence.join("\n")).toContain("no-such-revision");
    const dashed = await check({ cwd: repo, base: good, candidate: "--output=x" });
    expect(dashed.status).toBe("fail");
  });

  it("fails closed when git itself fails", async () => {
    const record = await check({ cwd: join(repo, "does-not-exist"), base: "HEAD", candidate: "HEAD" });
    expect(record.status).toBe("fail");
    expect(record.evidence.length).toBeGreaterThan(0);
  });

  it("is the only record `repo-truth check --check RT-26` prints", async () => {
    await commit(repo, { "m.txt": "x\n" }, "base");
    await commit(repo, { "m.txt": `${ACCESS_KEY}\n` }, "change");
    let stdout = "";
    const code = await main(["check", "--check", "RT-26", "--no-fetch", "--base", "HEAD~1", "--candidate", "main", "--format", "json"], {
      cwd: repo,
      stdout: (t) => void (stdout += t),
      stderr: () => undefined,
    });
    expect(code).not.toBe(0);
    expect(stdout).not.toContain(ACCESS_KEY);
    const parsed = JSON.parse(stdout) as unknown;
    const records = (Array.isArray(parsed) ? parsed : (parsed as { records: unknown[] }).records) as { name: string }[];
    expect(records.map((r) => r.name)).toEqual(["RT-26"]);
  });
});
