// Deterministic checks of a coding agent's report against the repo's main branch. No model is involved:
// every answer comes from git (object existence, ancestry, `patch-id --stable`, and `diff-tree`).
import type { ReportAuthors, ReportCheck } from "@nema/shared";
import { spawn } from "node:child_process";
import path from "node:path";
import { commandEnv, gitRaw, gitText } from "./git.js";
import type { OwnedHelperScope } from "@nema/shared/ownedHelper";
import { runHelperFile } from "@nema/shared/ownedHelper";

const SHA_RE = /^[0-9a-f]{7,40}$/;
/** The empty tree, diffed against when the oldest reported commit is a root commit. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
// Both sides of a patch-id comparison are produced with the same diff options, whatever the user's config says.
const DIFF_OPTS = ["--no-color", "--no-ext-diff", "--no-renames", "--no-textconv"];

function assertSha(sha: string): void {
  if (!SHA_RE.test(sha)) throw new Error(`无效的提交 ${sha}`);
}

function assertRef(ref: string): void {
  if (!ref || ref.startsWith("-")) throw new Error(`无效的引用 ${ref}`);
}

/** The full sha of a commit, or null when the repo has no such commit. */
async function resolveCommit(repoPath: string, sha: string, helpers?: OwnedHelperScope): Promise<string | null> {
  try {
    await gitText(repoPath, ["cat-file", "-e", `${sha}^{commit}`], undefined, helpers);
    return await gitText(repoPath, ["rev-parse", "--verify", `${sha}^{commit}`], undefined, helpers);
  } catch {
    return null;
  }
}

async function isAncestor(repoPath: string, sha: string, ref: string, helpers?: OwnedHelperScope): Promise<boolean> {
  try {
    await gitText(repoPath, ["merge-base", "--is-ancestor", sha, ref], undefined, helpers);
    return true;
  } catch {
    return false;
  }
}

/** Runs `git patch-id --stable` over `input` and returns its `<patch-id> <commit>` rows. */
function patchIds(repoPath: string, input: Buffer, helpers?: OwnedHelperScope): Promise<Array<{ patchId: string; commit: string }>> {
  if (input.length === 0) return Promise.resolve([]);
  if (helpers) return runHelperFile("git", ["-C", repoPath, "patch-id", "--stable"], {
    env: commandEnv(), timeout: 60_000, maxBuffer: 64 * 1024 * 1024, encoding: "buffer", input,
  }, helpers).then((result) => {
    if (result.error) throw new Error(result.stderr.toString("utf8").trim() || `git patch-id exited ${result.code}`);
    return parsePatchIds(result.stdout);
  });
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", repoPath, "patch-id", "--stable"], { env: commandEnv(), shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(Buffer.concat(err).toString("utf8").trim() || `git patch-id exited ${code}`));
        return;
      }
      resolve(parsePatchIds(Buffer.concat(out)));
    });
    // A patch-id that exits early (EPIPE) is reported by its exit code above.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

function parsePatchIds(output: Buffer): Array<{ patchId: string; commit: string }> {
  const rows: Array<{ patchId: string; commit: string }> = [];
  for (const line of output.toString("utf8").split("\n")) {
    const [patchId, commit] = line.trim().split(/\s+/);
    if (patchId && commit) rows.push({ patchId, commit });
  }
  return rows;
}

/** Patch-id of the combined change `<oldest>^..<newest>`, or null when that diff is empty. */
async function combinedPatchId(repoPath: string, oldest: string, newest: string, helpers?: OwnedHelperScope): Promise<string | null> {
  const parent = await gitText(repoPath, ["rev-parse", "--verify", "--quiet", `${oldest}^`], undefined, helpers).catch(() => EMPTY_TREE);
  const diff = await gitRaw(repoPath, ["diff", ...DIFF_OPTS, parent, newest, "--"], undefined, helpers);
  return (await patchIds(repoPath, diff, helpers))[0]?.patchId ?? null;
}

/** Commit → patch-id for every non-merge commit `git log` lists with `args` (an empty change has none). */
async function logPatchIds(repoPath: string, args: string[], helpers?: OwnedHelperScope): Promise<Map<string, string>> {
  const log = await gitRaw(repoPath, ["log", "-p", ...DIFF_OPTS, "--no-merges", "--format=commit %H", ...args, "--"], 120_000, helpers);
  const byCommit = new Map<string, string>();
  for (const row of await patchIds(repoPath, log, helpers)) byCommit.set(row.commit, row.patchId);
  return byCommit;
}

/** Oldest and newest of `shas` by ancestry; falls back to the given order when they do not form a chain. */
async function chainEnds(repoPath: string, shas: string[], helpers?: OwnedHelperScope): Promise<[string, string]> {
  let oldest = shas[0];
  let newest = shas[shas.length - 1];
  for (const a of shas) {
    let isOldest = true;
    let isNewest = true;
    for (const b of shas) {
      if (a === b) continue;
      if (isOldest && !(await isAncestor(repoPath, a, b, helpers))) isOldest = false;
      if (isNewest && !(await isAncestor(repoPath, b, a, helpers))) isNewest = false;
    }
    if (isOldest) oldest = a;
    if (isNewest) newest = a;
  }
  return [oldest, newest];
}

/** Parent shas of each commit (`rev-list --parents`). */
async function parentsOf(repoPath: string, shas: string[], helpers?: OwnedHelperScope): Promise<Map<string, string[]>> {
  const parents = new Map<string, string[]>();
  if (shas.length === 0) return parents;
  const text = await gitText(repoPath, ["rev-list", "--no-walk=unsorted", "--parents", ...shas, "--"], undefined, helpers);
  for (const line of text.split("\n")) {
    const [sha, ...rest] = line.trim().split(/\s+/);
    if (sha) parents.set(sha, rest);
  }
  return parents;
}

function normalizeClaim(file: string): string {
  return path.posix.normalize(file.replace(/\\/g, "/")).replace(/^\.\//, "").replace(/\/$/, "");
}

/**
 * Checks reported `commits` and claimed `files` against `mainRefName` (`origin/<main>`, or the local main
 * when there is no origin). The caller fetches first.
 */
export async function checkReport(repoPath: string, mainRefName: string, commits: string[], files: string[], helpers?: OwnedHelperScope): Promise<ReportCheck> {
  assertRef(mainRefName);
  for (const sha of commits) assertSha(sha);
  const mainSha = await gitText(repoPath, ["rev-parse", "--verify", `${mainRefName}^{commit}`], undefined, helpers);
  const checkedAt = new Date().toISOString();

  const resolved: string[] = [];
  const missingCommits: string[] = [];
  for (const sha of commits) {
    const full = await resolveCommit(repoPath, sha, helpers);
    if (full === null) missingCommits.push(sha);
    else if (!resolved.includes(full)) resolved.push(full);
  }
  const commitsExist = missingCommits.length === 0 && resolved.length > 0;

  let onMain: ReportCheck["onMain"] = "not-yet";
  if (commitsExist) {
    let all = true;
    for (const sha of resolved) {
      if (!(await isAncestor(repoPath, sha, mainSha, helpers))) {
        all = false;
        break;
      }
    }
    if (all) onMain = "yes";
    else {
      const [oldest, newest] = await chainEnds(repoPath, resolved, helpers);
      const combined = await combinedPatchId(repoPath, oldest, newest, helpers);
      const base = await gitText(repoPath, ["merge-base", resolved[0]!, mainSha], undefined, helpers).catch(() => null);
      if (combined !== null && base !== null) {
        const mainIds = new Set((await logPatchIds(repoPath, [`${base}..${mainSha}`], helpers)).values());
        if (mainIds.has(combined)) onMain = "yes";
        else {
          // Rebase-and-merge or commit-by-commit cherry-picks: every reported non-merge commit is on main
          // itself or has its own patch-id among main's commits.
          const parents = await parentsOf(repoPath, resolved, helpers);
          const own = await logPatchIds(repoPath, ["--no-walk=unsorted", ...resolved], helpers);
          let every = true;
          let matched = 0;
          for (const sha of resolved) {
            if ((parents.get(sha)?.length ?? 0) > 1) continue; // merge commits are ignored
            if (await isAncestor(repoPath, sha, mainSha, helpers)) continue;
            const id = own.get(sha);
            if (id === undefined) continue; // an empty change has no patch-id to look for
            if (!mainIds.has(id)) {
              every = false;
              break;
            }
            matched++;
          }
          if (every && matched > 0) onMain = "yes";
        }
      }
    }
  }

  const touched = new Set<string>();
  const parents = await parentsOf(repoPath, resolved, helpers);
  for (const sha of resolved) {
    if ((parents.get(sha)?.length ?? 0) > 1) continue; // merge commits are ignored
    const out = await gitRaw(repoPath, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-M", "--root", "-z", sha, "--"], undefined, helpers);
    for (const name of out.toString("utf8").split("\0")) if (name) touched.add(name);
  }
  const untouchedFiles = files.filter((file) => !touched.has(normalizeClaim(file)));

  return { commitsExist, missingCommits, onMain, filesOk: untouchedFiles.length === 0, untouchedFiles, touchedFiles: [...touched], checkedAt, mainSha };
}

/**
 * Author and committer of each reported commit that resolves in the repo; the rest are listed as `missing`.
 * Evidence only: nothing here allows or denies a report, and `checkReport` does not read it.
 */
export async function readAuthors(repoPath: string, commits: string[], helpers?: OwnedHelperScope): Promise<ReportAuthors> {
  for (const sha of commits) assertSha(sha);
  const out: ReportAuthors["commits"] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const sha of commits) {
    const full = await resolveCommit(repoPath, sha, helpers);
    if (full === null) {
      missing.push(sha);
      continue;
    }
    if (seen.has(full)) continue;
    seen.add(full);
    const raw = (await gitRaw(repoPath, ["show", "-s", "--no-show-signature", "--format=%an%x00%ae%x00%cn%x00%ce", full, "--"], undefined, helpers)).toString("utf8");
    const [authorName = "", authorEmail = "", committerName = "", committerEmail = ""] = raw.replace(/\n$/, "").split("\0");
    out.push({ sha: full, authorName, authorEmail, committerName, committerEmail });
  }
  return { checkedAt: new Date().toISOString(), source: "git", commits: out, missing };
}

/**
 * Non-merge commits in `from..to` on main that no report covers: neither one of `covered`, nor patch-id-equal
 * to one of them, nor a squash of a parent-linked run of covered commits that never reached main themselves.
 * `from` and `to` must each be `mainRefName` or a sha that main contains. Returned oldest first.
 */
export async function uncoveredCommits(
  repoPath: string,
  mainRefName: string,
  from: string,
  to: string,
  covered: string[],
  helpers?: OwnedHelperScope,
): Promise<string[]> {
  assertRef(mainRefName);
  for (const rev of [from, to]) {
    if (rev === mainRefName) continue;
    assertSha(rev);
    if (!(await isAncestor(repoPath, rev, mainRefName, helpers))) throw new Error(`提交 ${rev} 不在主分支上`);
  }
  for (const sha of covered) assertSha(sha);

  const listed = await gitText(repoPath, ["rev-list", "--no-merges", "--reverse", `${from}..${to}`, "--"], undefined, helpers);
  const candidates = listed.split("\n").filter(Boolean);
  if (candidates.length === 0) return [];

  const coveredSet = new Set<string>();
  for (const sha of covered) {
    const full = await resolveCommit(repoPath, sha, helpers);
    if (full !== null) coveredSet.add(full);
  }
  const coveredList = [...coveredSet];

  const coveredIds = new Set<string>();
  if (coveredList.length > 0) {
    for (const id of (await logPatchIds(repoPath, ["--no-walk=unsorted", ...coveredList], helpers)).values()) coveredIds.add(id);
    // Squash merges: covered commits that never reached main, grouped into runs linked by first parent.
    const offMain: string[] = [];
    for (const sha of coveredList) if (!(await isAncestor(repoPath, sha, to, helpers))) offMain.push(sha);
    const parents = await parentsOf(repoPath, offMain, helpers);
    const offSet = new Set(offMain.filter((sha) => (parents.get(sha)?.length ?? 0) <= 1));
    const childOf = new Map<string, string>();
    for (const sha of offSet) {
      const parent = parents.get(sha)?.[0];
      if (parent && offSet.has(parent)) childOf.set(parent, sha);
    }
    for (const start of offSet) {
      const parent = parents.get(start)?.[0];
      if (parent && offSet.has(parent)) continue; // not the start of a run
      let end = start;
      while (childOf.has(end)) end = childOf.get(end)!;
      if (end === start) continue; // a single commit is already covered by its own patch-id
      const combined = await combinedPatchId(repoPath, start, end, helpers);
      if (combined !== null) coveredIds.add(combined);
    }
  }

  const idOf = await logPatchIds(repoPath, [`${from}..${to}`], helpers);
  return candidates.filter((sha) => {
    if (coveredSet.has(sha)) return false;
    const id = idOf.get(sha);
    return id === undefined || !coveredIds.has(id);
  });
}
