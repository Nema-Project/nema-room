// Child process used by accounts lock tests:
//   node --import tsx accounts-writer.mjs <mode> <nemaHome> <name> <seed> <startedFile> <holdingFile> <releaseFile>
//
// mode=update: takes the accounts lock, appends one account row inside the critical section, and holds it
//   until <releaseFile> appears — which is how the parent proves two processes overlap.
// mode=materialize: calls materializeImplicit (no legacy file, so a plain new account).
// Prints one JSON line when done.
import { existsSync, writeFileSync } from "node:fs";

const [mode, nemaHome, name, seed, startedFile, holdingFile, releaseFile] = process.argv.slice(2);

const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function waitFor(file, ms) {
  const deadline = Date.now() + ms;
  while (!existsSync(file) && Date.now() < deadline) nap(10);
  return existsSync(file);
}

writeFileSync(startedFile, String(process.pid));

let out;
try {
  if (mode === "update") {
    const { updateAccounts } = await import("../../src/accounts/store.ts");
    updateAccounts(nemaHome, (current) => {
      // Inside the lock: tell the parent, then stay here until it lets us go.
      writeFileSync(holdingFile, String(process.pid));
      waitFor(releaseFile, 30_000);
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
    out = { ok: true, id: account.id };
  }
} catch (e) {
  out = { ok: false, name: e?.name, message: String(e?.message ?? e) };
}
process.stdout.write(JSON.stringify(out) + "\n");
process.exit(0);
