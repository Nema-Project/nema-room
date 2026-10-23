import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RpcRouter } from "../../src/daemon/rpc.js";
import { registerRepoHandlers } from "../../src/repos/handlers.js";
import { checkReport } from "../../src/repos/reportCheck.js";

vi.setConfig({ testTimeout: 20_000 });

let root: string;
let savedHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nema-report-check-"));
  savedHome = process.env.HOME;
  mkdirSync(join(root, "home"));
  process.env.HOME = join(root, "home");
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
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
    }).trim();
  } catch (e) {
    const stderr = e && typeof e === "object" && "stderr" in e ? String((e as { stderr?: unknown }).stderr ?? "") : "";
    throw new Error(`git ${args.join(" ")} failed\n${stderr}`, { cause: e });
  }
}

function commitAll(dir: string, message: string): string {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

/** A repo with a local bare origin and one pushed commit on main. */
function setup(): { repo: string; nemaHome: string } {
  const nemaHome = join(root, "nema-home");
  mkdirSync(nemaHome);
  const bare = join(root, "origin.git");
  git(root, ["init", "--bare", "-b", "main", bare]);
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "v1\n");
  commitAll(repo, "init");
  git(repo, ["remote", "add", "origin", bare]);
  git(repo, ["push", "-u", "origin", "main"]);
  return { repo, nemaHome };
}

/** Two commits on a feature branch, which is then left (main checked out). */
function featurePair(repo: string): [string, string] {
  git(repo, ["checkout", "-b", "feature"]);
  writeFileSync(join(repo, "a.txt"), "a\n");
  const first = commitAll(repo, "a");
  writeFileSync(join(repo, "b.txt"), "b\n");
  const second = commitAll(repo, "b");
  git(repo, ["checkout", "main"]);
  return [first, second];
}

/** Squash-merges `feature` into main as one new commit and pushes it. */
function squashFeature(repo: string): string {
  git(repo, ["merge", "--squash", "feature"]);
  const squash = commitAll(repo, "squash feature");
  git(repo, ["push", "origin", "main"]);
  return squash;
}

test("a merged commit passes", async () => {
  const { repo } = setup();
  writeFileSync(join(repo, "a.txt"), "a\n");
  const sha = commitAll(repo, "a");
  git(repo, ["push", "origin", "main"]);
  const check = await checkReport(repo, "origin/main", [sha.slice(0, 10)], ["a.txt"]);
  expect(check).toMatchObject({ commitsExist: true, missingCommits: [], onMain: "yes", filesOk: true, untouchedFiles: [] });
  expect(check.mainSha).toBe(sha);
  expect(Number.isNaN(Date.parse(check.checkedAt))).toBe(false);
});

test("a missing sha fails with missingCommits", async () => {
  const { repo } = setup();
  const head = git(repo, ["rev-parse", "HEAD"]);
  const missing = "deadbeef".repeat(5);
  const check = await checkReport(repo, "origin/main", [head, missing], []);
  expect(check.commitsExist).toBe(false);
  expect(check.missingCommits).toEqual([missing]);
  expect(check.onMain).toBe("not-yet");
});

test("a squash-merged pair of commits passes by patch-id", async () => {
  const { repo } = setup();
  const [first, second] = featurePair(repo);
  squashFeature(repo);
  const check = await checkReport(repo, "origin/main", [first, second], ["a.txt", "b.txt"]);
  expect(check).toMatchObject({ commitsExist: true, onMain: "yes", filesOk: true });
});

test("a pair of commits rebased commit by commit onto a moved main passes by per-commit patch-id", async () => {
  const { repo } = setup();
  const [first, second] = featurePair(repo);
  writeFileSync(join(repo, "m.txt"), "m\n");
  commitAll(repo, "main moved on");
  git(repo, ["cherry-pick", first, second]);
  git(repo, ["push", "origin", "main"]);
  const check = await checkReport(repo, "origin/main", [first, second], ["a.txt", "b.txt"]);
  expect(check).toMatchObject({ commitsExist: true, onMain: "yes", filesOk: true });
  // Only one of the two reached main: still not-yet.
  git(repo, ["checkout", "-b", "partial", "origin/main~2"]);
  git(repo, ["cherry-pick", first]);
  const partialMain = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["checkout", "main"]);
  expect((await checkReport(repo, partialMain, [first, second], [])).onMain).toBe("not-yet");
});

test("an unmerged branch commit is onMain not-yet", async () => {
  const { repo } = setup();
  const [first, second] = featurePair(repo);
  const check = await checkReport(repo, "origin/main", [first, second], ["a.txt"]);
  expect(check).toMatchObject({ commitsExist: true, onMain: "not-yet", filesOk: true });
  // A local merge that was never pushed is still not on origin/main.
  git(repo, ["merge", "--ff-only", "feature"]);
  expect((await checkReport(repo, "origin/main", [second], [])).onMain).toBe("not-yet");
});

test("claiming an untouched file fails filesOk; extra touched files are fine", async () => {
  const { repo } = setup();
  writeFileSync(join(repo, "a.txt"), "a\n");
  writeFileSync(join(repo, "extra.txt"), "x\n");
  const sha = commitAll(repo, "a and extra");
  git(repo, ["push", "origin", "main"]);
  const ok = await checkReport(repo, "origin/main", [sha], ["./a.txt"]);
  expect(ok).toMatchObject({ filesOk: true, untouchedFiles: [], touchedFiles: ["a.txt", "extra.txt"] });
  const bad = await checkReport(repo, "origin/main", [sha], ["a.txt", "README.md", "nope.txt"]);
  expect(bad).toMatchObject({ filesOk: false, untouchedFiles: ["README.md", "nope.txt"] });
});

test("a rename counts by its new path", async () => {
  const { repo } = setup();
  writeFileSync(join(repo, "old.txt"), "same content that git will detect as a rename\n".repeat(5));
  commitAll(repo, "add old");
  renameSync(join(repo, "old.txt"), join(repo, "new.txt"));
  const sha = commitAll(repo, "rename");
  git(repo, ["push", "origin", "main"]);
  expect(await checkReport(repo, "origin/main", [sha], ["new.txt"])).toMatchObject({ filesOk: true });
  expect(await checkReport(repo, "origin/main", [sha], ["old.txt"])).toMatchObject({ filesOk: false, untouchedFiles: ["old.txt"] });
});

test("merge commits are ignored for touched files", async () => {
  const { repo } = setup();
  const [first, second] = featurePair(repo);
  writeFileSync(join(repo, "main.txt"), "m\n");
  commitAll(repo, "main side");
  git(repo, ["merge", "--no-ff", "-m", "merge feature", "feature"]);
  const merge = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["push", "origin", "main"]);
  const check = await checkReport(repo, "origin/main", [first, second, merge], ["a.txt", "b.txt", "main.txt"]);
  expect(check).toMatchObject({ onMain: "yes", filesOk: false, untouchedFiles: ["main.txt"] });
});

test("report.check fetches main first and uses the bound main ref", async () => {
  const { repo, nemaHome } = setup();
  const other = join(root, "other");
  git(root, ["clone", join(root, "origin.git"), other]);
  writeFileSync(join(other, "c.txt"), "c\n");
  const sha = commitAll(other, "c");
  git(other, ["push", "origin", "main"]);
  // The repo has the commit object (fetched below by the handler) only once it fetches.
  const rpc = new RpcRouter();
  registerRepoHandlers(rpc, { nemaHome });
  const res = await rpc.handle({
    type: "rpc.request",
    id: "1",
    method: "report.check",
    params: { workspaceId: "ws_demo", repoId: "repo_demo", path: repo, mainBranch: "main", commits: [sha], files: ["c.txt"] },
  });
  expect(res).toMatchObject({ ok: true, result: { commitsExist: true, onMain: "yes", filesOk: true, mainSha: sha } });
  await expect(
    rpc.handle({
      type: "rpc.request",
      id: "2",
      method: "report.check",
      params: { workspaceId: "ws_demo", repoId: "repo_demo", path: repo, mainBranch: "main", commits: ["--all"], files: [] },
    }),
  ).resolves.toMatchObject({ ok: false });
});

test("repo.uncovered lists main commits not covered by the given shas or their squash", async () => {
  const { repo, nemaHome } = setup();
  const from = git(repo, ["rev-parse", "HEAD"]);
  writeFileSync(join(repo, "x.txt"), "x\n");
  const reported = commitAll(repo, "reported directly");
  git(repo, ["push", "origin", "main"]);
  const [first, second] = featurePair(repo);
  const squash = squashFeature(repo);
  writeFileSync(join(repo, "y.txt"), "y\n");
  const stray = commitAll(repo, "nobody reported this");
  git(repo, ["push", "origin", "main"]);
  // A side commit cherry-picked onto main counts as covered by patch-id.
  git(repo, ["checkout", "-b", "side", from]);
  writeFileSync(join(repo, "z.txt"), "z\n");
  const side = commitAll(repo, "side");
  git(repo, ["checkout", "main"]);
  git(repo, ["cherry-pick", side]);
  const picked = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["merge", "--no-ff", "-m", "merge side", "side"]);
  git(repo, ["push", "origin", "main"]);
  const to = git(repo, ["rev-parse", "HEAD"]);
  expect(picked).not.toBe(side);

  const rpc = new RpcRouter();
  registerRepoHandlers(rpc, { nemaHome });
  const res = await rpc.handle({
    type: "rpc.request",
    id: "1",
    method: "repo.uncovered",
    params: {
      workspaceId: "ws_demo",
      repoId: "repo_demo",
      path: repo,
      mainBranch: "main",
      from,
      to,
      covered: [reported, first, second, side],
    },
  });
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  // `side` itself is reachable through the merge, but is covered by its own sha. The merge is ignored.
  expect(res.result).toEqual([stray]);
  expect(squash).not.toBe(second);

  const all = await rpc.handle({
    type: "rpc.request",
    id: "2",
    method: "repo.uncovered",
    params: { workspaceId: "ws_demo", repoId: "repo_demo", path: repo, mainBranch: "main", from, to, covered: [] },
  });
  expect(all.ok && (all.result as string[]).sort()).toEqual([reported, squash, stray, picked, side].sort());
});
