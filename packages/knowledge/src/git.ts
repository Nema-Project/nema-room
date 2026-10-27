import { AsyncLocalStorage } from "node:async_hooks";
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
const heldLocks = new AsyncLocalStorage<Set<string>>();

/** The async call already holds this repository's lock. Thrown before the call queues behind itself. */
export class RepoLockReentryError extends Error {
  constructor(readonly repoDir: string) {
    super(`withRepoLock cannot be reentered for the same repository: ${repoDir}`);
    this.name = "RepoLockReentryError";
  }
}

/**
 * Serialize `fn` against other callers using the same repo directory (in-process).
 * A nested call for that same directory throws {@link RepoLockReentryError}.
 * Another directory, or a later call after this one finishes, is unaffected.
 */
export function withRepoLock<T>(repoDir: string, fn: () => Promise<T>): Promise<T> {
  const held = heldLocks.getStore();
  if (held?.has(repoDir)) throw new RepoLockReentryError(repoDir);
  const scope = new Set(held);
  scope.add(repoDir);
  const prev = tails.get(repoDir) ?? Promise.resolve();
  const run = prev.then(
    () => heldLocks.run(scope, fn),
    () => heldLocks.run(scope, fn),
  );
  const tail = run.catch(() => undefined);
  tails.set(repoDir, tail);
  void tail.then(() => {
    if (tails.get(repoDir) === tail) tails.delete(repoDir);
  });
  return run;
}
