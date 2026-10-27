import { mkdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as nodeUtil from "node:util";
import { devComposeUpArgs } from "./compose-dev.mjs";
import { setupSettings } from "./setup.mjs";

try {
  if (+process.versions.node.split(".")[0] < 22) throw new Error("Node.js 22 or newer is required.");
  const root = fileURLToPath(new URL("../", import.meta.url));
  let config = {};
  try { config = nodeUtil.parseEnv(await readFile(new URL("../.env", import.meta.url), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const s = setupSettings(config);
  await mkdir(s.dataDir, { recursive: true });
  const env = { ...process.env, NEMA_DATA_HOST_DIR: s.dataDir, NEMA_HUB_PORT: s.port, NEMA_UID: s.uid, NEMA_GID: s.gid };
  const result = spawnSync("docker", devComposeUpArgs(), { cwd: root, env, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
