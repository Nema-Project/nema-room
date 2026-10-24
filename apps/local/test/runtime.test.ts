import { copyFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeEnsuredRuntimesForTests, setEnsureSpawnerForTests, setEnsureTimeoutForTests, setRuntimeReadyHookForTests, setSettingsOperationsForTests, startLocalRuntime, ensureLocalRuntime } from "../src/runtime.js";
import { acquireInstance, discoverInstance } from "../src/instance.js";
import { createLocalDb } from "@nema/hub/db/local";
import { postUserMessage } from "@nema/hub/messages";
import { claimNextTask, getTask, resolveRunToken } from "@nema/hub/tasks";
import { createWorkspace } from "@nema/hub/workspaces";
import { protectPrivatePath } from "@nema/cli/secrets/permissions";

const testHomeDirs: string[] = [];
const runtimes: Array<{ close(): Promise<void> }> = [];
const ensuredHomes: string[] = [];
const crashChildren: ChildProcess[] = [];
let guardianFixtureDir: string | undefined;
let guardianFixturePath: string | undefined;

beforeAll(() => {
  if (process.platform !== "win32") return;
  guardianFixtureDir = mkdtempSync(join(tmpdir(), "nema-runtime-guardian-"));
  guardianFixturePath = join(guardianFixtureDir, "owned-helper.exe");
  execFileSync(process.execPath, ["scripts/desktop/build-owned-helper.mjs", "--output", guardianFixturePath], { stdio: "inherit" });
});

afterAll(() => {
  if (guardianFixtureDir) rmSync(guardianFixtureDir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  testHomeDirs.push(dir);
  return dir;
}

function testAssets(): string {
  const assets = tempDir("nema-assets-");
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  const node = join(assets, "node", nodeName);
  mkdirSync(dirname(node), { recursive: true });
  copyFileSync(process.execPath, node);
  mkdirSync(join(assets, "git"), { recursive: true });
  writeFileSync(join(assets, "git", "git.exe"), "test fixture");
  let ownedHelperGuardian: string | undefined;
  if (process.platform === "win32") {
    ownedHelperGuardian = "runtime/owned-helper.exe";
    if (!guardianFixturePath) throw new Error("Windows runtime test guardian was not built");
    const guardianPath = join(assets, ownedHelperGuardian);
    mkdirSync(dirname(guardianPath), { recursive: true });
    copyFileSync(guardianFixturePath, guardianPath);
  }
  mkdirSync(join(assets, "licenses"), { recursive: true });
  cpSync("apps/local/test/fixtures", join(assets, "fixtures"), { recursive: true });
  writeFileSync(join(assets, "runtime-manifest.json"), JSON.stringify({
    schemaVersion: 1,
    version: "test-version",
    platform: process.platform,
    arch: process.arch,
    node: `node/${nodeName}`,
    git: "git/git.exe",
    coreEntry: "fixtures/core-child.mjs",
    cliEntry: "fixtures/fake-cli.mjs",
    webEntry: "fixtures/fake-web.mjs",
    licenses: "licenses",
    ...(ownedHelperGuardian ? { ownedHelperGuardian } : {}),
  }));
  return assets;
}

function spawnCrashOwner(home: string, assetsDir: string): {
  child: ChildProcess;
  seeded: Promise<{ taskId: string; token: string }>;
  ready: Promise<{ origin: string }>;
  webPort: Promise<number>;
} {
  const child = spawn(process.execPath, ["--conditions=development", "--import", "tsx", "apps/local/test/fixtures/crash-runtime-child.ts", home, assetsDir], {
    cwd: process.cwd(),
    env: { ...process.env, CODEX_HOME: join(home, "codex-home") },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  crashChildren.push(child);
  child.stderr?.resume();
  let buffered = "";
  let errors = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { errors += chunk; });
  const waiters = new Map<string, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();
  const waitFor = (phase: string) => new Promise<Record<string, unknown>>((resolvePromise, reject) => waiters.set(phase, { resolve: resolvePromise, reject }));
  child.once("exit", (code, signal) => {
    const marker = join(assetsDir, "fixtures", "web-exited.marker");
    const webExit = existsSync(marker) ? readFileSync(marker, "utf8") : "no Web exit marker";
    for (const [phase, waiter] of waiters) waiter.reject(new Error(`crash fixture exited before ${phase} (${code ?? signal}): ${errors}; ${webExit}`));
    waiters.clear();
  });
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    buffered += chunk;
    while (buffered.includes("\n")) {
      const end = buffered.indexOf("\n");
      const line = buffered.slice(0, end).trim();
      buffered = buffered.slice(end + 1);
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        const phase = String(value.phase ?? "");
        const waiter = waiters.get(phase);
        if (waiter) { waiters.delete(phase); waiter.resolve(value); }
      } catch { /* hub startup diagnostics are not fixture messages */ }
    }
  });
  const seeded = waitFor("seeded").then((value) => ({ taskId: String(value.taskId), token: String(value.token) }));
  const ready = waitFor("ready").then((value) => ({ origin: String(value.origin) }));
  const webPort = waitFor("web-port").then((value) => Number(value.port));
  return { child, seeded, ready, webPort };
}

function sourceCoreSpawner(): (spec: { args: string[]; env: NodeJS.ProcessEnv }) => ChildProcess {
  const sourceEntry = join(process.cwd(), "apps", "local", "src", "index.ts");
  return ({ args, env }) => {
    const child = spawn(process.execPath, ["--conditions=development", "--import", "tsx", sourceEntry, ...args.slice(1)], {
      cwd: process.cwd(), env, stdio: ["pipe", "ignore", "pipe", "ipc"], windowsHide: true,
    });
    child.stderr?.resume();
    return child;
  };
}

function delayedOwnerSpawner(mode: "delayed" | "stall" | "error-stall", delayMs: number): (spec: { args: string[]; env: NodeJS.ProcessEnv }) => ChildProcess {
  const fixture = join(process.cwd(), "apps", "local", "test", "fixtures", "delayed-owner-child.mjs");
  const permissions = join(process.cwd(), "apps", "cli", "src", "secrets", "permissions.ts");
  return ({ args, env }) => {
    const child = spawn(process.execPath, ["--import", "tsx", fixture, args[1]!, args[2]!, "synthetic-assets", permissions, mode, String(delayMs)], {
      cwd: process.cwd(), env, stdio: ["pipe", "ignore", "pipe", "ipc"], windowsHide: true,
    });
    child.stderr?.resume();
    return child;
  };
}

async function leaveStaleDescriptor(home: string): Promise<void> {
  const lease = await acquireInstance(home);
  await lease.publish({ origin: "http://127.0.0.1:43210", createLaunchUrl: () => "http://127.0.0.1:43210/" });
  const descriptor = readFileSync(join(home, "instance.json"));
  await lease.close();
  writeFileSync(join(home, "instance.json"), descriptor, { mode: 0o600 });
  protectPrivatePath(join(home, "instance.json"), 0o600);
}

async function closeCrashChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
  child.send?.({ action: "close-runtime" });
  const closed = await new Promise<boolean>((resolvePromise) => {
    const timer = setTimeout(() => { child.off("exit", onExit); resolvePromise(false); }, 15_000);
    const onExit = () => { clearTimeout(timer); resolvePromise(true); };
    child.once("exit", onExit);
  });
  if (closed) return;
  try { child.kill(); } catch { /* test-owned core child only */ }
  await exited;
}

afterEach(async () => {
  await Promise.all(ensuredHomes.splice(0).map((home) => closeEnsuredRuntimesForTests(home)));
  setEnsureSpawnerForTests(undefined);
  setEnsureTimeoutForTests(undefined);
  setRuntimeReadyHookForTests(undefined);
  setSettingsOperationsForTests(undefined);
  await Promise.all(crashChildren.splice(0).map(closeCrashChild));
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  for (const dir of testHomeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("managed local runtime", () => {
  it.runIf(process.platform === "win32")("refuses a Windows payload without its helper guardian before acquiring ownership", async () => {
    const assetsDir = testAssets();
    const manifestPath = join(assetsDir, "runtime-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    delete manifest.ownedHelperGuardian;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const home = join(tempDir("nema-home-"), "missing-helper-guardian");
    await expect(startLocalRuntime({ home, assetsDir })).rejects.toThrow(/ownedHelperGuardian/i);
    expect(await discoverInstance(home)).toBeNull();
  });

  it("retries only a spawned owner's control timeout while authenticated readiness is still starting", async () => {
    const home = join(tempDir("nema-home-"), "delayed-authenticated-owner");
    mkdirSync(home, { recursive: true });
    await leaveStaleDescriptor(home);
    setEnsureSpawnerForTests(delayedOwnerSpawner("delayed", 3_500));
    ensuredHomes.push(home);

    const result = await ensureLocalRuntime({ home, assetsDir: testAssets() });
    expect(result).toMatchObject({ origin: "http://127.0.0.1:43210", reused: false });
    expect(result.launchUrl).toMatch(/^http:\/\/127\.0\.0\.1:43210\/_nema\/launch\?ticket=/);
    expect(await discoverInstance(home)).toMatchObject({ origin: result.origin });
  }, 30_000);

  it("keeps an unresponsive spawned owner bounded by the existing ensure deadline and cleans it up", async () => {
    const home = join(tempDir("nema-home-"), "stalled-authenticated-owner");
    mkdirSync(home, { recursive: true });
    await leaveStaleDescriptor(home);
    setEnsureSpawnerForTests(delayedOwnerSpawner("stall", 0));
    setEnsureTimeoutForTests(500);
    ensuredHomes.push(home);
    const startedAt = Date.now();

    await expect(ensureLocalRuntime({ home, assetsDir: testAssets() })).rejects.toThrow(/did not become ready within 500ms/i);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(await discoverInstance(home)).toBeNull();
    ensuredHomes.splice(ensuredHomes.indexOf(home), 1);
  }, 10_000);

  it("reports an owned child startup error instead of retrying a timed-out control request", async () => {
    const home = join(tempDir("nema-home-"), "error-during-control-timeout");
    mkdirSync(home, { recursive: true });
    await leaveStaleDescriptor(home);
    setEnsureSpawnerForTests(delayedOwnerSpawner("error-stall", 0));
    ensuredHomes.push(home);

    await expect(ensureLocalRuntime({ home, assetsDir: testAssets() })).rejects.toThrow(/Synthetic owner startup failure \(NEMA_LOCAL_TEST_START_FAILED\)/);
  }, 12_000);

  it("starts the disk database and only publishes after loopback web readiness", async () => {
    const home = join(tempDir("nema-home-"), "room with spaces-東京");
    const runtime = await startLocalRuntime({ home, assetsDir: testAssets() });
    runtimes.push(runtime);
    expect(runtime.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(existsSync(join(home, "db", "PG_VERSION"))).toBe(true);
    expect(JSON.parse(readFileSync(join(home, "instance.json"), "utf8"))).toMatchObject({ schemaVersion: 1, protocol: "nema-local-v1" });
    expect(runtime.createLaunchTicket()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("cancels settings work early and drains it before releasing the runtime lease", async () => {
    const home = join(tempDir("nema-home-"), "settings-drain");
    let release!: () => void;
    let resolveStarted!: () => void;
    let resolveAborted!: () => void;
    const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
    const aborted = new Promise<void>((resolve) => { resolveAborted = resolve; });
    setSettingsOperationsForTests({
      login: ({ signal }) => new Promise((resolve) => {
        resolveStarted();
        signal.addEventListener("abort", () => {
          resolveAborted();
          release = () => resolve({ ok: false });
        }, { once: true });
      }),
      logout: async () => {},
      probe: async () => ({ ok: true }),
      saveSecret: () => {},
    });
    const runtime = await startLocalRuntime({ home, assetsDir: testAssets() });
    runtimes.push(runtime);
    const launch = await fetch(`${runtime.origin}/_nema/launch?ticket=${runtime.createLaunchTicket()}`, { redirect: "manual" });
    const cookie = launch.headers.get("set-cookie")!.split(";")[0]!;
    const login = await fetch(`${runtime.origin}/_nema/auth/login`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" });
    expect(login.status).toBe(202);
    await started;
    let closeFinished = false;
    const closing = runtime.close().then(() => { closeFinished = true; });
    await aborted;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(closeFinished).toBe(false);
    expect(await discoverInstance(home)).toBeNull();
    release();
    await closing;
    expect(closeFinished).toBe(true);
    runtimes.splice(runtimes.indexOf(runtime), 1);
  }, 60_000);

  it("drains an accepted logout before releasing the runtime lease", async () => {
    const home = join(tempDir("nema-home-"), "logout-drain");
    let release!: () => void;
    let resolveStarted!: () => void;
    let logoutSettled = false;
    const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
    setSettingsOperationsForTests({
      login: async () => ({ ok: true }),
      logout: () => new Promise<void>((resolve) => { resolveStarted(); release = () => { logoutSettled = true; resolve(); }; }),
      probe: async () => ({ ok: true }),
      saveSecret: () => {},
    });
    const runtime = await startLocalRuntime({ home, assetsDir: testAssets() });
    runtimes.push(runtime);
    const launch = await fetch(`${runtime.origin}/_nema/launch?ticket=${runtime.createLaunchTicket()}`, { redirect: "manual" });
    const cookie = launch.headers.get("set-cookie")!.split(";")[0]!;
    const logoutResponse = fetch(`${runtime.origin}/_nema/auth/logout`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ kind: "siwc" }) });
    await started;

    let closeFinished = false;
    const closing = runtime.close().then(() => { closeFinished = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(closeFinished).toBe(false);
      expect(await discoverInstance(home)).toBeNull();
      await expect(acquireInstance(home)).rejects.toMatchObject({ code: "NEMA_LOCAL_OWNER_COLLISION" });
    } finally {
      release();
      await logoutResponse.catch(() => undefined); // Shutdown intentionally closes accepted HTTP sockets.
      await closing;
    }
    expect(closeFinished).toBe(true);
    expect(logoutSettled).toBe(true);
    const afterRelease = await acquireInstance(home);
    await afterRelease.close();
    runtimes.splice(runtimes.indexOf(runtime), 1);
  }, 60_000);

  it("reuses an already-running local runtime through authenticated discovery", async () => {
    const home = join(tempDir("nema-home-"), "single-owner");
    const runtime = await startLocalRuntime({ home, assetsDir: testAssets() });
    runtimes.push(runtime);
    const found = await ensureLocalRuntime({ home, assetsDir: testAssets() });
    expect(found.reused).toBe(true);
    expect(found.origin).toBe(runtime.origin);
    expect(found.launchUrl).toMatch(new RegExp(`^${runtime.origin}/_nema/launch\\?ticket=[0-9a-f]{64}$`));
  });

  it("rolls startup back if the owned Web child exits after its first HTTP response", async () => {
    const home = join(tempDir("nema-home-"), "web-exits-during-startup");
    let webChild: ChildProcess | undefined;
    setRuntimeReadyHookForTests(async ({ webChild: ownedWeb }) => {
      webChild = ownedWeb;
      const exited = new Promise<void>((resolvePromise) => ownedWeb.once("exit", () => resolvePromise()));
      ownedWeb.kill();
      await exited;
    });
    const result = await startLocalRuntime({ home, assetsDir: testAssets() }).then(
      (runtime) => ({ runtime }),
      (error: unknown) => ({ error }),
    );
    if ("runtime" in result) runtimes.push(result.runtime);
    expect("error" in result).toBe(true);
    expect("error" in result && result.error instanceof Error ? result.error.message : "").toMatch(/web process exited/i);
    expect(existsSync(join(home, "instance.json"))).toBe(false);
    const reopened = await createLocalDb(join(home, "db"));
    await reopened.close();
  }, 60_000);

  it("retires discovery and fails the runtime if Web exits after publication", async () => {
    const home = join(tempDir("nema-home-"), "web-exits-after-ready");
    let webChild: ChildProcess | undefined;
    setRuntimeReadyHookForTests(async ({ webChild: ownedWeb }) => { webChild = ownedWeb; });
    const runtime = await startLocalRuntime({ home, assetsDir: testAssets() });
    runtimes.push(runtime);
    const failure = (runtime as typeof runtime & { failure: Promise<Error> }).failure;
    expect(failure).toBeInstanceOf(Promise);
    const exited = new Promise<void>((resolvePromise) => webChild!.once("exit", () => resolvePromise()));
    webChild!.kill();
    await exited;
    const error = await failure;
    expect(error.message).toMatch(/web process exited/i);
    expect(await discoverInstance(home)).toBeNull();
    await expect(runtime.close()).rejects.toThrow(/web process exited/i);
    runtimes.splice(runtimes.indexOf(runtime), 1);
  }, 60_000);

  it("coalesces simultaneous ensure callers onto the single authenticated owner process", async () => {
    const home = join(tempDir("nema-home-"), "concurrent-owner");
    ensuredHomes.push(home);
    const assetsDir = testAssets();
    setEnsureSpawnerForTests(sourceCoreSpawner());
    const starts = await Promise.all([
      ensureLocalRuntime({ home, assetsDir }),
      ensureLocalRuntime({ home, assetsDir }),
    ]);
    expect(starts[0]!.origin).toBe(starts[1]!.origin);
    expect(starts.map((start) => start.reused).sort()).toEqual([false, true]);
    expect(starts.map((start) => new URL(start.launchUrl).pathname)).toEqual(["/_nema/launch", "/_nema/launch"]);
    const later = await ensureLocalRuntime({ home, assetsDir });
    expect(later.reused).toBe(true);
    expect(later.origin).toBe(starts[0]!.origin);
  }, 60_000);

  it("reports an owned-core spawn error promptly instead of a readiness timeout", async () => {
    const home = join(tempDir("nema-home-"), "spawn-error");
    const assetsDir = testAssets();
    setEnsureSpawnerForTests((spec) => spawn(join(spec.cwd, "missing-node.exe"), spec.args, { stdio: ["ignore", "ignore", "ignore", "ipc"] }));
    await expect(ensureLocalRuntime({ home, assetsDir })).rejects.toThrow(/Could not spawn managed local core.*ENOENT/i);
  });

  it("closes its owned launcher and child when post-spawn discovery rejects a malformed descriptor", async () => {
    const home = join(tempDir("nema-home-"), "malformed-after-launch");
    const assetsDir = testAssets();
    const descriptor = join(home, "instance.json");
    let ownedChild: ChildProcess | undefined;
    let childExited = false;
    let ipcClosedBeforeStop = false;
    ensuredHomes.push(home);
    setEnsureSpawnerForTests(() => {
      mkdirSync(home, { recursive: true });
      writeFileSync(descriptor, "not-json", { mode: 0o600 });
      protectPrivatePath(descriptor, 0o600);
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
      });
      ownedChild = child;
      child.once("exit", () => { childExited = true; });
      const killChild = child.kill.bind(child);
      child.kill = ((signal?: NodeJS.Signals) => {
        ipcClosedBeforeStop = !child.connected;
        return killChild(signal);
      }) as typeof child.kill;
      return child;
    });
    await expect(ensureLocalRuntime({ home, assetsDir })).rejects.toThrow(/descriptor|json|malformed/i);
    expect(childExited).toBe(true);
    expect(ownedChild).toBeDefined();
    expect(ownedChild?.exitCode !== null && ownedChild?.exitCode !== undefined || ownedChild?.signalCode !== null && ownedChild?.signalCode !== undefined).toBe(true);
    expect(ownedChild?.connected).toBe(false);
    expect(ipcClosedBeforeStop).toBe(true);
    ensuredHomes.splice(ensuredHomes.indexOf(home), 1);
  });

  it("distinguishes a live control-port owner collision from startup failure", async () => {
    const home = join(tempDir("nema-home-"), "control-collision");
    const assetsDir = testAssets();
    const owner = await acquireInstance(home);
    try {
      setEnsureSpawnerForTests(sourceCoreSpawner());
      setEnsureTimeoutForTests(8_000);
      await expect(ensureLocalRuntime({ home, assetsDir })).rejects.toThrow(/another local core owns the control port/i);
      expect(await discoverInstance(home)).toBeNull();
    } finally { await owner.close(); }
  }, 20_000);

  it("reopens committed data after an owned core process crashes with a running token", async () => {
    const home = join(tempDir("nema-home-"), "forced-core-crash");
    const assetsDir = testAssets();
    const crashed = spawnCrashOwner(home, assetsDir);
    const [seed, ready, webPort] = await Promise.all([crashed.seeded, crashed.ready, crashed.webPort]);
    expect(seed.token).toMatch(/^[0-9a-f]{64}$/);
    expect(ready.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const coreExited = new Promise<void>((resolvePromise) => crashed.child.once("exit", () => resolvePromise()));
    crashed.child.kill(); // Abruptly terminate only the core child created by this test.
    await coreExited;
    const webMarker = join(assetsDir, "fixtures", "web-exited.marker");
    const cleanupResult = await new Promise<{ stopped: true } | { error: NodeJS.ErrnoException }>((resolvePromise) => {
      const request = http.get(`http://127.0.0.1:${webPort}/__test/stop`, (res) => {
        res.resume();
        res.once("end", () => resolvePromise({ stopped: true }));
      });
      request.once("error", (error: NodeJS.ErrnoException) => resolvePromise({ error }));
    });
    if ("error" in cleanupResult) {
      expect(cleanupResult.error.code).toBe("ECONNREFUSED");
    } else {
      const markerDeadline = Date.now() + 2_000;
      while (!existsSync(webMarker) && Date.now() < markerDeadline) await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      expect(existsSync(webMarker)).toBe(true);
      expect(readFileSync(webMarker, "utf8")).toBe("post-crash test cleanup");
    }
    rmSync(webMarker, { force: true });

    const sourceEntry = join(process.cwd(), "apps", "local", "src", "index.ts");
    setEnsureSpawnerForTests(({ args, env }) => {
      const child = spawn(process.execPath, ["--conditions=development", "--import", "tsx", sourceEntry, ...args.slice(1)], {
        cwd: process.cwd(),
        env: { ...env, CODEX_HOME: join(home, "codex-home") },
        stdio: ["pipe", "ignore", "pipe", "ipc"],
        windowsHide: true,
      });
      child.stderr?.resume();
      return child;
    });
    ensuredHomes.push(home);
    const reopenedOwner = await ensureLocalRuntime({ home, assetsDir });
    expect(reopenedOwner.reused).toBe(false);
    expect(reopenedOwner.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await closeEnsuredRuntimesForTests(home);
    ensuredHomes.splice(ensuredHomes.indexOf(home), 1);

    const db = await createLocalDb(join(home, "db"));
    try {
      const task = await getTask(db, seed.taskId);
      expect(task?.status).toBe("queued");
      expect(task?.runToken).toBeNull();
      expect(await resolveRunToken(db, seed.token)).toBeNull();
      const interruptions = await db.query<{ interruptions: number }>("select interruptions from tasks where id = $1", [seed.taskId]);
      expect(interruptions[0]?.interruptions).toBe(1);
      const committed = await db.query<{ content: string }>("select content from messages where content = $1", ["committed running token before forced core exit"]);
      expect(committed).toHaveLength(1);
    } finally { await db.close(); }
  }, 60_000);

  it("rejects a missing or malformed install manifest before acquiring the home", async () => {
    const home = join(tempDir("nema-home-"), "unowned");
    const assets = tempDir("nema-assets-bad-");
    await expect(startLocalRuntime({ home, assetsDir: assets })).rejects.toThrow(/manifest/i);
    expect(existsSync(join(home, "instance.json"))).toBe(false);
    expect(existsSync(join(home, "db"))).toBe(false);
  });

  it("rejects daemon-token permissions before database creation", async () => {
    const home = join(tempDir("nema-home-"), "untrusted-token");
    const dataDir = join(home, "data");
    mkdirSync(dataDir, { recursive: true });
    const tokenFile = join(dataDir, "daemon-token");
    writeFileSync(tokenFile, "a".repeat(64), { mode: 0o644 });
    await expect(startLocalRuntime({ home, assetsDir: testAssets() })).rejects.toThrow(/trusted private file|private Windows ACL/i);
    expect(existsSync(join(home, "db"))).toBe(false);
    expect(await discoverInstance(home)).toBeNull();
  });

  it("rejects malformed daemon-token content after the token file is protected", async () => {
    const home = join(tempDir("nema-home-"), "malformed-token");
    const dataDir = join(home, "data");
    mkdirSync(dataDir, { recursive: true });
    const tokenFile = join(dataDir, "daemon-token");
    writeFileSync(tokenFile, "00", { mode: 0o600 });
    protectPrivatePath(tokenFile);
    await expect(startLocalRuntime({ home, assetsDir: testAssets() })).rejects.toThrow(/malformed/i);
    expect(existsSync(join(home, "db"))).toBe(false);
    expect(await discoverInstance(home)).toBeNull();
  });

  it("rejects a daemon-token directory redirected through a native junction", async () => {
    const parent = tempDir("nema-home-");
    const home = join(parent, "reparse-home");
    mkdirSync(home);
    const outside = join(parent, "outside-data");
    mkdirSync(outside);
    writeFileSync(join(outside, "daemon-token"), "a".repeat(64), { mode: 0o600 });
    protectPrivatePath(join(outside, "daemon-token"));
    symlinkSync(outside, join(home, "data"), "junction");
    await expect(startLocalRuntime({ home, assetsDir: testAssets() })).rejects.toThrow();
    expect(existsSync(join(home, "db"))).toBe(false);
    expect(await discoverInstance(home)).toBeNull();
  });

  it("rejects a database root redirected into another managed home", async () => {
    const parent = tempDir("nema-home-");
    const home = join(parent, "first-home");
    const otherHome = join(parent, "second-home");
    const dbTarget = join(otherHome, "db");
    mkdirSync(home, { recursive: true });
    mkdirSync(dbTarget, { recursive: true });
    writeFileSync(join(dbTarget, "ownership-sentinel"), "untouched");
    symlinkSync(dbTarget, join(home, "db"), "junction");
    await expect(startLocalRuntime({ home, assetsDir: testAssets() })).rejects.toThrow(/real directory/i);
    expect(readFileSync(join(dbTarget, "ownership-sentinel"), "utf8")).toBe("untouched");
    expect(await discoverInstance(home)).toBeNull();
  });

  it("rolls back after a late gateway bind collision and leaves the disk database reusable", async () => {
    const home = join(tempDir("nema-home-"), "late-gateway-failure");
    const assetsDir = testAssets();
    const occupied = net.createServer();
    await new Promise<void>((resolvePromise, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("test port was not allocated");
    try {
      await expect(startLocalRuntime({ home, assetsDir, webPort: address.port })).rejects.toThrow(/EADDRINUSE|address already in use/i);
      expect(await discoverInstance(home)).toBeNull();
      const reopened = await createLocalDb(join(home, "db"));
      await reopened.close();
    } finally {
      await new Promise<void>((resolvePromise) => occupied.close(() => resolvePromise()));
    }
    const recovered = await startLocalRuntime({ home, assetsDir });
    runtimes.push(recovered);
  }, 60_000);

  it("recovers a committed running token on reopen and does not reclaim it during shutdown", async () => {
    const home = join(tempDir("nema-home-"), "crashed-core");
    const assetsDir = testAssets();
    mkdirSync(join(home, "data"), { recursive: true });
    const crashedDb = await createLocalDb(join(home, "db"));
    const workspace = await createWorkspace(crashedDb, join(home, "data"), "crash recovery");
    const posted = await postUserMessage(crashedDb, workspace.id, "committed before core crash");
    const running = await claimNextTask(crashedDb, "crashed-daemon");
    expect(running?.runToken).toMatch(/^[0-9a-f]{64}$/);
    await crashedDb.query("update workspaces set archived_at = now() where id = $1", [workspace.id]);
    const staleToken = running!.runToken!;
    await crashedDb.close();

    const runtime = await startLocalRuntime({ home, assetsDir });
    runtimes.push(runtime);
    await Promise.all([runtime.close(), runtime.close()]);
    runtimes.splice(runtimes.indexOf(runtime), 1);
    expect(await discoverInstance(home)).toBeNull();

    const reopened = await createLocalDb(join(home, "db"));
    try {
      const task = await getTask(reopened, posted.task.id);
      expect(task?.status).toBe("queued");
      expect(task?.runToken).toBeNull();
      expect(await resolveRunToken(reopened, staleToken)).toBeNull();
      const counts = await reopened.query<{ interruptions: number }>("select interruptions from tasks where id = $1", [posted.task.id]);
      expect(counts[0]?.interruptions).toBe(1);
    } finally { await reopened.close(); }
  });
});
