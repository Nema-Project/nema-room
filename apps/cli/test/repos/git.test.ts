import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { changedFiles, exportSnapshot, fetchMain, inspectRepo, mainRef, readFileAtRef, revParse } from "../../src/repos/git.js";

let root: string;
let savedHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nema-git-"));
  savedHome = process.env.HOME;
  const home = join(root, "home");
  mkdirSync(home);
  process.env.HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

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

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
}

function commitAll(dir: string, message: string): string {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

function setupOrigin(): { repo: string; bare: string; nemaHome: string } {
  const nemaHome = join(root, "nema-home");
  mkdirSync(nemaHome);
  const bare = join(root, "origin.git");
  git(root, ["init", "--bare", "-b", "main", bare]);
  const repo = join(root, "repo");
  initRepo(repo);
  writeFileSync(join(repo, "README.md"), "hello\n");
  commitAll(repo, "init");
  git(repo, ["remote", "add", "origin", bare]);
  git(repo, ["push", "-u", "origin", "main"]);
  return { repo, bare, nemaHome };
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, prefix: string) => {
    for (const name of readdirSync(current)) {
      if (name === ".git") continue;
      const abs = join(current, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (lstatSync(abs).isDirectory()) walk(abs, rel);
      else out.push(rel);
    }
  };
  walk(dir, "");
  return out.sort();
}

function assertNoSymlinks(dir: string): void {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = lstatSync(abs);
    expect(st.isSymbolicLink()).toBe(false);
    if (st.isDirectory()) assertNoSymlinks(abs);
  }
}

test("inspectRepo reports root, common dir, default branch and origin", async () => {
  const { repo, bare, nemaHome } = setupOrigin();
  git(repo, ["checkout", "-b", "develop"]);
  writeFileSync(join(repo, "dev.txt"), "d\n");
  commitAll(repo, "dev");
  git(repo, ["push", "origin", "develop"]);
  git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop"]);

  await expect(inspectRepo(repo, nemaHome)).resolves.toEqual({
    root: realpathSync(repo),
    gitCommonDir: realpathSync(join(repo, ".git")),
    defaultBranch: "develop",
    hasOrigin: true,
    remoteUrl: bare,
  });
});

test("inspectRepo strips userinfo from a scheme URL and keeps an scp-style URL", async () => {
  const nemaHome = join(root, "nema-home");
  mkdirSync(nemaHome);
  const repo = join(root, "repo");
  initRepo(repo);
  git(repo, ["remote", "add", "origin", "https://user:SECRET_TOKEN@example.com/a.git"]);
  expect((await inspectRepo(repo, nemaHome)).remoteUrl).toBe("https://example.com/a.git");

  git(repo, ["remote", "set-url", "origin", "https://SECRET_TOKEN@example.com/a.git"]);
  expect((await inspectRepo(repo, nemaHome)).remoteUrl).toBe("https://example.com/a.git");

  git(repo, ["remote", "set-url", "origin", "git@example.com:team/a.git"]);
  expect((await inspectRepo(repo, nemaHome)).remoteUrl).toBe("git@example.com:team/a.git");
});

test("inspectRepo rejects a subdirectory and a path under nemaHome", async () => {
  const { repo, nemaHome } = setupOrigin();
  mkdirSync(join(repo, "sub"));
  await expect(inspectRepo(join(repo, "sub"), nemaHome)).rejects.toThrow("不是 git 仓库的根目录");

  const inside = join(nemaHome, "proj");
  initRepo(inside);
  writeFileSync(join(inside, "a.txt"), "a\n");
  commitAll(inside, "init");
  await expect(inspectRepo(inside, nemaHome)).rejects.toThrow("不能绑定 ~/.nema 之下的目录");
});

test("inspectRepo rejects a repo whose root contains nemaHome", async () => {
  const repo = join(root, "outer");
  initRepo(repo);
  writeFileSync(join(repo, "a.txt"), "a\n");
  commitAll(repo, "init");
  const nemaHome = join(repo, ".nema");
  mkdirSync(nemaHome);
  await expect(inspectRepo(repo, nemaHome)).rejects.toThrow("不能绑定包含 ~/.nema 的目录");
});

test("inspectRepo returns the same gitCommonDir for the real root, a trailing slash, and a symlink", async () => {
  const nemaHome = join(root, "nema-home");
  mkdirSync(nemaHome);
  const repo = join(root, "repo");
  initRepo(repo);
  writeFileSync(join(repo, "a.txt"), "a\n");
  commitAll(repo, "init");
  const link = join(root, "repo-link");
  symlinkSync(repo, link);

  const common = realpathSync(join(repo, ".git"));
  const real = await inspectRepo(repo, nemaHome);
  const slash = await inspectRepo(`${repo}/`, nemaHome);
  const viaLink = await inspectRepo(link, nemaHome);
  expect(real.gitCommonDir).toBe(common);
  expect(slash.gitCommonDir).toBe(common);
  expect(viaLink.gitCommonDir).toBe(common);
});

test("inspectRepo on a repo without origin reports hasOrigin false and default branch main", async () => {
  const nemaHome = join(root, "nema-home");
  mkdirSync(nemaHome);
  const repo = join(root, "repo");
  initRepo(repo);
  writeFileSync(join(repo, "a.txt"), "a\n");
  commitAll(repo, "init");
  git(repo, ["checkout", "-b", "develop"]);

  const info = await inspectRepo(repo, nemaHome);
  expect(info.hasOrigin).toBe(false);
  expect(info.remoteUrl).toBeNull();
  expect(info.defaultBranch).toBe("main");
});

test("mainRef prefers origin/<branch> and falls back to the local branch", async () => {
  const { repo } = setupOrigin();
  expect(await mainRef(repo, "main")).toBe("origin/main");
  expect(await mainRef(repo, "absent")).toBe("absent");

  const local = join(root, "local-only");
  initRepo(local);
  writeFileSync(join(local, "a.txt"), "a\n");
  commitAll(local, "init");
  expect(await mainRef(local, "main")).toBe("main");
});

test("fetchMain picks up a commit pushed to origin without changing the working tree or local branch", async () => {
  const { repo, bare } = setupOrigin();
  const other = join(root, "other");
  git(root, ["clone", bare, other]);
  git(other, ["config", "user.email", "test@example.com"]);
  git(other, ["config", "user.name", "Test"]);
  writeFileSync(join(other, "remote-only.txt"), "from-origin\n");
  commitAll(other, "remote");
  git(other, ["push", "origin", "main"]);

  writeFileSync(join(repo, "README.md"), "dirty\n");
  const statusBefore = git(repo, ["status", "--porcelain"]);
  const mainBefore = git(repo, ["rev-parse", "main"]).trim();
  const filesBefore = listFiles(repo);
  const branchesBefore = git(repo, ["for-each-ref", "--format=%(refname)", "refs/heads"]);

  await expect(fetchMain(repo, "main")).resolves.toEqual({ ok: true });

  expect(git(repo, ["for-each-ref", "--format=%(refname)", "refs/heads"])).toBe(branchesBefore);
  expect(git(repo, ["status", "--porcelain"])).toBe(statusBefore);
  expect(git(repo, ["rev-parse", "main"]).trim()).toBe(mainBefore);
  expect(listFiles(repo)).toEqual(filesBefore);
  expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("dirty\n");
  expect(git(repo, ["rev-parse", "origin/main"]).trim()).toBe(git(other, ["rev-parse", "HEAD"]).trim());
});

test("fetchMain rejects a branch that is not a single name and never writes a local branch", async () => {
  const { repo } = setupOrigin();
  const branchesBefore = git(repo, ["for-each-ref", "--format=%(refname)", "refs/heads"]);
  for (const name of ["main:refs/heads/evil", "+main", "-main", "", "a..b", "a@{1}", "a//b", "a\\b", "a/", "a.lock"]) {
    await expect(fetchMain(repo, name)).resolves.toEqual({ ok: false, error: "主分支名称无效" });
  }
  expect(git(repo, ["for-each-ref", "--format=%(refname)", "refs/heads"])).toBe(branchesBefore);
});

test("git commands see SSH_AUTH_SOCK and a BatchMode ssh, and nothing else from the environment", async () => {
  const bin = join(root, "fake-bin");
  const envFile = join(root, "git-env");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh
env > "${envFile}"
if [ "$3" = "remote" ]; then echo origin; fi
`,
    { mode: 0o755 },
  );
  const saved = { PATH: process.env.PATH, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK, NEMA_UNRELATED: process.env.NEMA_UNRELATED };
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.SSH_AUTH_SOCK = "/tmp/agent.sock";
  process.env.NEMA_UNRELATED = "leak";
  try {
    await expect(fetchMain(root, "main")).resolves.toEqual({ ok: true });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const env = readFileSync(envFile, "utf8");
  expect(env).toContain("SSH_AUTH_SOCK=/tmp/agent.sock\n");
  expect(env).toContain("GIT_SSH_COMMAND=ssh -o BatchMode=yes\n");
  expect(env).not.toContain("NEMA_UNRELATED");
});

test("fetchMain without origin returns 没有 origin", async () => {
  const repo = join(root, "repo");
  initRepo(repo);
  writeFileSync(join(repo, "a.txt"), "a\n");
  commitAll(repo, "init");
  await expect(fetchMain(repo, "main")).resolves.toEqual({ ok: false, error: "没有 origin" });
});

test("revParse returns the full sha", async () => {
  const repo = join(root, "repo");
  initRepo(repo);
  writeFileSync(join(repo, "a.txt"), "a\n");
  const sha = commitAll(repo, "init");
  expect(await revParse(repo, "HEAD")).toBe(sha);
  expect(await revParse(repo, sha.slice(0, 7))).toBe(sha);
});

test("readFileAtRef reads a line range at origin/main, not the working tree", async () => {
  const { repo } = setupOrigin();
  writeFileSync(join(repo, "notes.txt"), "alpha\nbeta\ngamma\n");
  commitAll(repo, "notes");
  git(repo, ["push", "origin", "main"]);
  writeFileSync(join(repo, "notes.txt"), "DIRTY\n");

  await expect(readFileAtRef(repo, "origin/main", "notes.txt", { startLine: 2, endLine: 3 })).resolves.toEqual({
    path: "notes.txt",
    startLine: 2,
    endLine: 3,
    totalLines: 3,
    text: "beta\ngamma",
    truncated: false,
  });
  expect(readFileSync(join(repo, "notes.txt"), "utf8")).toBe("DIRTY\n");
});

test("readFileAtRef rejects absolute, empty, .. and a/../../x paths", async () => {
  const { repo } = setupOrigin();
  writeFileSync(join(repo, "notes.txt"), "alpha\n");
  commitAll(repo, "notes");
  for (const relPath of ["/etc/passwd", "", "..", "a/../../x"]) {
    await expect(readFileAtRef(repo, "HEAD", relPath)).rejects.toThrow("路径必须是仓库内的相对路径");
  }
  await expect(readFileAtRef(repo, "HEAD", "sub/../notes.txt")).resolves.toMatchObject({
    path: "notes.txt",
    text: "alpha",
  });
});

test("readFileAtRef does not return the only blob for . or foo/..", async () => {
  const repo = join(root, "repo");
  initRepo(repo);
  writeFileSync(join(repo, "only.txt"), "only\nsecond\nthird\n");
  commitAll(repo, "only");

  await expect(readFileAtRef(repo, "HEAD", ".")).rejects.toThrow(". 不存在于 HEAD");
  await expect(readFileAtRef(repo, "HEAD", "foo/..")).rejects.toThrow(". 不存在于 HEAD");
  await expect(readFileAtRef(repo, "HEAD", ":(literal)only.txt")).rejects.toThrow(":(literal)only.txt 不存在于 HEAD");
  await expect(readFileAtRef(repo, "HEAD", "only.txt")).resolves.toMatchObject({
    path: "only.txt",
    text: "only\nsecond\nthird",
  });
});

test("readFileAtRef rejects a symlink blob", async () => {
  const repo = join(root, "repo");
  initRepo(repo);
  const secret = join(root, "host-secret.txt");
  writeFileSync(secret, "secret\n");
  symlinkSync(secret, join(repo, "escape"));
  mkdirSync(join(repo, "subdir"));
  writeFileSync(join(repo, "subdir", "f.txt"), "f\n");
  commitAll(repo, "link");

  await expect(readFileAtRef(repo, "HEAD", "escape")).rejects.toThrow("escape 是符号链接，已拒绝");
  await expect(readFileAtRef(repo, "HEAD", "subdir")).rejects.toThrow("subdir 不存在于 HEAD");
  await expect(readFileAtRef(repo, "HEAD", "missing.txt")).rejects.toThrow("missing.txt 不存在于 HEAD");
});

test("readFileAtRef caps at 400 lines and 64 KB and sets truncated", async () => {
  const repo = join(root, "repo");
  initRepo(repo);
  const lines = Array.from({ length: 500 }, (_, i) => `L${i + 1}`);
  writeFileSync(join(repo, "big.txt"), `${lines.join("\n")}\n`);
  const wide = "x".repeat(70_000);
  writeFileSync(join(repo, "wide.txt"), wide);
  commitAll(repo, "big");

  const capped = await readFileAtRef(repo, "HEAD", "big.txt");
  expect(capped).toEqual({
    path: "big.txt",
    startLine: 1,
    endLine: 400,
    totalLines: 500,
    text: lines.slice(0, 400).join("\n"),
    truncated: true,
  });

  const inside = await readFileAtRef(repo, "HEAD", "big.txt", { startLine: 10, endLine: 12 });
  expect(inside).toEqual({
    path: "big.txt",
    startLine: 10,
    endLine: 12,
    totalLines: 500,
    text: "L10\nL11\nL12",
    truncated: false,
  });

  const bytes = await readFileAtRef(repo, "HEAD", "wide.txt");
  expect(bytes.truncated).toBe(true);
  expect(bytes.totalLines).toBe(1);
  expect(bytes.startLine).toBe(1);
  expect(Buffer.byteLength(bytes.text)).toBe(65_536);
  expect(wide.startsWith(bytes.text)).toBe(true);
});

test("changedFiles lists added, modified, deleted and renamed paths", async () => {
  const { repo } = setupOrigin();
  writeFileSync(join(repo, "kept.txt"), "one\n");
  writeFileSync(join(repo, "gone.txt"), "bye\n");
  writeFileSync(join(repo, "old-name.txt"), "same\n");
  const parent = commitAll(repo, "base");
  writeFileSync(join(repo, "kept.txt"), "two\n");
  rmSync(join(repo, "gone.txt"));
  git(repo, ["mv", "old-name.txt", "renamed.txt"]);
  writeFileSync(join(repo, "added.txt"), "new\n");
  const child = commitAll(repo, "edit");
  git(repo, ["push", "origin", "main"]);

  const rows = await changedFiles(repo, parent, child, "main");
  expect(rows.map((row) => `${row.status} ${row.path}`).sort()).toEqual(
    ["A added.txt", "D gone.txt", "D old-name.txt", "M kept.txt", "R100 renamed.txt"].sort(),
  );

  const viaMain = await changedFiles(repo, parent.slice(0, 7), "origin/main", "main");
  expect(viaMain.map((row) => row.path).sort()).toEqual(["added.txt", "gone.txt", "kept.txt", "old-name.txt", "renamed.txt"]);
  expect(await revParse(repo, "origin/main")).toBe(child);
});

test("changedFiles rejects a non-sha ref other than the main ref, and a sha main does not contain", async () => {
  const { repo } = setupOrigin();
  writeFileSync(join(repo, "a.txt"), "a\n");
  const parent = commitAll(repo, "a");
  writeFileSync(join(repo, "a.txt"), "b\n");
  const child = commitAll(repo, "b");
  git(repo, ["push", "origin", "main"]);

  await expect(changedFiles(repo, "HEAD", child, "main")).rejects.toThrow("提交 HEAD 不在主分支上");
  await expect(changedFiles(repo, parent, "main", "main")).rejects.toThrow("提交 main 不在主分支上");
  await expect(changedFiles(repo, "abc", child, "main")).rejects.toThrow("提交 abc 不在主分支上");
  await expect(changedFiles(repo, parent.toUpperCase(), child, "main")).rejects.toThrow(`提交 ${parent.toUpperCase()} 不在主分支上`);
  await expect(changedFiles(repo, "--output=/tmp/x", child, "main")).rejects.toThrow("提交 --output=/tmp/x 不在主分支上");
  await expect(changedFiles(repo, parent, child, "main~1")).rejects.toThrow("主分支名称无效");
  await expect(changedFiles(repo, parent, "origin/main", "main")).resolves.toEqual([{ status: "M", path: "a.txt" }]);
});

test("exportSnapshot writes the ref's tree into destDir and leaves the repo untouched", async () => {
  const { repo } = setupOrigin();
  mkdirSync(join(repo, "sub"));
  writeFileSync(join(repo, "a.txt"), "aaa\n");
  writeFileSync(join(repo, "sub", "b.txt"), "bee\n");
  const secret = join(root, "host-secret.txt");
  writeFileSync(secret, "do-not-leak\n");
  symlinkSync(secret, join(repo, "escape"));
  const sha = commitAll(repo, "files");
  writeFileSync(join(repo, "a.txt"), "dirty\n");
  const status = git(repo, ["status", "--porcelain"]);
  const head = git(repo, ["rev-parse", "HEAD"]).trim();
  const main = git(repo, ["rev-parse", "main"]).trim();

  const dest = join(root, "snap");
  mkdirSync(dest);
  writeFileSync(join(dest, "stale.txt"), "stale\n");
  await exportSnapshot(repo, sha, dest);

  expect(readFileSync(join(dest, "a.txt"), "utf8")).toBe("aaa\n");
  expect(readFileSync(join(dest, "sub", "b.txt"), "utf8")).toBe("bee\n");
  expect(() => lstatSync(join(dest, "stale.txt"))).toThrow(/ENOENT/);
  expect(() => lstatSync(join(dest, "escape"))).toThrow(/ENOENT/);
  assertNoSymlinks(dest);
  expect(readFileSync(secret, "utf8")).toBe("do-not-leak\n");
  expect(git(repo, ["status", "--porcelain"])).toBe(status);
  expect(git(repo, ["rev-parse", "HEAD"]).trim()).toBe(head);
  expect(git(repo, ["rev-parse", "main"]).trim()).toBe(main);
  expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("dirty\n");
});
