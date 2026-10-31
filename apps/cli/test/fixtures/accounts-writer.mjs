// Child process used by the accounts lock tests:
//   node --import tsx accounts-writer.mjs <mode> <nemaHome> <name> <seed> <preFile> <holdFile> <releaseFile>
//
// Marker protocol, all of it optional:
//   gate   (preFile with a ".gate" suffix): announce arrival, then wait for the peer, so two children are
//          in flight at the same moment before either starts.
//   pre    "<holdFile>.pre", written immediately before the lock is requested: proof the child is really
//          trying to enter rather than not started yet.
//   hold   written *inside* the critical section, after the read: proof it got in, plus the row count it
//          saw. A hold marker appearing while another child still holds the lock means the lock failed.
//
// mode=update: takes the accounts lock, appends one row, and (when a release file is given) holds the lock
//   until that file appears.
// mode=materialize: calls materializeImplicit, which takes the same lock.
import { existsSync, writeFileSync } from "node:fs";

const [mode, nemaHome, name, seed, gateFile, holdFile, releaseFile] = process.argv.slice(2);

const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function waitFor(file, ms) {
  const deadline = Date.now() + ms;
  while (!existsSync(file) && Date.now() < deadline) nap(10);
  return existsSync(file);
}
const release = (ms = 30_000) => (releaseFile ? waitFor(releaseFile, ms) : true);

if (gateFile) {
  writeFileSync(gateFile, String(process.pid));
  if (gateFile.endsWith(".a")) waitFor(gateFile.replace(/\.a$/, ".b"), 30_000);
  if (gateFile.endsWith(".b")) waitFor(gateFile.replace(/\.b$/, ".a"), 30_000);
}

let out;
try {
  if (mode === "update") {
    const { updateAccounts } = await import("../../src/accounts/store.ts");
    // "About to ask for the lock": lets the parent prove the second writer is really in flight and blocked.
    if (holdFile) writeFileSync(`${holdFile}.pre`, String(process.pid));
    updateAccounts(nemaHome, (current) => {
      const rows = current?.accounts.length ?? 0;
      writeFileSync(holdFile, JSON.stringify({ pid: process.pid, rows }));
      release();
      const accounts = current?.accounts ?? [];
      return {
        version: 1,
        accounts: [...accounts, {
          id: `acct_${seed}`, name, enabled: true, adapter: "claude-code",
          costTier: "standard", order: accounts.length, createdAt: "2026-10-31T00:00:00.000Z",
        }],
        bindings: current?.bindings ?? {},
      };
    });
    out = { ok: true };
  } else {
    const { materializeImplicit } = await import("../../src/accounts/implicit.ts");
    const { DEFAULT_CONFIG } = await import("../../src/config.ts");
    const { account } = materializeImplicit({
      nemaHome, config: { ...DEFAULT_CONFIG, adapter: "claude-code" }, codexHome: "",
      name, random: () => seed,
    });
    if (holdFile) writeFileSync(holdFile, JSON.stringify({ pid: process.pid, id: account.id }));
    out = { ok: true, id: account.id };
  }
} catch (e) {
  out = { ok: false, name: e?.name, message: String(e?.message ?? e) };
}
process.stdout.write(JSON.stringify(out) + "\n");
process.exit(0);
