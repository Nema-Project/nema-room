import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { closeSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openPrivateFile, protectPrivatePath } from "@nema/cli/secrets/permissions";
import { acquireInstance, discoverInstance, type InstanceLease } from "../src/instance.js";

const fixture = fileURLToPath(new URL("./fixtures/instance-child.ts", import.meta.url));
const homes: string[] = [];
const children: ChildProcess[] = [];
const leases: InstanceLease[] = [];

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), "nema-local-"));
  homes.push(home);
  return home;
}

async function acquire(home: string): Promise<InstanceLease> {
  const lease = await acquireInstance(home);
  leases.push(lease);
  return lease;
}

function startOwner(home: string): Promise<{ child: ChildProcess; ready: { state: string; home: string; controlOrigin: string } }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--conditions=development", "--import", "tsx", fixture], {
      env: { ...process.env, NEMA_TEST_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    children.push(child);
    let output = "";
    let errors = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { errors += chunk; });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
      const lineEnd = output.indexOf("\n");
      if (lineEnd < 0) return;
      const line = output.slice(0, lineEnd).trim();
      if (line === "owner-error") reject(new Error(`owner failed to acquire: ${errors}`));
      else {
        try { resolvePromise({ child, ready: JSON.parse(line) as { state: string; home: string; controlOrigin: string } }); }
        catch (error) { reject(new Error(`invalid child readiness: ${String(error)} ${errors}`)); }
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!output.includes("\n")) reject(new Error(`owner exited before readiness (${code}): ${errors}`));
    });
  });
}

async function closeChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const waitForExit = (timeoutMs: number): Promise<boolean> => new Promise((resolvePromise) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolvePromise(true);
    const timer = setTimeout(() => { child.off("exit", exited); resolvePromise(false); }, timeoutMs);
    const exited = () => { clearTimeout(timer); resolvePromise(true); };
    child.once("exit", exited);
  });
  if (!child.killed && child.stdin?.writable) {
    child.stdin.on("error", () => undefined);
    child.stdin.write("close\n");
  }
  if (await waitForExit(1000)) return;
  if (!child.killed) child.kill();
  if (await waitForExit(1000)) return;
  throw new Error(`test-owned child ${child.pid ?? "unknown"} did not exit after cleanup`);
}

function descriptorPath(home: string): string { return join(home, "instance.json"); }
function readDescriptor(home: string): Record<string, unknown> {
  const fd = openPrivateFile(descriptorPath(home));
  try { return JSON.parse(readFileSync(fd, "utf8")) as Record<string, unknown>; }
  finally { closeSync(fd); }
}

function rawRequest(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: "/_nema/launch", method: "POST", headers }, (response) => {
      response.resume();
      response.once("end", () => resolvePromise(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end("{}");
  });
}

function rawGet(port: number, path: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}` } }, (response) => {
      response.resume();
      response.once("end", () => resolvePromise(response.statusCode ?? 0));
    });
    request.once("error", reject);
  });
}

function rawTarget(port: number, target: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`));
    socket.on("data", (chunk: string) => { response += chunk; });
    socket.once("end", () => resolvePromise(response));
    socket.once("error", reject);
  });
}

function addressForHome(home: string): { homeHash: string; port: number } {
  const canonicalPath = realpathSync.native(home);
  const identity = process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath;
  const digest = createHash("sha256").update(identity).digest();
  return { homeHash: digest.toString("hex"), port: 20000 + digest.readUInt32BE(0) % 25000 };
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(closeChild));
  await Promise.all(leases.splice(0).map((lease) => lease.close()));
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("local instance ownership and discovery", () => {
  it("allows exactly one kernel owner for two concurrent acquisitions", async () => {
    const home = newHome();
    const attempts = await Promise.allSettled([startOwner(home), startOwner(home)]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("authenticates the current owner before returning its launch URL", async () => {
    const home = newHome();
    const { child, ready } = await startOwner(home);
    const found = await discoverInstance(home);
    expect(found).toEqual({ origin: "http://127.0.0.1:4173", launchUrl: "http://127.0.0.1:4173/_nema/launch", instanceId: expect.any(String) });
    expect(ready.state).toBe("ready");
    expect(child.exitCode).toBeNull();
    expect(JSON.stringify(found)).not.toContain(String(readDescriptor(home).secret));
  });

  it("releases ownership after a forced process crash", async () => {
    const home = newHome();
    const first = await startOwner(home);
    first.child.kill("SIGKILL");
    await new Promise<void>((resolvePromise) => first.child.once("exit", () => resolvePromise()));
    const second = await startOwner(home);
    expect(second.ready.state).toBe("ready");
  });

  it("ignores stale metadata and never kills a process named by its pid", async () => {
    const home = newHome();
    const unrelated = spawn(process.execPath, ["-e", "process.stdout.write('ready\\n'); process.stdin.resume()"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    children.push(unrelated);
    await new Promise<void>((resolvePromise, reject) => {
      unrelated.stdout!.once("data", () => resolvePromise());
      unrelated.once("error", reject);
    });
    const canonicalPath = resolve(home);
    const canonical = process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath;
    const crypto = await import("node:crypto");
    const homeHash = crypto.createHash("sha256").update(canonical).digest("hex");
    const port = 20000 + crypto.createHash("sha256").update(canonical).digest().readUInt32BE(0) % 25000;
    writeFileSync(descriptorPath(home), JSON.stringify({ schemaVersion: 1, protocol: "nema-local-v1", homeHash, instanceId: randomUUID(), pid: unrelated.pid, controlOrigin: `http://127.0.0.1:${port}`, origin: "http://127.0.0.1:4173", secret: randomBytes(32).toString("hex") }), { mode: 0o600 });
    protectPrivatePath(descriptorPath(home));
    expect(await discoverInstance(home)).toBeNull();
    expect(unrelated.exitCode).toBeNull();
    unrelated.kill();
  });

  it("returns 400 for a malformed request target and keeps the owner alive", async () => {
    const home = newHome();
    const { child, ready } = await startOwner(home);
    const port = Number(new URL(ready.controlOrigin).port);
    const response = await rawTarget(port, "//[").catch(() => "");
    expect(response.split("\r\n", 1)[0]).toMatch(/^HTTP\/1\.1 400\b/);
    expect(child.exitCode).toBeNull();
    expect(await discoverInstance(home)).not.toBeNull();
  });

  it("rejects an impostor listener proof before sending the descriptor secret", async () => {
    const home = newHome();
    const { homeHash, port } = addressForHome(home);
    const controlOrigin = `http://127.0.0.1:${port}`;
    const origin = "http://127.0.0.1:4173";
    const instanceId = randomUUID();
    const secret = randomBytes(32).toString("hex");
    writeFileSync(descriptorPath(home), JSON.stringify({ schemaVersion: 1, protocol: "nema-local-v1", homeHash, instanceId, pid: process.pid, controlOrigin, origin, secret }), { mode: 0o600 });
    protectPrivatePath(descriptorPath(home));
    let launchRequests = 0;
    let authorization: string | undefined;
    const impostor = http.createServer((req, res) => {
      if (req.method === "GET" && req.url?.startsWith("/_nema/instance?challenge=")) {
        const challenge = new URL(req.url, controlOrigin).searchParams.get("challenge");
        const body = JSON.stringify({ protocol: "nema-local-v1", homeHash, instanceId, controlOrigin, origin, challenge, proof: "0".repeat(64) });
        res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
        res.end(body);
      } else {
        launchRequests += 1;
        authorization = req.headers.authorization;
        res.writeHead(401);
        res.end();
      }
    });
    await new Promise<void>((resolvePromise, reject) => {
      impostor.once("error", reject);
      impostor.listen(port, "127.0.0.1", resolvePromise);
    });
    try {
      await expect(discoverInstance(home)).rejects.toThrow(/proof is invalid/i);
      expect(launchRequests).toBe(0);
      expect(authorization).toBeUndefined();
    } finally {
      await new Promise<void>((resolvePromise) => impostor.close(() => resolvePromise()));
    }
  });

  it("rejects forged descriptor origin, control address, home identity, and proof", async () => {
    const home = newHome();
    await startOwner(home);
    const original = readDescriptor(home);
    for (const field of ["origin", "controlOrigin", "homeHash", "protocol", "instanceId", "secret"] as const) {
      const tampered = { ...original, [field]: field === "secret" ? randomBytes(32).toString("hex") : "http://evil.example" };
      if (field === "homeHash" || field === "protocol") tampered[field] = "forged";
      writeFileSync(descriptorPath(home), JSON.stringify(tampered), { mode: 0o600 });
      protectPrivatePath(descriptorPath(home));
      await expect(discoverInstance(home)).rejects.toThrow();
      writeFileSync(descriptorPath(home), JSON.stringify(original), { mode: 0o600 });
      protectPrivatePath(descriptorPath(home));
    }
  });

  it("refuses unauthenticated launch and hostile Host or Origin headers", async () => {
    const home = newHome();
    const { ready } = await startOwner(home);
    const port = Number(new URL(ready.controlOrigin).port);
    const descriptor = readDescriptor(home);
    const cases: Array<Record<string, string>> = [
      { "content-type": "application/json" },
      { "content-type": "application/json", authorization: `Bearer ${descriptor.secret}`, origin: "http://evil.example" },
      { "content-type": "application/json", authorization: `Bearer ${descriptor.secret}`, host: "evil.example" },
    ];
    for (const headers of cases) {
      expect(await rawRequest(port, headers)).toBeGreaterThanOrEqual(400);
    }
  });

  it("calls the launch callback only after an authenticated launch request", async () => {
    const home = newHome();
    const lease = await acquire(home);
    let calls = 0;
    await lease.publish({ origin: "http://127.0.0.1:4173", createLaunchUrl: () => { calls += 1; return "http://127.0.0.1:4173/_nema/launch"; } });
    expect(calls).toBe(0);
    const port = Number(new URL(lease.controlOrigin).port);
    const status = await rawRequest(port, { "content-type": "application/json", authorization: "Bearer 00" });
    expect(status).toBe(401);
    expect(calls).toBe(0);
    expect(await discoverInstance(home)).not.toBeNull();
    expect(calls).toBe(1);
    await lease.close();
  });

  it("does not issue a launch when the lease closes during request body collection", async () => {
    const home = newHome();
    const lease = await acquire(home);
    let calls = 0;
    await lease.publish({ origin: "http://127.0.0.1:4173", createLaunchUrl: () => { calls += 1; return "http://127.0.0.1:4173/_nema/launch"; } });
    const secret = String(readDescriptor(home).secret);
    const port = Number(new URL(lease.controlOrigin).port);
    let request!: http.ClientRequest;
    const response = new Promise<number>((resolvePromise, reject) => {
      request = http.request({
        host: "127.0.0.1", port, path: "/_nema/launch", method: "POST",
        headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${secret}`, "content-type": "application/json", "content-length": "4" },
      }, (res) => {
        res.resume();
        res.once("end", () => resolvePromise(res.statusCode ?? 0));
      });
      request.once("error", reject);
    });
    void response.catch(() => undefined);
    const connected = new Promise<void>((resolvePromise, reject) => {
      request.once("socket", (socket) => {
        if (socket.connecting) socket.once("connect", resolvePromise);
        else resolvePromise();
      });
      request.once("error", reject);
    });
    request.write("{");
    await connected;
    const closing = lease.close();
    const closedPromptly = await Promise.race([
      closing.then(() => true),
      new Promise<boolean>((resolvePromise) => setTimeout(() => resolvePromise(false), 1000)),
    ]);
    if (!closedPromptly) request.end("}");
    await closing;
    await response.catch(() => undefined);
    expect(closedPromptly).toBe(true);
    expect(calls).toBe(0);
  });

  it("rejects a callback URL that escapes the published UI origin", async () => {
    const home = newHome();
    const lease = await acquire(home);
    await lease.publish({ origin: "http://127.0.0.1:4173", createLaunchUrl: () => "https://evil.example/_nema/launch" });
    await expect(discoverInstance(home)).rejects.toThrow();
    await lease.close();
  });

  it("keeps the descriptor private and removes it only for the matching lease", async () => {
    const home = newHome();
    mkdirSync(home, { recursive: true });
    const lease = await acquire(home);
    await lease.publish({ origin: "http://127.0.0.1:4173", createLaunchUrl: () => "http://127.0.0.1:4173/_nema/launch" });
    const file = descriptorPath(home);
    const before = readDescriptor(home);
    if (process.platform !== "win32") expect((await import("node:fs")).statSync(file).mode & 0o777).toBe(0o600);
    const privateFd = openPrivateFile(file);
    closeSync(privateFd);
    writeFileSync(file, JSON.stringify({ ...before, instanceId: randomUUID() }), { mode: 0o600 });
    protectPrivatePath(file);
    await lease.close();
    expect(readFileSync(file, "utf8")).toContain("instanceId");
    await expect(lease.close()).resolves.toBeUndefined();
  });

  it("refuses a descriptor replaced by a reparse point", async () => {
    const home = newHome();
    await startOwner(home);
    rmSync(descriptorPath(home));
    symlinkSync(home, descriptorPath(home), "junction");
    await expect(discoverInstance(home)).rejects.toThrow(/trusted private file/i);
  });

  it("does not let a home symlink alias acquire the same kernel lease", async () => {
    const parent = newHome();
    const home = join(parent, "canonical");
    mkdirSync(home);
    const alias = join(parent, "alias");
    try { (await import("node:fs")).symlinkSync(home, alias, "junction"); }
    catch (error) { throw new Error(`native directory junction creation failed: ${String(error)}`); }
    const first = await startOwner(home);
    await expect(startOwner(alias)).rejects.toThrow();
    const actualHome = process.platform === "win32" ? first.ready.home.toLowerCase() : first.ready.home;
    const expectedHome = process.platform === "win32" ? home.toLowerCase() : home;
    expect(actualHome).toBe(expectedHome);
  });

  it("does not publish readiness until publish is called and close is idempotent", async () => {
    const home = newHome();
    const lease = await acquire(home);
    expect(await discoverInstance(home)).toBeNull();
    const challenge = randomBytes(32).toString("hex");
    expect(await rawGet(Number(new URL(lease.controlOrigin).port), `/_nema/instance?challenge=${challenge}`)).toBe(503);
    await lease.publish({ origin: "http://127.0.0.1:4173", createLaunchUrl: () => "http://127.0.0.1:4173/_nema/launch" });
    await expect(lease.close()).resolves.toBeUndefined();
    await expect(lease.close()).resolves.toBeUndefined();
    expect(await discoverInstance(home)).toBeNull();
  });
});
