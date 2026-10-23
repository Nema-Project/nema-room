// Where a coding agent is working: the repo's shared git dir (so a `git worktree` routes to the bound repo), branch and HEAD.
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      {
        // A minimal env, so GIT_DIR / GIT_WORK_TREE set by the agent's environment cannot redirect git.
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", LANG: process.env.LANG ?? "", GIT_TERMINAL_PROMPT: "0" },
        shell: false,
        timeout: 5000,
        encoding: "utf8",
      },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim())),
    );
  });
}

export async function repoInfo(cwd: string): Promise<{ gitCommonDir: string; branch: string | null; head: string } | null> {
  let commonDir: string;
  let head: string;
  try {
    commonDir = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    head = await git(cwd, ["rev-parse", "HEAD"]);
  } catch {
    return null;
  }
  if (!/^[0-9a-f]{40}$/.test(head)) return null;
  let branch: string | null;
  try {
    branch = (await git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"])) || null;
  } catch {
    branch = null;
  }
  let gitCommonDir: string;
  try {
    gitCommonDir = await realpath(commonDir);
  } catch {
    return null;
  }
  return { gitCommonDir, branch, head };
}
