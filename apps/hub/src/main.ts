import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { KnowledgeStore } from "@nema/knowledge";
import { DEFAULT_HUB_PORT, createApp } from "./app.js";
import { createPgDb, migrate, type Db } from "./db/db.js";
import { attachDaemonSocket } from "./daemonSocket.js";
import { DaemonRpcError, type DaemonRpc } from "./daemonRpc.js";
import { indexEntry } from "./entryIndex.js";
import { EventBus } from "./events.js";
import { announceInterrupted } from "./interrupts.js";
import { startReportFallback } from "./reports.js";
import { interruptRunning } from "./tasks.js";
import { listWorkspaces, repoPath, type Workspace } from "./workspaces.js";

// Load the repo-root .env (see .env.example). Existing env vars win; a missing file is fine.
// src/main.ts (tsx) sits three levels below the repo root, the compiled dist/src/main.js four.
try {
  const rel = import.meta.url.includes("/dist/src/") ? "../../../../.env" : "../../../.env";
  process.loadEnvFile(fileURLToPath(new URL(rel, import.meta.url)));
} catch {
  // no .env
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
  const databaseUrl = process.env.NEMA_DATABASE_URL;
  if (!databaseUrl) throw new Error("NEMA_DATABASE_URL is required");
  const dataDir = expandHome(process.env.NEMA_DATA_DIR ?? path.join(os.homedir(), ".nema", "data"));
  const port = Number(process.env.NEMA_HUB_PORT ?? DEFAULT_HUB_PORT);
  // Bind address. Loopback by default; the Docker image sets 0.0.0.0 and compose publishes the port on
  // 127.0.0.1 only. The Host guard keeps accepting just 127.0.0.1:<port> / localhost:<port>, which is
  // what the browser and the daemon send through the published port (container and host port are equal).
  const hostname = process.env.NEMA_HUB_HOST || "127.0.0.1";
  // When the hub runs on the same machine/filesystem as the daemon it also removes the daemon's
  // ~/.nema/ws/<id> on workspace delete. In a container that path is not the host's, so compose sets
  // NEMA_HUB_CLEAN_DAEMON_DIRS=0 and the daemon cleans up itself (welcome / workspace.deleted messages).
  const cleanDaemonDirs = !["0", "false", "no"].includes((process.env.NEMA_HUB_CLEAN_DAEMON_DIRS ?? "1").toLowerCase());
  await mkdir(dataDir, { recursive: true });
  const daemonToken = await ensureDaemonToken(dataDir);

  const db = createPgDb(databaseUrl);
  await migrate(db);
  const events = new EventBus();
  // Nothing can be running before the daemon socket exists: interrupt leftovers of the previous
  // process (and invalidate their run tokens) so the workspaces are not wedged.
  const interrupted = await interruptRunning(db, "all");
  if (interrupted.requeued.length > 0) {
    console.log(`requeued ${interrupted.requeued.length} task(s) left running by the previous hub process`);
  }
  await announceInterrupted(db, events, interrupted);
  await recoverUncommittedEntries(db, dataDir);
  const status = { connected: () => false };
  // Replaced once the socket exists. Callers always go through `daemon`, so the lookup stays late.
  const liveDaemon: { rpc: DaemonRpc } = {
    rpc: { call: () => Promise.reject(new DaemonRpcError("daemon 未连接")) },
  };
  const daemon: DaemonRpc = {
    call: (method, params, timeoutMs) => liveDaemon.rpc.call(method, params, timeoutMs),
  };
  const app = createApp({
    db,
    dataDir,
    nemaHome: cleanDaemonDirs ? path.join(os.homedir(), ".nema") : undefined,
    events,
    daemonStatus: () => status.connected(),
    daemon,
    webOrigin: process.env.NEMA_WEB_ORIGIN,
    port,
  });
  const server = serve({ fetch: app.fetch, hostname, port });
  // The URL handed to the daemon (and Codex's room MCP server) on the host: always the loopback name.
  const hubUrl = `http://127.0.0.1:${port}`;
  const attached = attachDaemonSocket(server as import("node:http").Server, { db, dataDir, events, daemonToken, hubUrl });
  status.connected = attached.isConnected;
  liveDaemon.rpc = attached.rpc;
  // Main moves that no report covers start a system task once they are 30 minutes old.
  startReportFallback(db, daemon, events);
  console.log(`nema hub listening on ${hostname}:${port} (use ${hubUrl})`);
}

/** After migrate, before serve. One workspace failing does not stop the others or the hub. */
async function recoverUncommittedEntries(db: Db, dataDir: string): Promise<void> {
  let workspaces: Workspace[] = [];
  try {
    workspaces = await listWorkspaces(db);
  } catch (err) {
    console.error("failed to list workspaces for uncommitted recovery", err);
    return;
  }
  for (const ws of workspaces) {
    try {
      const { recovered, skipped } = await new KnowledgeStore(repoPath(dataDir, ws.id)).recoverUncommitted();
      if (recovered.length > 0) {
        const noun = recovered.length === 1 ? "entry" : "entries";
        console.log(`recovered ${recovered.length} uncommitted ${noun} in ${ws.id}`);
      }
      for (const rel of skipped) console.warn(`skipped ${rel} in ${ws.id}`);
      for (const entry of recovered) {
        try {
          await indexEntry(db, ws.id, entry);
        } catch (err) {
          console.error(`failed to index recovered entry ${entry.id} in ${ws.id}`, err);
        }
      }
    } catch (err) {
      console.error(`failed to recover uncommitted entries in ${ws.id}`, err);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
