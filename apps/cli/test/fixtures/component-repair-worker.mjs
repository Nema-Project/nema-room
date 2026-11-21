// Child process used by the components install tests:
//   node --import tsx component-repair-worker.mjs <job.json>
//
// Runs one forced repair of the graphify component in its own process and pauses after
// its generation claim, coordinated by marker files in the job's control directory: it
// writes "claimed" (with its PID) once the claim's counter write lands, then waits for
// "release" to appear before it finishes the install. The parent test snapshots a
// refusal while this process — a different PID, so the parent's lock-liveness check
// takes the cross-process path — holds the install lock. The install's outcome is
// written as JSON to the job's result file.
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

const { installComponent } = await import("../../src/components/install.ts");
const { writeFileAtomic } = await import("../../src/components/store.ts");

const env = {
  env: job.envVars,
  runtimeRoot: job.runtimeRoot,
  lockPath: job.lockPath,
  platform: { platform: process.platform, arch: process.arch, musl: false },
};

const status = await installComponent("graphify", {
  env,
  force: true,
  hooks: {
    retryDelaysMs: [0, 0, 0],
    timeoutMs: 2_000,
    freeBytes: async () => Number.MAX_SAFE_INTEGER,
    writeGenerationFile: async (file, body) => {
      await writeFileAtomic(file, body);
      if (path.basename(file) === "install-generation") {
        writeFileSync(path.join(job.controlDir, "claimed"), `${process.pid}\n`);
        waitFor(path.join(job.controlDir, "release"), 120_000);
      }
    },
  },
});
writeFileSync(job.resultFile, `${JSON.stringify(status)}\n`);
