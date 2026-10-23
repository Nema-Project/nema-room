import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { diffNameStatus, exportSnapshot } from "./git.js";
import { buildIndex, updateIndex, type GraphifyOpts } from "./graphify.js";

/** Written only after a build or update finished. A graph.json without it may be partial. */
const MARKER = "indexed-sha";

const locks = new Map<string, Promise<unknown>>();

/** Runs `fn` after every earlier job for the same snapshot root, so builds never overlap. */
export function withIndexLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(root) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  locks.set(root, run);
  void run.catch(() => {}).finally(() => {
    if (locks.get(root) === run) locks.delete(root);
  });
  return run;
}

export async function readIndexedSha(root: string): Promise<string | null> {
  try {
    const sha = (await readFile(path.join(root, MARKER), "utf8")).trim();
    return sha === "" ? null : sha;
  } catch {
    return null;
  }
}

/**
 * Brings the index to `sha`. Call it inside `withIndexLock`. An index at another sha is updated
 * incrementally; no index is built in full. The marker is removed first, so any failure leaves the
 * snapshot marked as not indexed and the next call rebuilds it in full.
 */
export async function syncIndex(root: string, repoPath: string, sha: string, graphify?: GraphifyOpts): Promise<void> {
  const indexed = await readIndexedSha(root);
  if (indexed === sha) return;
  await rm(path.join(root, MARKER), { force: true });
  if (indexed !== null) {
    await updateIndex(root, await diffNameStatus(repoPath, indexed, sha), repoPath, sha, graphify);
  } else {
    await exportSnapshot(repoPath, sha, path.join(root, "src"));
    await buildIndex(root, graphify);
  }
  await writeFile(path.join(root, MARKER), sha);
}
