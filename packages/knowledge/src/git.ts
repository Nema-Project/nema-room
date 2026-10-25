import { execFile } from "node:child_process";
import type { OwnedHelperScope } from "@nema/shared/ownedHelper";
import { runHelperFile } from "@nema/shared/ownedHelper";

/** Run a git command in `repoDir`; resolves with stdout, rejects with stderr in the message. */
export async function git(repoDir: string, args: string[], ownedHelpers?: OwnedHelperScope): Promise<string> {
  if (ownedHelpers) {
    const result = await runHelperFile("git", args, { cwd: repoDir, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }, ownedHelpers);
    if (result.error) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8").trim() || result.error.message}`);
    return result.stdout.toString("utf8");
  }
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: repoDir, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`git ${args.join(" ")} failed: ${stderr.trim() || err.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

const tails = new Map<string, Promise<unknown>>();

/** Serialize `fn` against other callers using the same repo directory (in-process). */
export function withRepoLock<T>(repoDir: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(repoDir) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  tails.set(repoDir, tail);
  void tail.then(() => {
    if (tails.get(repoDir) === tail) tails.delete(repoDir);
  });
  return run;
}
