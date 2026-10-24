import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { openPrivateFile, privateModeMatches, protectPrivatePath } from "@nema/cli/secrets/permissions";
import { homeIdentity, resolveHome } from "./paths.js";

const PROTOCOL = "nema-local-v1";
const MAX_BODY = 4096;
const REQUEST_TIMEOUT_MS = 1800;

interface Descriptor {
  schemaVersion: 1;
  protocol: typeof PROTOCOL;
  homeHash: string;
  instanceId: string;
  pid: number;
  controlOrigin: string;
  origin: string;
  secret: string;
}

interface Published {
  origin: string;
  createLaunchUrl: () => string;
}

export interface InstanceLease {
  readonly home: string;
  readonly controlOrigin: string;
  publish(value: Published): Promise<void>;
  unpublish(): Promise<void>;
  close(): Promise<void>;
}

export interface DiscoveredInstance {
  origin: string;
  launchUrl: string;
  instanceId: string;
}

const sha256 = (value: string): Buffer => createHash("sha256").update(value).digest();
const homeHashFor = (identity: string): string => sha256(identity).toString("hex");
const controlPortFor = (identity: string): number => 20000 + sha256(identity).readUInt32BE(0) % 25000;
const controlOriginFor = (port: number): string => `http://127.0.0.1:${port}`;
const jsonHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...jsonHeaders, "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function isLoopbackOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      url.origin === value;
  } catch { return false; }
}

function validLaunchUrl(value: string, origin: string): boolean {
  try {
    const url = new URL(value);
    return isLoopbackOrigin(origin) && url.origin === origin && url.pathname === "/_nema/launch" && !url.hash;
  } catch { return false; }
}

function hmac(secret: string, tuple: unknown[]): Buffer {
  return createHmac("sha256", Buffer.from(secret, "hex")).update(JSON.stringify(tuple)).digest();
}

function equalHex(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(left) || !/^[0-9a-f]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function readDescriptor(file: string): Descriptor | null {
  let fd: number;
  try { fd = openPrivateFile(file); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    let entryMissing = false;
    try { lstatSync(file); } catch (statError) { entryMissing = (statError as NodeJS.ErrnoException).code === "ENOENT"; }
    if (code === "ENOENT" || entryMissing) return null;
    throw new Error(`Instance descriptor is not a trusted private file (${code ?? "private-file validation failed"})`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || !privateModeMatches(stat) || stat.size > 16_384) throw new Error("Instance descriptor is invalid");
    const raw: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Instance descriptor is invalid");
    const value = raw as Partial<Descriptor>;
    if (value.schemaVersion !== 1 || value.protocol !== PROTOCOL ||
      typeof value.homeHash !== "string" || !/^[0-9a-f]{64}$/.test(value.homeHash) ||
      typeof value.instanceId !== "string" || !/^[0-9a-f-]{36}$/i.test(value.instanceId) ||
      !Number.isSafeInteger(value.pid) || (value.pid ?? 0) < 1 ||
      typeof value.controlOrigin !== "string" || typeof value.origin !== "string" ||
      typeof value.secret !== "string" || !/^[0-9a-f]{64}$/.test(value.secret)) throw new Error("Instance descriptor is invalid");
    return value as Descriptor;
  } catch {
    throw new Error("Instance descriptor is invalid or malformed");
  } finally { closeSync(fd); }
}

function atomicWriteDescriptor(file: string, descriptor: Descriptor): void {
  try {
    if (lstatSync(file).isSymbolicLink()) throw new Error("Refusing symbolic link descriptor");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    protectPrivatePath(temp, 0o600);
    const text = JSON.stringify(descriptor);
    writeSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    renameSync(temp, file);
  } catch (error) {
    try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(temp); } catch { /* best effort */ }
    throw error;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function readJsonResponse(res: IncomingMessage): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    res.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error("Control response too large")); res.destroy(); }
      else chunks.push(chunk);
    });
    res.on("end", () => {
      try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
      catch { reject(new Error("Invalid control response")); }
    });
    res.on("error", reject);
  });
}

function requestControl(port: number, path: string, method = "GET", headers: Record<string, string> = {}, body?: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => { void readJsonResponse(res).then(resolve, reject); });
    req.on("timeout", () => {
      const error = Object.assign(new Error("Control request timed out"), { code: "NEMA_LOCAL_CONTROL_TIMEOUT" });
      req.destroy();
      reject(error);
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function removeDescriptorIfOwner(file: string, instanceId: string): void {
  let fd: number;
  try { fd = openPrivateFile(file); }
  catch { return; }
  let owns = false;
  try {
    const raw: unknown = JSON.parse(readFileSync(fd, "utf8"));
    owns = Boolean(raw && typeof raw === "object" && (raw as { instanceId?: unknown }).instanceId === instanceId);
  } catch { /* a damaged descriptor is left for discovery to reject */ }
  finally { closeSync(fd); }
  if (owns) try { unlinkSync(file); } catch { /* another owner or OS lock won the race */ }
}

export async function acquireInstance(home?: string): Promise<InstanceLease> {
  const paths = resolveHome(home);
  const identity = homeIdentity(paths.home);
  const homeHash = homeHashFor(identity);
  const port = controlPortFor(identity);
  const controlOrigin = controlOriginFor(port);
  const instanceId = randomUUID();
  const descriptorSecret = randomBytes(32).toString("hex");
  let published: Published | undefined;
  let closing = false;
  let retired = false;
  let unpublishPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  const server = http.createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    if (req.headers.host !== `127.0.0.1:${port}` || req.headers.origin !== undefined) return send(res, 400, { error: "invalid request" });
    let url: URL;
    try { url = new URL(req.url ?? "/", controlOrigin); }
    catch { return send(res, 400, { error: "invalid request" }); }
    if (req.method === "GET" && url.pathname === "/_nema/instance") {
      const challenge = url.searchParams.get("challenge") ?? "";
      if (!/^[0-9a-f]{64}$/.test(challenge)) return send(res, 400, { error: "invalid request" });
      if (!published || closing) return send(res, 503, { error: "not ready" });
      const tuple = [PROTOCOL, homeHash, instanceId, controlOrigin, published.origin, challenge];
      return send(res, 200, { protocol: PROTOCOL, homeHash, instanceId, controlOrigin, origin: published.origin, challenge, proof: hmac(descriptorSecret, tuple).toString("hex") });
    }
    if (req.method === "POST" && url.pathname === "/_nema/launch") {
      if (!published || closing) return send(res, 503, { error: "not ready" });
      const authorization = req.headers.authorization ?? "";
      const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      if (!equalHex(supplied, descriptorSecret)) return send(res, 401, { error: "unauthorized" });
      if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") return send(res, 415, { error: "invalid content type" });
      try {
        const body = await readBody(req);
        if (!published || closing) return send(res, 503, { error: "not ready" });
        const parsed: unknown = JSON.parse(body);
        if (body.length > MAX_BODY || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) return send(res, 400, { error: "invalid request" });
      } catch { return send(res, 400, { error: "invalid request" }); }
      try {
        const launchUrl = published.createLaunchUrl();
        if (typeof launchUrl !== "string" || !validLaunchUrl(launchUrl, published.origin)) return send(res, 500, { error: "invalid launch target" });
        return send(res, 200, { origin: published.origin, launchUrl, instanceId });
      } catch { return send(res, 500, { error: "launch unavailable" }); }
    }
    return send(res, 404, { error: "not found" });
  });
  server.on("error", () => {});
  server.listen(port, "127.0.0.1");
  try { await once(server, "listening"); }
  catch (error) {
    try { server.close(); } catch { /* not listening */ }
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      const error = new Error(`Local instance control port collision at ${controlOrigin}; refusing a fallback port`);
      Object.assign(error, { code: "NEMA_LOCAL_OWNER_COLLISION" });
      throw error;
    }
    throw error;
  }

  try {
    // A successful exclusive bind proves any prior descriptor's listener is gone. Clear only a
    // structurally valid descriptor for this home/control endpoint so Windows can atomically publish.
    const stale = readDescriptor(paths.instance);
    if (stale) {
      validateDescriptor(stale, homeHash, controlOrigin);
      removeDescriptorIfOwner(paths.instance, stale.instanceId);
    }
  } catch (error) {
    server.close();
    server.closeAllConnections();
    await once(server, "close");
    throw error;
  }

  return {
    home: paths.home,
    controlOrigin,
    async publish(value) {
      if (closing) throw new Error("Instance lease is closing");
      if (retired) throw new Error("Instance lease readiness has been retired");
      if (published) throw new Error("Instance lease is already published");
      if (!isLoopbackOrigin(value.origin)) throw new Error("UI origin must be a local HTTP origin");
      published = value;
      try {
        atomicWriteDescriptor(paths.instance, { schemaVersion: 1, protocol: PROTOCOL, homeHash, instanceId, pid: process.pid, controlOrigin, origin: value.origin, secret: descriptorSecret });
      } catch (error) { published = undefined; throw error; }
    },
    unpublish() {
      if (unpublishPromise) return unpublishPromise;
      retired = true;
      published = undefined;
      unpublishPromise = Promise.resolve().then(() => removeDescriptorIfOwner(paths.instance, instanceId));
      return unpublishPromise;
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      retired = true;
      published = undefined;
      closePromise = (async () => {
        removeDescriptorIfOwner(paths.instance, instanceId);
        if (server.listening) {
          server.close();
          server.closeAllConnections();
          await once(server, "close");
        }
      })();
      return closePromise;
    },
  };
}

function validateDescriptor(value: Descriptor, homeHash: string, controlOrigin: string): void {
  if (value.homeHash !== homeHash || value.controlOrigin !== controlOrigin || !isLoopbackOrigin(value.origin)) {
    throw new Error("Instance descriptor does not match the requested home or local control address");
  }
}

export async function discoverInstance(home?: string): Promise<DiscoveredInstance | null> {
  const paths = resolveHome(home);
  const identity = homeIdentity(paths.home);
  const homeHash = homeHashFor(identity);
  const port = controlPortFor(identity);
  const controlOrigin = controlOriginFor(port);
  const descriptor = readDescriptor(paths.instance);
  if (!descriptor) return null;
  validateDescriptor(descriptor, homeHash, controlOrigin);
  const challenge = randomBytes(32).toString("hex");
  let proofResponse: { status: number; body: unknown };
  try { proofResponse = await requestControl(port, `/_nema/instance?challenge=${challenge}`); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ECONNREFUSED") return null;
    throw error;
  }
  // A newly acquired owner may still be starting behind an old, valid descriptor from a crash.
  // Its control listener answers 503 until publish; no launch data is accepted during this window.
  if (proofResponse.status === 503) return null;
  if (proofResponse.status !== 200 || !proofResponse.body || typeof proofResponse.body !== "object") throw new Error("Local instance proof was rejected");
  const proof = proofResponse.body as Record<string, unknown>;
  if (proof.protocol !== PROTOCOL || proof.homeHash !== homeHash || proof.instanceId !== descriptor.instanceId ||
    proof.controlOrigin !== controlOrigin || proof.origin !== descriptor.origin || proof.challenge !== challenge || typeof proof.proof !== "string") {
    throw new Error("Local instance identity proof does not match its descriptor");
  }
  const expectedProof = hmac(descriptor.secret, [PROTOCOL, homeHash, descriptor.instanceId, controlOrigin, descriptor.origin, challenge]).toString("hex");
  if (!equalHex(proof.proof, expectedProof)) throw new Error("Local instance proof is invalid");
  const launchResponse = await requestControl(port, "/_nema/launch", "POST", {
    authorization: `Bearer ${descriptor.secret}`,
    "content-type": "application/json",
    "content-length": "2",
  }, "{}");
  if (launchResponse.status !== 200 || !launchResponse.body || typeof launchResponse.body !== "object") throw new Error("Authenticated local launch request failed");
  const launch = launchResponse.body as Record<string, unknown>;
  if (launch.origin !== descriptor.origin || launch.instanceId !== descriptor.instanceId || typeof launch.launchUrl !== "string" || !validLaunchUrl(launch.launchUrl, descriptor.origin)) {
    throw new Error("Authenticated local launch response is invalid");
  }
  return { origin: descriptor.origin, launchUrl: launch.launchUrl, instanceId: descriptor.instanceId };
}
