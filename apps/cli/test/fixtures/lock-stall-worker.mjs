import { withFileLock } from "../../src/direct/lock.ts";

const [lockPath, stallMsText] = process.argv.slice(2);
const stallMs = Number(stallMsText);

await withFileLock(lockPath, async () => {
  process.stdout.write("holder-start\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stallMs);
  process.stdout.write("holder-end\n");
});
