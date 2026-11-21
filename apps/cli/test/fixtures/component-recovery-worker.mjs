// Child process used by the components install tests:
//   node --import tsx component-recovery-worker.mjs <job.json>
//
// Runs one read-path recovery in its own process and pauses after its restore move,
// coordinated by marker files in the job's control directory: it writes "restored"
// (with its PID) once the backup is restored, then waits for "release" to appear
// before it runs its post-move check. The parent test displaces this process's lock
// and claims it while the child is paused, so the child's post-move check finds a
// different token at the lock path. The recovery's completion is written as JSON to
// the job's result file.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

const { recoverReplacementsSync } = await import("../../src/components/store.ts");

recoverReplacementsSync(job.root, {
  afterMove: () => {
    writeFileSync(path.join(job.controlDir, "restored"), `${process.pid}\n`);
    waitFor(path.join(job.controlDir, "release"), 120_000);
  },
  // Optional: when the job names an afterUndo marker, pause again after the undo
  // decision, while this recovery still holds the tree mutex, so the parent can let
  // another installer attempt a takeover in the gap. Jobs that omit it behave as before.
  ...(job.afterUndo
    ? {
        afterUndo: () => {
          writeFileSync(path.join(job.controlDir, job.afterUndo), `${process.pid}\n`);
          waitFor(path.join(job.controlDir, "release-undo"), 120_000);
        },
      }
    : {}),
});
writeFileSync(job.resultFile, `${JSON.stringify({ done: true })}\n`);
