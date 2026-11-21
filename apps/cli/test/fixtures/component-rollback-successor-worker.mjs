// Child process used by the components install tests:
//   node --import tsx component-rollback-successor-worker.mjs <job.json>
//
// Publishes a tree in its own process, coordinated by marker files in the job's
// control directory: it displaces the install and tree locks the way a delayed
// takeover's rename does, claims them, and activates the job's staging (which is
// byte-identical to the tree the parent's rollback placed, so it reuses it). It
// writes "published" (with its PID) once the activation returns, then waits for
// "release" before releasing its locks — so the parent can check that the launcher
// stays available while this process's install lock is live. The activation's
// outcome and the claimed token are written as JSON to the job's result file.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const job = JSON.parse(readFileSync(process.argv[2], "utf8"));

const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function waitFor(file, ms) {
  const end = Date.now() + ms;
  while (!existsSync(file)) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${file}`);
    nap(25);
  }
}

const { activate } = await import("../../src/components/install.ts");
const { acquireInstallLockSync, readInstallLockToken } = await import("../../src/components/store.ts");

// Displace both locks the way a delayed takeover's rename does, then claim them.
renameSync(path.join(job.root, ".install.lock"), path.join(job.root, ".install.lock.displaced"));
renameSync(path.join(job.root, ".tree.lock"), path.join(job.root, ".tree.lock.displaced"));
if (job.displaceFence) {
  // Also displace the pointer-write fence the way a delayed fence takeover's rename
  // does: a rollback that already holds the fence loses it, and its fence-token
  // re-check before the rename-aside must catch that and leave the tree in place.
  // The fence file may not exist yet (no pointer write has run); ignore that.
  try {
    renameSync(path.join(job.root, ".pointer.fence"), path.join(job.root, ".pointer.fence.displaced"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
const holder = acquireInstallLockSync(job.root);
if (!holder) throw new Error("successor could not claim the install lock");
writeFileSync(path.join(job.controlDir, "claimed"), `${process.pid}\n`);
const outcome = await activate(job.root, job.hash, job.staging, {
  verifyLockHeld: async () => {
    if (readInstallLockToken(job.root) !== holder.token) throw new Error("lock lost");
  },
});
writeFileSync(path.join(job.controlDir, "published"), `${process.pid}\n`);
waitFor(path.join(job.controlDir, "release"), 120_000);
writeFileSync(job.resultFile, `${JSON.stringify({ outcome, token: holder.token })}\n`);
await holder.release();
