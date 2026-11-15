import { spawn } from "node:child_process";
import { createRequire } from "node:module";

// Source development has no production process wrapper. Keep this opt-in local
// to the dev child, and keep the server bound to loopback (spec D-4).
const require = createRequire(import.meta.url);
const child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "dev", "-H", "127.0.0.1", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, NEMA_SHARE_SOURCE_DEV: "1" },
});
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
