import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, closeSync, writeSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createLocalDb } from "@nema/hub/db/local";
import { EventBus } from "@nema/hub/events";
import { announceInterrupted } from "@nema/hub/interrupts";
import { startHub } from "@nema/hub/lifecycle";
import { interruptRunning } from "@nema/hub/tasks";
import { loadConfig } from "@nema/cli/config";
import { startDaemon } from "@nema/cli/daemon/setup";
import type { OwnedHelperScope } from "@nema/shared/ownedHelper";
import { openPrivateFile, privateModeMatches, protectPrivatePath } from "@nema/cli/secrets/permissions";
import { requireSystemGit } from "@nema/cli/systemGit";
import { acquireInstance, discoverInstance, requestInstanceShutdown, type InstanceLease } from "./instance.js";
import { resolveHome } from "./paths.js";
import { createGatewayCredential, createGatewayUiAuth, startGateway, type RunningGateway } from "./gateway.js";
import { SessionManager } from "./session.js";
import { createAppReleaseService, readBuildIdentity, type AppReleaseService } from "./appRelease.js";
import { createSettingsService, type SettingsOperations, type SettingsService } from "./settings.js";
import { createOwnedHelperScope } from "./ownedHelpers.js";

const MANIFEST_NAME = "runtime-manifest.json";
const WEB_READY_TIMEOUT_MS = 15_000;
const DAEMON_READY_TIMEOUT_MS = 10_000;
const ENSURE_READY_TIMEOUT_MS = 20_000;
const PROBE_INTERVAL_MS = 75;
const ensuredChildren = new Map<string, Set<ChildProcess>>();

type EnsureSpawnSpec = { nodePath: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv };
type EnsureSpawner = (spec: EnsureSpawnSpec) => ChildProcess;
let ensureSpawnerForTests: EnsureSpawner | undefined;
type RuntimeReadyHook = (runtime: { db: Awaited<ReturnType<typeof createLocalDb>>; home: string; dataDir: string; webPort: number; webChild: ChildProcess }) => Promise<void>;
let runtimeReadyHookForTests: RuntimeReadyHook | undefined;
let ensureTimeoutForTests: number | undefined;
let settingsOperationsForTests: SettingsOperations | undefined;

/** Explicit source-child hook used only by process tests; release builds never set it. */
export function setEnsureSpawnerForTests(spawner: EnsureSpawner | undefined): void {
  ensureSpawnerForTests = spawner;
}

/** Explicit test seam for seeding committed runtime state before descriptor publication. */
export function setRuntimeReadyHookForTests(hook: RuntimeReadyHook | undefined): void {
  runtimeReadyHookForTests = hook;
}

export function setEnsureTimeoutForTests(timeoutMs: number | undefined): void {
  ensureTimeoutForTests = timeoutMs;
}

/** Explicit fake auth operations for lifecycle tests; never set by packaged startup. */
export function setSettingsOperationsForTests(operations: SettingsOperations | undefined): void {
  settingsOperationsForTests = operations;
}

type RuntimeManifest = {
  schemaVersion: 1;
  version: string;
  platform: string;
  arch: string;
  node: string;
  coreEntry: string;
  cliEntry: string;
  webEntry: string;
  licenses: string;
  ownedHelperGuardian?: string;
  commit?: string;
  build?: { commit?: string };
};

type ResolvedAssets = RuntimeManifest & {
  root: string;
  nodePath: string;
  corePath: string;
  cliPath: string;
  webPath: string;
  licensesPath: string;
  ownedHelperGuardianPath?: string;
};

export type LocalRuntime = {
  origin: string;
  /** Resolves after an unexpected managed Web child exit has been drained. */
  failure: Promise<Error>;
  createLaunchTicket(): string;
  close(): Promise<void>;
};

export type LocalRuntimeOptions = { home?: string; assetsDir: string; webPort?: number };

function manifestEntry(root: string, value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || value.includes("\\") || isAbsolute(value)) {
    throw new Error(`Runtime manifest has an invalid ${name} path`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part === ".." || part === "" || part === ".")) throw new Error(`Runtime manifest ${name} must be relative to assetsDir`);
  const candidate = resolve(root, ...parts);
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Runtime manifest ${name} escapes assetsDir`);
  let actual: string;
  try { actual = realpathSync.native(candidate); }
  catch { throw new Error(`Runtime manifest ${name} asset is missing`); }
  const actualRel = relative(root, actual);
  if (actualRel === ".." || actualRel.startsWith(`..${sep}`) || isAbsolute(actualRel)) throw new Error(`Runtime manifest ${name} asset escapes assetsDir`);
  return actual;
}

function readManifest(assetsDir: string): ResolvedAssets {
  let root: string;
  try { root = realpathSync.native(resolve(assetsDir)); }
  catch { throw new Error(`Runtime manifest directory is missing: ${assetsDir}`); }
  const file = join(root, MANIFEST_NAME);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); }
  catch { throw new Error(`Runtime manifest is missing or malformed: ${file}`); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Runtime manifest must be a JSON object");
  const value = raw as Partial<RuntimeManifest>;
  if (value.schemaVersion !== 1 || typeof value.version !== "string" || !value.version.trim() ||
    value.platform !== process.platform || value.arch !== process.arch) {
    throw new Error("Runtime manifest version, schema, platform, or architecture does not match this runtime");
  }
  const nodePath = manifestEntry(root, value.node, "node");
  const corePath = manifestEntry(root, value.coreEntry, "coreEntry");
  const cliPath = manifestEntry(root, value.cliEntry, "cliEntry");
  const webPath = manifestEntry(root, value.webEntry, "webEntry");
  const licensesPath = manifestEntry(root, value.licenses, "licenses");
  const ownedHelperGuardianPath = process.platform === "win32"
    ? manifestEntry(root, value.ownedHelperGuardian, "ownedHelperGuardian")
    : undefined;
  if (!existsSync(nodePath) || !existsSync(corePath) || !existsSync(cliPath) || !existsSync(webPath) || !existsSync(licensesPath) ||
    (ownedHelperGuardianPath !== undefined && !existsSync(ownedHelperGuardianPath))) {
    throw new Error("Runtime manifest references a missing asset");
  }
  return { ...value as RuntimeManifest, root, nodePath, corePath, cliPath, webPath, licensesPath, ...(ownedHelperGuardianPath ? { ownedHelperGuardianPath } : {}) };
}

function installationIdentity(assets: ResolvedAssets): string {
  const root = process.platform === "win32" ? assets.root.toLowerCase() : assets.root;
  const manifestIdentity = [assets.version, assets.platform, assets.arch, assets.node, assets.coreEntry, assets.cliEntry, assets.webEntry, assets.licenses, assets.ownedHelperGuardian ?? null];
  return createHash("sha256").update(JSON.stringify([root, manifestIdentity])).digest("hex");
}

function ensureOwnedDirectory(home: string, directory: string, name: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Local ${name} directory must be a real directory inside the managed home`);
  const canonical = realpathSync.native(directory);
  const rel = relative(home, canonical);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel === "") {
    throw new Error(`Local ${name} directory escapes the managed home`);
  }
  protectPrivatePath(directory, 0o700);
}

function privateDaemonToken(home: string): string {
  const dataDir = join(home, "data");
  const file = join(dataDir, "daemon-token");
  let existing: number;
  try {
    existing = openPrivateFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const token = randomBytes(32).toString("hex");
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { writeSync(fd, token); protectPrivatePath(file, 0o600); } finally { closeSync(fd); }
    return token;
  }
  try {
    const stat = fstatSync(existing);
    if (!stat.isFile() || !privateModeMatches(stat) || stat.size > 256) throw new Error("Local daemon token is not a trusted private file");
    const token = readFileSync(existing, "utf8").trim();
    if (!/^[0-9a-f]{64}$/.test(token)) throw new Error("Local daemon token is malformed");
    return token;
  } finally { closeSync(existing); }
}

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Could not select a loopback port"));
      const port = address.port;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

function childEnvironment(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "LANG", "LC_ALL", "CODEX_HOME"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // Git comes from the user's PATH: Nema runs the git they already use, with their credential helpers and SSH setup.
  env.PATH = process.env.PATH ?? process.env.Path;
  delete env.Path;
  return { ...env, ...extra };
}

function spawnWeb(assets: ResolvedAssets, port: number): ChildProcess {
  const args = assets.webPath.endsWith(".mjs") || assets.webPath.endsWith(".js")
    ? [assets.webPath]
    : [assets.webPath];
  const child = spawn(assets.nodePath, args, {
    cwd: dirname(assets.webPath),
    env: childEnvironment({
      PORT: String(port), HOSTNAME: "127.0.0.1", NODE_ENV: "production", NEXT_PUBLIC_NEMA_LOCAL: "1",
    }),
    // This private channel is intentionally separate from the core launcher's readiness IPC.
    // A hard core exit closes it, allowing the managed Web wrapper to stop its listener.
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  child.on("error", () => {});
  return child;
}

async function httpReady(url: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Managed Web process exited before becoming ready");
    try {
      await new Promise<void>((resolveProbe, reject) => {
        const req = http.get(url, { timeout: 500 }, (res) => { res.resume(); res.once("end", resolveProbe); });
        req.once("timeout", () => req.destroy(new Error("Web readiness probe timed out")));
        req.once("error", reject);
      });
      return;
    } catch (error) { lastError = error; }
    await new Promise<void>((resolveProbe) => setTimeout(resolveProbe, PROBE_INTERVAL_MS));
  }
  throw new Error(`Managed Web did not become HTTP-ready within ${timeoutMs}ms`, { cause: lastError });
}

async function daemonReady(hubUrl: string, credential: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const connected = await new Promise<boolean>((resolveProbe, reject) => {
        const req = http.get(`${hubUrl}/api/daemon/status`, { headers: { "x-nema-gateway-credential": credential }, timeout: 500 }, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => { body += chunk; });
          res.once("end", () => {
            try { resolveProbe(res.statusCode === 200 && (JSON.parse(body) as { connected?: unknown }).connected === true); }
            catch { resolveProbe(false); }
          });
        });
        req.once("timeout", () => req.destroy(new Error("Daemon readiness probe timed out")));
        req.once("error", reject);
      });
      if (connected) return;
    } catch { /* the hub is still accepting startup connections */ }
    await new Promise<void>((resolveProbe) => setTimeout(resolveProbe, PROBE_INTERVAL_MS));
  }
  throw new Error(`Managed daemon did not connect within ${timeoutMs}ms`);
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const waitExit = (timeoutMs: number): Promise<boolean> => new Promise((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolveExit(true);
    const timer = setTimeout(() => { child.off("exit", exited); resolveExit(false); }, timeoutMs);
    const exited = () => { clearTimeout(timer); resolveExit(true); };
    child.once("exit", exited);
  });
  if (child.stdin?.writable) {
    child.stdin.on("error", () => undefined);
    child.stdin.write("close\n");
    const graceful = await waitExit(2_000);
    if (graceful) return;
  }
  try { child.kill(); } catch { /* A concurrently exited child needs no further cleanup. */ }
  const graceful = await waitExit(2_000);
  if (graceful) return;
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill("SIGKILL"); } catch { /* best effort for this owned child handle */ }
    const killed = await waitExit(1_000);
    if (!killed) throw new Error(`Owned Web process ${child.pid ?? "unknown"} did not exit after termination`);
  }
}

function validWebChild(child: ChildProcess | undefined): boolean {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

function webExitError(child: ChildProcess | undefined, cause?: unknown): Error {
  const error = new Error("Managed Web process exited unexpectedly", cause === undefined ? undefined : { cause });
  const code = child?.exitCode;
  if (code !== null && code !== undefined) error.message += ` (exit ${code})`;
  return error;
}

function appendFailure(errors: unknown[], error: unknown): void { errors.push(error); }
function throwCleanupErrors(errors: unknown[], primary?: unknown): void {
  if (primary !== undefined) errors.unshift(primary);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Local runtime startup or shutdown cleanup failed");
}

export async function startLocalRuntime(options: LocalRuntimeOptions): Promise<LocalRuntime> {
  // Startup timings on stdout; a managed core discards them unless NEMA_LOCAL_CORE_LOG names a file.
  const startedAt = Date.now();
  const phase = (name: string) => process.stdout.write(`${JSON.stringify({
    state: "startup-phase", phase: name, ms: Date.now() - startedAt, uptimeMs: Math.round(process.uptime() * 1000),
  })}\n`);
  phase("begin");
  const assets = readManifest(options.assetsDir);
  if (options.webPort !== undefined && (!Number.isInteger(options.webPort) || options.webPort < 0 || options.webPort > 65535)) {
    throw new Error("webPort must be a valid TCP port");
  }

  // Ownership is acquired before the DB path is opened or any home-owned runtime data is written.
  const paths = resolveHome(options.home);
  // Validate and configure the helper owner before hub migrations/recovery can invoke Git or archify.
  const helperScope: OwnedHelperScope | undefined = assets.ownedHelperGuardianPath
    ? createOwnedHelperScope(assets.ownedHelperGuardianPath)
    : undefined;
  phase("helper-scope");
  const lease = await acquireInstance(paths.home, installationIdentity(assets));
  phase("lease");
  let db: Awaited<ReturnType<typeof createLocalDb>> | undefined;
  let hub: Awaited<ReturnType<typeof startHub>> | undefined;
  let daemon: ReturnType<typeof startDaemon> | undefined;
  let webChild: ChildProcess | undefined;
  let gateway: RunningGateway | undefined;
  let session: SessionManager | undefined;
  let settings: SettingsService | undefined;
  let appRelease: AppReleaseService | undefined;
  const events = new EventBus();
  let teardownPromise: Promise<void> | undefined;
  let startupComplete = false;
  let stopRequested = false;
  let unexpectedWebExit: Error | undefined;
  let resolveFailure!: (error: Error) => void;
  const failure = new Promise<Error>((resolveFailurePromise) => { resolveFailure = resolveFailurePromise; });
  const onUnexpectedWebExit = (cause?: unknown) => {
    if (stopRequested || unexpectedWebExit) return;
    unexpectedWebExit = webExitError(webChild, cause);
    if (startupComplete) {
      void teardown(unexpectedWebExit).catch((error: unknown) => {
        resolveFailure(error instanceof Error ? error : unexpectedWebExit!);
      });
    }
  };
  const assertWebAlive = () => {
    if (unexpectedWebExit || validWebChild(webChild)) throw unexpectedWebExit ?? webExitError(webChild);
  };
  const teardown = (primary?: unknown): Promise<void> => {
    teardownPromise ??= (async () => {
      stopRequested = true;
      const errors: unknown[] = [];
      helperScope?.stopAccepting();
      // Prevent new auth work immediately; the service drains only after HTTP acceptance is stopped.
      try { settings?.stopAccepting(); } catch (error) { appendFailure(errors, error); }
      try { appRelease?.close(); } catch (error) { appendFailure(errors, error); }
      // Revoke sessions and retire launch readiness before draining services.
      try { session?.close(); } catch (error) { appendFailure(errors, error); }
      let unpublished = false;
      try { await lease.unpublish(); unpublished = true; } catch (error) { appendFailure(errors, error); }
      let gatewayStopped = !gateway;
      try { await gateway?.close(); gatewayStopped = true; } catch (error) { appendFailure(errors, error); }
      // Stop hub dispatch and all incoming hub writes before changing task run tokens.
      let hubDrained = !hub;
      try { await hub?.close(); hubDrained = true; } catch (error) { appendFailure(errors, error); }
      // Expected cancellation/failure is a terminal job result; this wait is about actual resource drain.
      try { await settings?.close(); } catch (error) { appendFailure(errors, error); }
      if (db && hubDrained) {
        try {
          const interrupted = await interruptRunning(db, "all");
          await announceInterrupted(db, events, interrupted);
        } catch (error) { appendFailure(errors, error); }
      }
      // Wait for agent cleanup, stop Web, close DB, and release the kernel lease last.
      let daemonStopped = !daemon;
      try { await daemon?.close(); daemonStopped = true; } catch (error) { appendFailure(errors, error); }
      let helpersDrained = !helperScope;
      try { await helperScope?.drain(); helpersDrained = true; } catch (error) { appendFailure(errors, error); }
      let webStopped = validWebChild(webChild);
      try { await stopChild(webChild); webStopped = validWebChild(webChild); } catch (error) { appendFailure(errors, error); webStopped = false; }
      let dbClosed = !db;
      if (hubDrained && daemonStopped && helpersDrained) {
        try { await db?.close(); dbClosed = true; } catch (error) { appendFailure(errors, error); }
      }
      if (unpublished && gatewayStopped && hubDrained && daemonStopped && helpersDrained && webStopped && dbClosed) {
        try { await lease.close(); } catch (error) { appendFailure(errors, error); }
      }
      throwCleanupErrors(errors, primary);
    })();
    return teardownPromise;
  };
  lease.setShutdownHandler(() => teardown());
  try {
    ensureOwnedDirectory(paths.home, paths.data, "data");
    const token = privateDaemonToken(paths.home);
    phase("private-files");
    const gatewayCredential = createGatewayCredential();
    const sessionManager = session = new SessionManager();
    const webPort = await freeLoopbackPort();
    const publicPort = options.webPort === undefined || options.webPort === 0 ? await freeLoopbackPort() : options.webPort;
    webChild = spawnWeb(assets, webPort);
    webChild.on("message", (message: unknown) => {
      if (message && typeof message === "object" && (message as { type?: unknown }).type === "managed-web-ready" &&
        (message as { port?: unknown }).port === webPort) {
        process.stdout.write(`${JSON.stringify({ state: "web-ready", port: webPort })}\n`);
      }
    });
    webChild.once("error", (error) => onUnexpectedWebExit(error));
    webChild.once("exit", () => onUnexpectedWebExit());
    await httpReady(`http://127.0.0.1:${webPort}/`, webChild, WEB_READY_TIMEOUT_MS);
    assertWebAlive();
    phase("web");

    ensureOwnedDirectory(paths.home, paths.db, "database");
    db = await createLocalDb(paths.db);
    assertWebAlive();
    phase("db");
    hub = await startHub({
      db,
      dataDir: paths.data,
      nemaHome: paths.home,
      daemonToken: token,
      port: 0,
      webOrigin: `http://127.0.0.1:${publicPort}`,
      uiAuth: createGatewayUiAuth(gatewayCredential),
      ownedHelpers: helperScope,
      releaseVersion: assets.version,
    });
    assertWebAlive();
    phase("hub");
    daemon = startDaemon({
      hubUrl: hub.url,
      token,
      nemaHome: paths.home,
      graphify: { bin: join(assets.root, "tools", "graphify", process.platform === "win32" ? "graphify.exe" : "graphify") },
      // Coding-agent hooks are installed once per user and sign with ~/.nema/report-token, whichever app they reach.
      reportTokenHome: join(homedir(), ".nema"),
      userCodexHome: process.env.CODEX_HOME ?? join(homedir(), ".codex"),
      version: assets.version,
      getConfig: () => loadConfig(paths.home),
      cliEntry: assets.cliPath,
      execPath: assets.nodePath,
      ownedHelpers: helperScope,
    });
    await daemonReady(hub.url, gatewayCredential, DAEMON_READY_TIMEOUT_MS);
    assertWebAlive();
    phase("daemon");
    settings = createSettingsService({ home: paths.home, codexHome: process.env.CODEX_HOME ?? join(homedir(), ".codex"), operations: settingsOperationsForTests });
    appRelease = createAppReleaseService({ home: paths.home, ...readBuildIdentity(assets.root, assets) });
    gateway = await startGateway({
      webTarget: `http://127.0.0.1:${webPort}`,
      hubTarget: hub.url,
      session: sessionManager,
      port: publicPort,
      privateGatewayCredential: gatewayCredential,
      settings,
      appRelease,
    });
    assertWebAlive();
    if (runtimeReadyHookForTests && db && webChild) await runtimeReadyHookForTests({ db, home: paths.home, dataDir: paths.data, webPort, webChild });
    assertWebAlive();
    phase("gateway");
    await lease.publish({ origin: gateway.origin, createLaunchUrl: () => `${gateway!.origin}/_nema/launch?ticket=${sessionManager.issueTicket()}` });
    assertWebAlive();
    phase("published");

    const runtime: LocalRuntime = {
      origin: gateway.origin,
      failure,
      createLaunchTicket: () => sessionManager.issueTicket(),
      close: () => teardown(),
    };
    startupComplete = true;
    return runtime;
  } catch (error) {
    try { await teardown(error); }
    finally { if (unexpectedWebExit) resolveFailure(unexpectedWebExit); }
    throw error;
  }
}

export async function ensureLocalRuntime(options: LocalRuntimeOptions): Promise<{ origin: string; launchUrl: string; instanceId: string; installationId: string; reused: boolean }> {
  const expectedInstallationId = installationIdentity(readManifest(options.assetsDir));
  const existing = await discoverInstance(options.home);
  if (existing) {
    if (existing.installationId !== expectedInstallationId) throw new Error("A local core from another installation owns this home");
    return { ...existing, reused: true };
  }
  const assets = readManifest(options.assetsDir);
  // Before starting a core: without a usable system git, the desktop shows this install guidance instead.
  await requireSystemGit();
  const paths = resolveHome(options.home);
  if (!/\.(?:mjs|js)$/i.test(assets.corePath)) throw new Error("Runtime manifest coreEntry must be compiled JavaScript");
  const childArgs = [
    assets.corePath,
    "--serve",
    paths.home,
    assets.root,
    ...(options.webPort === undefined ? [] : [String(options.webPort)]),
  ];
  const spec = { nodePath: assets.nodePath, args: childArgs, cwd: assets.root, env: childEnvironment({}) };
  // Diagnostics only: the desktop smoke names a file here to capture the core's startup phases and stderr.
  const coreLog = process.env.NEMA_LOCAL_CORE_LOG ? openSync(process.env.NEMA_LOCAL_CORE_LOG, "a") : "ignore";
  let child: ChildProcess;
  try {
    child = ensureSpawnerForTests
      ? ensureSpawnerForTests(spec)
      : spawn(spec.nodePath, spec.args, { cwd: spec.cwd, detached: true, env: spec.env, stdio: ["ignore", coreLog, coreLog, "ipc"], windowsHide: true });
  } finally {
    if (typeof coreLog === "number") closeSync(coreLog);
  }
  let outcome: { type: "ready" } | { type: "collision" } | { type: "error"; code: string; message: string } | undefined;
  let spawnFailure: Error | undefined;
  let spawned = child.pid !== undefined;
  let settleSpawn!: () => void;
  const spawnSettled = new Promise<void>((resolveSpawn) => { settleSpawn = resolveSpawn; });
  if (spawned) settleSpawn();
  child.once("message", (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const value = message as { type?: unknown; code?: unknown; message?: unknown };
    if (value.type === "core-ready") outcome = { type: "ready" };
    else if (value.type === "core-error" && value.code === "NEMA_LOCAL_OWNER_COLLISION") outcome = { type: "collision" };
    else if (value.type === "core-error") outcome = {
      type: "error",
      code: typeof value.code === "string" ? value.code : "NEMA_LOCAL_START_FAILED",
      message: typeof value.message === "string" ? value.message : "Managed local core failed to start",
    };
  });
  child.once("error", (error) => { spawnFailure = error; settleSpawn(); });
  const key = process.platform === "win32" ? paths.home.toLowerCase() : paths.home;
  let owned = ensuredChildren.get(key);
  if (!owned) ensuredChildren.set(key, (owned = new Set()));
  owned.add(child);
  const forgetOwnedChild = () => {
    owned!.delete(child);
    if (owned!.size === 0) ensuredChildren.delete(key);
  };
  child.once("exit", forgetOwnedChild);
  child.once("close", forgetOwnedChild);
  child.unref();
  const timeoutMs = ensureTimeoutForTests ?? ENSURE_READY_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let exited = child.exitCode !== null || child.signalCode !== null;
  child.once("exit", () => { exited = true; });
  child.once("spawn", () => { spawned = true; settleSpawn(); });
  let collisionSeen = false;
  let verifiedCore = false;
  const closeLauncherChannel = () => {
    if (child.connected) {
      try { child.disconnect(); return undefined; } catch (error) { return error; }
    }
    return undefined;
  };
  try {
    while (Date.now() < deadline) {
      let instance: Awaited<ReturnType<typeof discoverInstance>> = null;
      try { instance = await discoverInstance(options.home); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "NEMA_LOCAL_CONTROL_TIMEOUT" && outcome?.type === "error") {
          throw new Error(`${outcome.message} (${outcome.code})`, { cause: error });
        }
        if (code === "NEMA_LOCAL_CONTROL_TIMEOUT" && spawnFailure) {
          throw new Error(`Could not spawn managed local core (${spawnFailure.message})`, { cause: spawnFailure });
        }
        const childIsLive = spawned && child.exitCode === null && child.signalCode === null;
        if (code !== "NEMA_LOCAL_CONTROL_TIMEOUT" || !childIsLive) throw error;
      }
      if (instance && instance.installationId !== expectedInstallationId) throw new Error("A local core from another installation owns this home");
      if (instance && outcome?.type === "ready") {
        verifiedCore = true;
        const channelError = closeLauncherChannel();
        if (channelError) throw new Error("Could not release the launcher IPC channel after core readiness", { cause: channelError });
        return { ...instance, reused: false };
      }
      if (instance && (collisionSeen || outcome?.type === "collision")) {
        verifiedCore = true;
        const channelError = closeLauncherChannel();
        if (channelError) throw new Error("Could not release the launcher IPC channel after reusing the verified core", { cause: channelError });
        return { ...instance, reused: true };
      }
      if (outcome?.type === "ready" && exited) {
        throw new Error("Managed local core reported ready but did not publish an authenticated instance");
      }
      if (outcome?.type === "collision") collisionSeen = true;
      if (outcome?.type === "error") throw new Error(`${outcome.message} (${outcome.code})`);
      if (spawnFailure) throw new Error(`Could not spawn managed local core (${spawnFailure.message})`, { cause: spawnFailure });
      if (exited && !collisionSeen && !outcome) {
        throw new Error(`Managed local core exited before reporting startup status (${child.exitCode ?? child.signalCode ?? "unknown"})`);
      }
      await new Promise<void>((resolveProbe) => setTimeout(resolveProbe, PROBE_INTERVAL_MS));
    }
    if (collisionSeen) throw new Error(`Another local core owns the control port but did not publish authenticated readiness within ${timeoutMs}ms`);
    throw new Error(`Managed local core did not become ready within ${timeoutMs}ms`);
  } catch (primary) {
    const cleanupErrors: unknown[] = [];
    const channelError = closeLauncherChannel();
    if (channelError) cleanupErrors.push(channelError);
    if (!spawned && !spawnFailure) await spawnSettled;
    if (!verifiedCore && spawned && child.exitCode === null && child.signalCode === null) {
      try { await stopChild(child); } catch (error) { cleanupErrors.push(error); }
    }
    if (!spawned) forgetOwnedChild();
    if (cleanupErrors.length) throw new AggregateError([primary, ...cleanupErrors], "Managed local core launch failed and child cleanup was incomplete", { cause: primary });
    throw primary;
  }
}

export async function shutdownLocalRuntime(options: LocalRuntimeOptions & { expectedInstanceId: string; timeoutMs?: number }): Promise<{ state: "complete" }> {
  const assets = readManifest(options.assetsDir);
  return requestInstanceShutdown(options.home ?? join(homedir(), ".nema", "desktop"), {
    expectedInstanceId: options.expectedInstanceId,
    expectedInstallationId: installationIdentity(assets),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
}

/** Test cleanup only: terminates detached core children launched by this module in the current test process. */
export async function closeEnsuredRuntimesForTests(home: string): Promise<void> {
  const canonical = resolveHome(home).home;
  const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  const children = [...(ensuredChildren.get(key) ?? [])];
  const results = await Promise.allSettled(children.map((child) => stopChild(child)));
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason);
  if (failures.length) throw new AggregateError(failures, "Could not stop test-owned local core children");
}
