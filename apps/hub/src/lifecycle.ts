import http from "node:http";
import { getRequestListener } from "@hono/node-server";
import type { MiddlewareHandler } from "hono";
import { KnowledgeStore } from "@nema/knowledge";
import type { DaemonRpc } from "./daemonRpc.js";
import { DaemonRpcError } from "./daemonRpc.js";
import { createApp } from "./app.js";
import { AttachmentStore } from "./attachments.js";
import type { Db } from "./db/db.js";
import { attachDaemonSocket } from "./daemonSocket.js";
import { EventBus } from "./events.js";
import { announceInterrupted } from "./interrupts.js";
import { indexEntry } from "./entryIndex.js";
import { startReportFallback } from "./reports.js";
import { interruptRunning } from "./tasks.js";
import { listWorkspaces, repoPath, type Workspace } from "./workspaces.js";
import type { OwnedHelperScope } from "@nema/shared/ownedHelper";
import { reconcileSourceImports } from "./sourceImport.js";
import { reconcileUnconsumedEvents } from "./evidenceEvents.js";
import { renderDiagram, validateDiagram } from "./archify.js";

export type StartHubOptions = {
  db: Db;
  dataDir: string;
  nemaHome: string;
  daemonToken: string;
  port: number;
  webOrigin: string;
  uiAuth?: MiddlewareHandler;
  /** Docker Compose publishes the container port on host loopback and requires this container bind. */
  hostname?: string;
  /** Set false when the daemon owns its own workspace directories, as in Compose. */
  cleanDaemonDirs?: boolean;
  ownedHelpers?: OwnedHelperScope;
  /** When set, hello.version must equal it. Unset keeps older callers accepting any CLI version. */
  releaseVersion?: string;
  /** NEMA_ATTACHMENTS_MAX_BYTES; the store's 2 GB default when unset. */
  attachmentsMaxBytes?: number;
};

/** Expired uploads and leftover files are cleaned every hour after the startup pass. */
const ATTACHMENT_SWEEP_MS = 60 * 60 * 1000;

export type RunningHub = { url: string; close(): Promise<void> };

/** Starts a hub around an injected database. Database ownership always stays with the caller. */
export async function startHub(opts: StartHubOptions): Promise<RunningHub> {
  const hostname = opts.hostname ?? "127.0.0.1";
  const events = new EventBus();
  let server: http.Server | undefined;
  let attached: ReturnType<typeof attachDaemonSocket> | undefined;
  let fallback: ReturnType<typeof startReportFallback> | undefined;
  const pendingHttp = new Set<Promise<void>>();
  const cancelHttpStreams = new Set<() => Promise<void>>();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;

  try {
    // The previous process may have left tasks running. Recover before accepting HTTP or daemon traffic.
    const interrupted = await interruptRunning(opts.db, "all");
    if (interrupted.requeued.length > 0) console.log(`requeued ${interrupted.requeued.length} task(s) left running by the previous hub process`);
    await announceInterrupted(opts.db, events, interrupted);
    await recoverUncommittedEntries(opts.db, opts.dataDir, opts.ownedHelpers);
    await reconcileWorkspaceEvidence(opts.db, opts.dataDir);
    const attachments = new AttachmentStore(opts.db, opts.dataDir, { maxGlobalBytes: opts.attachmentsMaxBytes });
    // Before any request: only this pass may delete files that have no row (no upload is in flight yet).
    try {
      await attachments.sweep({ startup: true });
    } catch (error) {
      console.error("attachment startup sweep failed", error);
    }

    const status = { connected: () => false };
    const liveDaemon: { rpc: DaemonRpc } = {
      rpc: { call: () => Promise.reject(new DaemonRpcError("daemon 未连接")) },
    };
    const daemon: DaemonRpc = { call: (method, params, timeoutMs) => liveDaemon.rpc.call(method, params, timeoutMs) };
    let requestListener: http.RequestListener = (_req, res) => { res.statusCode = 503; res.end("starting"); };
    server = http.createServer((req, res) => requestListener(req, res));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { server?.off("listening", onListening); reject(error); };
      const onListening = () => { server?.off("error", onError); resolve(); };
      server!.once("error", onError);
      server!.once("listening", onListening);
      server!.listen(opts.port, hostname);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("hub did not bind a TCP address");
    const actualPort = address.port;
    const hubUrl = `http://127.0.0.1:${actualPort}`;
    const app = createApp({
      db: opts.db,
      dataDir: opts.dataDir,
      nemaHome: opts.cleanDaemonDirs === false ? undefined : opts.nemaHome,
      events,
      daemonStatus: () => status.connected(),
      daemon,
      webOrigin: opts.webOrigin,
      uiAuth: opts.uiAuth,
      port: actualPort,
      ownedHelpers: opts.ownedHelpers,
      releaseVersion: opts.releaseVersion,
      attachments,
      ...(opts.ownedHelpers ? { archify: {
        validateDiagram: (type, spec) => validateDiagram(type, spec, opts.ownedHelpers),
        renderDiagram: (type, spec) => renderDiagram(type, spec, opts.ownedHelpers),
      } } : {}),
    });
    const fetchListener = getRequestListener((request, env) => {
      if (closed) return Promise.resolve(new Response("shutting down", { status: 503 }));
      const responsePromise = app.fetch(request, env);
      let resolveFinished!: () => void;
      const finished = new Promise<void>((resolve) => { resolveFinished = resolve; });
      const forwardedResponse = Promise.resolve(responsePromise).then(async (response) => {
        if (!response.body) {
          resolveFinished();
          return response;
        }
        const reader = response.body.getReader();
        if (closed) {
          try {
            await reader.cancel();
          } catch {
            // A failed stream cancellation still completes this response's cleanup attempt.
          } finally {
            reader.releaseLock();
            resolveFinished();
          }
          return new Response(null, { status: 503, headers: response.headers });
        }
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          cancelHttpStreams.delete(cancel);
          reader.releaseLock();
          resolveFinished();
        };
        const cancel = async (): Promise<void> => {
          try { await reader.cancel(); } catch { /* The client may already have disconnected. */ }
          settle();
        };
        cancelHttpStreams.add(cancel);
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const { done, value } = await reader.read();
              if (done) {
                controller.close();
                settle();
              } else controller.enqueue(value);
            } catch (error) {
              controller.error(error);
              settle();
            }
          },
          async cancel() {
            await cancel();
          },
        });
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      }).catch((error) => {
        resolveFinished();
        throw error;
      });
      // `finished` follows the original response stream; the wrapper forwards every byte and cancellation.
      const tracked = Promise.all([forwardedResponse.then(() => undefined, () => undefined), finished]).then(() => undefined);
      pendingHttp.add(tracked);
      void tracked.then(() => pendingHttp.delete(tracked));
      return forwardedResponse;
    });
    requestListener = fetchListener;

    attached = attachDaemonSocket(server, { db: opts.db, dataDir: opts.dataDir, events, daemonToken: opts.daemonToken, hubUrl, ownedHelpers: opts.ownedHelpers, releaseVersion: opts.releaseVersion });
    status.connected = attached.isConnected;
    liveDaemon.rpc = attached.rpc;
    fallback = startReportFallback(opts.db, daemon, events);
    sweepTimer = setInterval(() => {
      void attachments.sweep({ startup: false }).catch((error) => console.error("attachment sweep failed", error));
    }, ATTACHMENT_SWEEP_MS);
    sweepTimer.unref();

    const close = (): Promise<void> => {
      closePromise ??= (async () => {
        if (closed) return;
        closed = true;
        clearInterval(sweepTimer);
        fallback?.stop();
        let httpClosing: Promise<void> | undefined;
        if (server?.listening) {
          httpClosing = new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
          server.closeAllConnections();
          await Promise.all([...cancelHttpStreams].map((cancel) => cancel()));
        }
        await attached?.close();
        await httpClosing;
        await fallback?.drain();
        while (pendingHttp.size > 0) await Promise.all([...pendingHttp]);
      })();
      return closePromise;
    };
    return { url: hubUrl, close };
  } catch (error) {
    clearInterval(sweepTimer);
    fallback?.stop();
    let httpClosing: Promise<void> | undefined;
    if (server?.listening) {
      httpClosing = new Promise<void>((resolve) => server!.close(() => resolve()));
      server.closeAllConnections();
      await Promise.all([...cancelHttpStreams].map((cancel) => cancel()));
    }
    await attached?.close().catch(() => {});
    await fallback?.drain().catch(() => {});
    await httpClosing;
    while (pendingHttp.size > 0) await Promise.all([...pendingHttp]);
    throw error;
  }
}

/** Recovers knowledge writes after migration and before the hub starts serving. */
async function recoverUncommittedEntries(db: Db, dataDir: string, ownedHelpers?: OwnedHelperScope): Promise<void> {
  let workspaces: Workspace[] = [];
  try {
    workspaces = await listWorkspaces(db);
  } catch (err) {
    console.error("failed to list workspaces for uncommitted recovery", err);
    return;
  }
  for (const ws of workspaces) {
    try {
      const { recovered, skipped } = await new KnowledgeStore(repoPath(dataDir, ws.id), ownedHelpers).recoverUncommitted();
      if (recovered.length > 0) {
        const noun = recovered.length === 1 ? "entry" : "entries";
        console.log(`recovered ${recovered.length} uncommitted ${noun} in ${ws.id}`);
      }
      for (const rel of skipped) console.warn(`skipped ${rel} in ${ws.id}`);
      for (const entry of recovered) {
        try {
          await indexEntry(db, ws.id, entry, ownedHelpers);
        } catch (err) {
          console.error(`failed to index recovered entry ${entry.id} in ${ws.id}`, err);
        }
      }
    } catch (err) {
      console.error(`failed to recover uncommitted entries in ${ws.id}`, err);
    }
  }
}

/** Includes archived workspaces; a failed workspace must not prevent startup. */
async function reconcileWorkspaceEvidence(db: Db, dataDir: string): Promise<void> {
  let workspaces: Workspace[];
  try { workspaces = await listWorkspaces(db); }
  catch (error) { console.error("failed to list workspaces for evidence recovery", error); return; }
  for (const workspace of workspaces) {
    try { await reconcileSourceImports(db, dataDir, workspace.id); }
    catch (error) { console.error(`failed to reconcile source imports in ${workspace.id}`, error); }
    try { await reconcileUnconsumedEvents(db, dataDir, workspace.id); }
    catch (error) { console.error(`failed to reconcile evidence events in ${workspace.id}`, error); }
  }
}
