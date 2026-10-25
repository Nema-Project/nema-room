import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { unexpectedEnvKeys } from "../windowsEnv.js";
import { commitWithSymlink } from "./gitSymlink.js";
import { afterEach, beforeEach, expect, test } from "vitest";
import { changedFiles } from "../../src/repos/git.js";
import { buildIndex, graphifyInstallStatus, queryIndex, updateIndex, type GraphifyOpts } from "../../src/repos/graphify.js";
import type { OwnedHelperProcess, OwnedHelperScope } from "@nema/shared/ownedHelper";

let root: string;
let savedHome: string | undefined;
let savedLang: string | undefined;
let fake: GraphifyOpts;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nema-graphify-"));
  savedHome = process.env.HOME;
  savedLang = process.env.LANG;
  fake = { bin: join(root, "missing-graphify") };
  mkdirSync(join(root, "home"));
  process.env.HOME = join(root, "home");
  process.env.LANG = "C.UTF-8";
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedLang === undefined) delete process.env.LANG;
  else process.env.LANG = savedLang;
  rmSync(root, { recursive: true, force: true });
});

function writeBin(name: string, body: string): string {
  const file = join(root, name);
  writeFileSync(file, body, { mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

function parseEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readFileSync(file).toString("utf8").split("\0")) {
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq < 0) continue;
    out[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return out;
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: process.env.LANG ?? "C",
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.autocrlf", GIT_CONFIG_VALUE_0: "false",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
  } catch (e) {
    const stderr = e && typeof e === "object" && "stderr" in e ? String((e as { stderr?: unknown }).stderr ?? "") : "";
    throw new Error(`git ${args.join(" ")} failed\n${stderr}`, { cause: e });
  }
}

test("graphify runs with only PATH, LANG, HOME=<root>/home, GRAPHIFY_BACKEND=none, GRAPHIFY_QUERY_LOG_DISABLE=1", async () => {
  const snapshot = join(root, "snap");
  const record = join(root, "record");
  mkdirSync(snapshot);
  mkdirSync(record);
  fake.bin = writeBin(
    "graphify.cjs",
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(join(record, "cwd"))}, process.cwd());
fs.writeFileSync(${JSON.stringify(join(record, "argv"))}, process.argv.slice(2).join("\\n") + "\\n");
const env = Object.entries(process.env).map(([key, value]) => key + "=" + value).join("\\0") + "\\0";
fs.writeFileSync(${JSON.stringify(join(record, "env"))}, env);
fs.mkdirSync("graphify-out", { recursive: true });
fs.writeFileSync("graphify-out/graph.json", "{}");
`,
  );

  await buildIndex(snapshot, fake);

  const src = join(snapshot, "src");
  expect(readFileSync(join(record, "argv"), "utf8")).toBe(`extract\n${src}\n--code-only\n`);
  const env = parseEnv(join(record, "env"));
  const passed = ["GRAPHIFY_BACKEND", "GRAPHIFY_QUERY_LOG_DISABLE", "HOME", "LANG", "PATH"];
  // macOS injects __CF_USER_TEXT_ENCODING after exec, and Windows adds runtime/profile variables. Neither is passed by us.
  const leaked = unexpectedEnvKeys(Object.keys(env), passed).filter((key) => key !== "__CF_USER_TEXT_ENCODING");
  expect(leaked).toEqual([]);
  expect(env.PATH).toBe(process.env.PATH);
  expect(env.LANG).toBe("C.UTF-8");
  expect(env.HOME).toBe(join(snapshot, "home"));
  expect(env.GRAPHIFY_BACKEND).toBe("none");
  expect(env.GRAPHIFY_QUERY_LOG_DISABLE).toBe("1");
  expect(env.HOME).not.toBe(process.env.HOME);
  expect(env).not.toHaveProperty("NEMA_GRAPHIFY_BIN");
});

test("a graphify timeout settles only after its child has exited", async () => {
  const snapshot = join(root, "timeout-snapshot");
  const pidFile = join(root, "timeout-child-pid");
  mkdirSync(snapshot);
  fake = { bin: writeBin("graphify-timeout.cjs", `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`), timeoutMs: 500 };
  await expect(buildIndex(snapshot, fake)).rejects.toThrow("graphify 已中断");
  const pid = Number(readFileSync(pidFile, "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
});

test("queryIndex maps exit 3 to 名称不唯一 and exit 4 to 没有匹配", async () => {
  const snapshot = join(root, "snap");
  const record = join(root, "record");
  mkdirSync(join(snapshot, "src"), { recursive: true });
  mkdirSync(record);
  fake.bin = writeBin(
    "graphify-exit",
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(record + "/cwd")}, process.cwd() + "\\n");
fs.writeFileSync(${JSON.stringify(record + "/argv")}, args.join("\\n") + "\\n");
process.exit(Number(args[1]));
`,
  );

  await expect(queryIndex(snapshot, "query", ["3"], fake)).rejects.toThrow("名称不唯一");
  expect(readFileSync(join(record, "argv"), "utf8")).toBe("query\n3\n");
  expect(realpathSync(readFileSync(join(record, "cwd"), "utf8").trim())).toBe(realpathSync(snapshot));

  await expect(queryIndex(snapshot, "explain", ["4"], fake)).rejects.toThrow(/^没有匹配$/);
  expect(readFileSync(join(record, "argv"), "utf8")).toBe("explain\n4\n");

  await expect(queryIndex(snapshot, "path", ["0", "from", "to"], fake)).resolves.toBe("");
  expect(readFileSync(join(record, "argv"), "utf8")).toBe("path\n0\nfrom\nto\n");
});

test("queryIndex rejects a value that starts with - before spawning graphify", async () => {
  const snapshot = join(root, "snap");
  const record = join(root, "record");
  mkdirSync(join(snapshot, "src"), { recursive: true });
  mkdirSync(record);
  fake.bin = writeBin(
    "graphify-argv",
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(record + "/argv")}, args.join("\\n") + "\\n");
`,
  );

  await expect(queryIndex(snapshot, "path", ["Widget", "--output=/tmp/x"], fake)).rejects.toThrow("参数不能以 - 开头：--output=/tmp/x");
  expect(lstatSync(join(record, "argv"), { throwIfNoEntry: false })).toBeUndefined();

  await expect(queryIndex(snapshot, "query", ["a-b"], fake)).resolves.toBe("");
  expect(readFileSync(join(record, "argv"), "utf8")).toBe("query\na-b\n");
});

test("queryIndex caps output at 64 KB", async () => {
  const snapshot = join(root, "snap");
  mkdirSync(join(snapshot, "src"), { recursive: true });
  fake.bin = writeBin(
    "graphify-long",
    `#!/usr/bin/env node
process.stdout.write("x".repeat(70000));
`,
  );
  const text = await queryIndex(snapshot, "query", ["long"], fake);
  expect(text).toBe("x".repeat(65_536));
  expect(Buffer.byteLength(text)).toBe(65_536);
});

test("a missing graphify binary gives the install hint", async () => {
  const snapshot = join(root, "snap");
  mkdirSync(snapshot);
  fake.bin = join(snapshot, "missing-graphify");
  await expect(buildIndex(snapshot, fake)).rejects.toThrow("随包的 Graphify 运行环境缺失");
});

test("a missing packaged runtime does not run graphify from PATH", async () => {
  const savedPath = process.env.PATH;
  const savedBin = process.env.NEMA_GRAPHIFY_BIN;
  const savedPayload = process.env.NEMA_PAYLOAD_ROOT;
  const marker = join(root, "path-ran");
  const dir = join(root, "path-bin");
  mkdirSync(dir);
  writeFileSync(join(dir, "graphify"), `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran\\n");\nprocess.stdout.write("from-path\\n");\n`, { mode: 0o755 });
  chmodSync(join(dir, "graphify"), 0o755);
  process.env.PATH = `${dir}${delimiter}${savedPath ?? ""}`;
  delete process.env.NEMA_GRAPHIFY_BIN;
  process.env.NEMA_PAYLOAD_ROOT = join(root, "empty-payload");
  const snapshot = join(root, "snap-path");
  mkdirSync(snapshot);
  try {
    await expect(buildIndex(snapshot)).rejects.toThrow("随包的 Graphify 运行环境缺失");
    expect(existsSync(marker)).toBe(false);
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedBin === undefined) delete process.env.NEMA_GRAPHIFY_BIN;
    else process.env.NEMA_GRAPHIFY_BIN = savedBin;
    if (savedPayload === undefined) delete process.env.NEMA_PAYLOAD_ROOT;
    else process.env.NEMA_PAYLOAD_ROOT = savedPayload;
  }
});

test("managed graphify install status treats a missing binary as not installed", async () => {
  const missingScope: OwnedHelperScope = {
    spawn: async () => { throw Object.assign(new Error("missing helper"), { code: "ENOENT" }); },
    stopAccepting() {},
    async drain() {},
  };

  await expect(graphifyInstallStatus({ bin: join(root, "missing-graphify"), ownedHelpers: missingScope })).resolves.toEqual({
    installed: false,
    detail: "随包的 Graphify 运行环境缺失",
  });
});

test("updateIndex writes changed files, deletes removed ones and runs graphify update", async () => {
  const repo = join(root, "repo");
  const snapshot = join(root, "snap");
  const record = join(root, "record");
  mkdirSync(repo);
  mkdirSync(join(snapshot, "src", "sub"), { recursive: true });
  mkdirSync(record);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "keep.txt"), "new\n");
  mkdirSync(join(repo, "sub"));
  writeFileSync(join(repo, "sub", "nested.txt"), "nested\n");
  writeFileSync(join(repo, "added.txt"), "added\n");
  const secret = join(root, "secret.txt");
  writeFileSync(secret, "secret\n");
  commitWithSymlink(git, repo, "escape", secret, "files");

  writeFileSync(join(snapshot, "src", "keep.txt"), "old\n");
  writeFileSync(join(snapshot, "src", "gone.txt"), "bye\n");
  const outside = join(root, "outside.txt");
  fake.bin = writeBin(
    "graphify-update",
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(record + "/cwd")}, process.cwd() + "\\n");
fs.writeFileSync(${JSON.stringify(record + "/argv")}, args.join("\\n") + "\\n");
fs.mkdirSync("graphify-out", { recursive: true });
fs.writeFileSync("graphify-out/graph.json", "{}");
`,
  );

  await expect(updateIndex(snapshot, [{ status: "A", path: "../outside.txt" }], repo, "HEAD", fake)).rejects.toThrow("路径必须是仓库内的相对路径");
  expect(lstatSync(outside, { throwIfNoEntry: false })).toBeUndefined();

  await updateIndex(
    snapshot,
    [
      { status: "M", path: "keep.txt" },
      { status: "D", path: "gone.txt" },
      { status: "A", path: "sub/nested.txt" },
      { status: "A", path: "added.txt" },
      { status: "A", path: "escape" },
    ],
    repo,
    "HEAD",
    fake,
  );

  expect(readFileSync(join(snapshot, "src", "keep.txt"), "utf8")).toBe("new\n");
  expect(readFileSync(join(snapshot, "src", "sub", "nested.txt"), "utf8")).toBe("nested\n");
  expect(readFileSync(join(snapshot, "src", "added.txt"), "utf8")).toBe("added\n");
  expect(lstatSync(join(snapshot, "src", "gone.txt"), { throwIfNoEntry: false })).toBeUndefined();
  expect(lstatSync(join(snapshot, "src", "escape"), { throwIfNoEntry: false })).toBeUndefined();
  expect(readFileSync(secret, "utf8")).toBe("secret\n");
  expect(readFileSync(join(record, "argv"), "utf8")).toBe(`update\n${join(snapshot, "src")}\n--code-only\n`);
  expect(realpathSync(readFileSync(join(record, "cwd"), "utf8").trim())).toBe(realpathSync(snapshot));
});

test("managed incremental update fetches blob data through its owned helper scope", async () => {
  const repo = join(root, "managed-repo");
  const snapshot = join(root, "managed-snapshot");
  const calls: Array<{ command: string; args: string[] }> = [];
  const children: OwnedHelperProcess[] = [];
  const scope: OwnedHelperScope = {
    async spawn(command, args, options = {}) {
      calls.push({ command, args });
      const child: ChildProcess = spawn(command, args, { ...options, windowsHide: true });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
      const owned: OwnedHelperProcess = {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        kill: (signal) => child.kill(signal),
        exited,
        closed,
      };
      children.push(owned);
      return owned;
    },
    stopAccepting() {},
    async drain() { await Promise.all(children.map((child) => child.closed)); },
  };
  mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "picked.txt"), "from committed blob\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "blob"]);
  const bin = writeBin("graphify-managed", "#!/usr/bin/env node\n");

  await updateIndex(snapshot, [{ status: "A", path: "picked.txt" }], repo, "HEAD", { ...fake, bin, ownedHelpers: scope });

  expect(readFileSync(join(snapshot, "src", "picked.txt"), "utf8")).toBe("from committed blob\n");
  expect(calls.some(({ args }) => args.includes("ls-tree"))).toBe(true);
  expect(calls.some(({ args }) => args.includes("cat-file"))).toBe(true);
  // Where graphify is a Node script (Windows) it is launched as `node <bin>`; elsewhere it is the command itself.
  expect(calls.some(({ command, args }) => command === bin || args.includes(bin))).toBe(true);
  await scope.drain();
});

test("a rename from changedFiles removes the old snapshot file and writes the new one", async () => {
  const repo = join(root, "repo");
  const snapshot = join(root, "snap");
  mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, "old-name.txt"), "same\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "base"]);
  const parent = git(repo, ["rev-parse", "HEAD"]).trim();
  git(repo, ["mv", "old-name.txt", "new-name.txt"]);
  git(repo, ["commit", "-m", "rename"]);
  const child = git(repo, ["rev-parse", "HEAD"]).trim();
  mkdirSync(join(snapshot, "src"), { recursive: true });
  writeFileSync(join(snapshot, "src", "old-name.txt"), "same\n");
  fake.bin = writeBin("graphify-noop", "#!/usr/bin/env node\n");

  await updateIndex(snapshot, await changedFiles(repo, parent, child, "main"), repo, child, fake);

  expect(lstatSync(join(snapshot, "src", "old-name.txt"), { throwIfNoEntry: false })).toBeUndefined();
  expect(readFileSync(join(snapshot, "src", "new-name.txt"), "utf8")).toBe("same\n");
});

test("graphify update is called with --code-only", async () => {
  const repo = join(root, "repo");
  const snapshot = join(root, "snap");
  const argv = join(root, "argv");
  mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "a"]);
  const bin = writeBin("graphify-argv", `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argv)}, args.join("\\n") + "\\n");
`);

  await updateIndex(snapshot, [{ status: "A", path: "a.txt" }], repo, "HEAD", { bin });

  expect(readFileSync(argv, "utf8")).toBe(`update\n${join(snapshot, "src")}\n--code-only\n`);
});
