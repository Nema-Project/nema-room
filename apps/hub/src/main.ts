import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_HUB_PORT } from "./app.js";
import { readHubReleaseVersion } from "./hubVersion.js";
import { createPgDb, migrate } from "./db/db.js";
import { startHub } from "./lifecycle.js";

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function ensureDaemonToken(dataDir: string): Promise<string> {
  const file = path.join(dataDir, "daemon-token");
  try {
    return (await readFile(file, "utf8")).trim();
  } catch {
    const token = randomBytes(32).toString("hex");
    await writeFile(file, token, { mode: 0o600 });
    return token;
  }
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

async function main(): Promise<void> {
  // Only the legacy executable reads the repository .env. Importing the module is inert.
  try {
    const rel = import.meta.url.includes("/dist/src/") ? "../../../../.env" : "../../../.env";
    process.loadEnvFile(fileURLToPath(new URL(rel, import.meta.url)));
  } catch {
    // no .env
  }

  const databaseUrl = process.env.NEMA_DATABASE_URL;
  if (!databaseUrl) throw new Error("NEMA_DATABASE_URL is required");
  const dataDir = expandHome(process.env.NEMA_DATA_DIR ?? path.join(os.homedir(), ".nema", "data"));
  const port = Number(process.env.NEMA_HUB_PORT ?? DEFAULT_HUB_PORT);
  // Preserve Compose's container-wide bind; local managed hubs default to loopback.
  const hostname = process.env.NEMA_HUB_HOST || "127.0.0.1";
  const cleanDaemonDirs = !["0", "false", "no"].includes((process.env.NEMA_HUB_CLEAN_DAEMON_DIRS ?? "1").toLowerCase());
  await mkdir(dataDir, { recursive: true });
  const daemonToken = await ensureDaemonToken(dataDir);
  const db = createPgDb(databaseUrl);
  try {
    await migrate(db);
    const releaseVersion = readHubReleaseVersion();
    const hub = await startHub({
      db,
      dataDir,
      nemaHome: path.join(os.homedir(), ".nema"),
      daemonToken,
      releaseVersion,
      port,
      webOrigin: process.env.NEMA_WEB_ORIGIN ?? "http://localhost:3000,http://127.0.0.1:3000",
      hostname,
      cleanDaemonDirs,
    });
    console.log(`nema hub listening on ${hostname}:${port} (use ${hub.url})`);
    const shutdown = () => {
      void hub.close().finally(() => db.close()).catch((error) => {
        console.error("nema hub shutdown failed", error);
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    await db.close();
    throw error;
  }
}

if (isDirectExecution()) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
