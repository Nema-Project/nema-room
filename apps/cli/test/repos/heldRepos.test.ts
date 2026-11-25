import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { computeHeldRepos } from "../../src/repos/heldRepos.js";
import { RepoWatcher } from "../../src/repos/watcher.js";

let root: string;
let nemaHome: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nema-held-"));
  nemaHome = join(root, "nema-home");
  mkdirSync(nemaHome);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
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
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

function initRepo(name: string, remote?: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-b", "main"]);
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "init"]);
  if (remote) git(dir, ["remote", "add", "origin", remote]);
  return dir;
}

test("watched repos report their normalized remotes; uninspectable paths are skipped", async () => {
  const https = initRepo("https-repo", "https://github.com/acme/widget.git");
  const scp = initRepo("scp-repo", "git@github.com:acme/widget.git");
  const noRemote = initRepo("plain-repo");
  const gone = join(root, "gone");
  mkdirSync(gone);
  const watcher = new RepoWatcher({ nemaHome, onMoved: () => {}, onFetch: () => {} });
  watcher.setRepos([
    { workspaceId: "ws1", repoId: "r1", path: https, mainBranch: "main", lastMainSha: null },
    { workspaceId: "ws1", repoId: "r2", path: scp, mainBranch: "main", lastMainSha: null },
    { workspaceId: "ws1", repoId: "r3", path: noRemote, mainBranch: "main", lastMainSha: null },
    { workspaceId: "ws1", repoId: "r4", path: gone, mainBranch: "main", lastMainSha: null },
  ]);
  // The https and scp forms name the same repo, so they collapse to one entry.
  expect(await computeHeldRepos(watcher, nemaHome)).toEqual(["github.com/acme/widget"]);
});

test("an empty watch list reports nothing", async () => {
  const watcher = new RepoWatcher({ nemaHome, onMoved: () => {}, onFetch: () => {} });
  expect(await computeHeldRepos(watcher, nemaHome)).toEqual([]);
});
