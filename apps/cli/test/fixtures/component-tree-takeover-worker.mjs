// Child process used by the components install tests:
//   node --import tsx component-tree-takeover-worker.mjs <job.json>
//
// Attempts one tree-lock takeover in its own process, pausing at the takeover's two
// seams so the parent can interleave other installers: it writes "judged" once it has
// read a stale record and is about to rename it aside, then waits for
// "release-rename"; it writes "renamed" once the record is aside and it is about to
// restore it, then waits for "release-restore". It attempts the claim exactly once
// (a zero timeout: the deadline is checked only after the attempt, so the takeover
// always runs) and writes whether it won as JSON to the job's result file.
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

const { acquireTreeLockSync } = await import("../../src/components/store.ts");

const lock = acquireTreeLockSync(job.root, 0, {
  beforeRename: () => {
    writeFileSync(path.join(job.controlDir, "judged"), `${process.pid}\n`);
    waitFor(path.join(job.controlDir, "release-rename"), 120_000);
  },
  afterRename: () => {
    writeFileSync(path.join(job.controlDir, "renamed"), `${process.pid}\n`);
    waitFor(path.join(job.controlDir, "release-restore"), 120_000);
  },
});
writeFileSync(job.resultFile, `${JSON.stringify({ won: lock !== null, token: lock?.token ?? null })}\n`);
lock?.release();
