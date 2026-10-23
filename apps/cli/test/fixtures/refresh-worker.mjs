// Child process used by authStore.test.ts: run with `node --import tsx refresh-worker.mjs <nemaHome> <refreshUrl>`.
// Prints "ready", waits for "go" on stdin, then calls getAccessToken({ force: true }) and prints one JSON line.
import { createInterface } from "node:readline";
import { AuthStore, RefreshError } from "../../src/direct/authStore.ts";

const [nemaHome, url] = process.argv.slice(2);
const store = new AuthStore(nemaHome, async (auth, signal) => {
  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: auth.tokens.refresh_token }),
  });
  if (!res.ok) throw new RefreshError(res.status);
  return await res.json();
});

const rl = createInterface({ input: process.stdin });
process.stdout.write("ready\n");
for await (const line of rl) if (line.trim() === "go") break;
rl.close();

let out;
try {
  const r = await store.getAccessToken({ force: true });
  out = { ok: true, accessToken: r.accessToken, refreshToken: r.auth.tokens.refresh_token };
} catch (e) {
  out = { ok: false, name: e?.name, message: String(e?.message ?? e) };
}
process.stdout.write(JSON.stringify(out) + "\n");
process.exit(0);
