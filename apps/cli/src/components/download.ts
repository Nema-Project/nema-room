// Downloads for the component installer. Node's fetch ignores proxy variables, so this speaks HTTP
// itself: an HTTP proxy gets absolute-form requests for http:// URLs and a CONNECT tunnel for https://.
// Integrity is not decided here; the caller compares the returned sha256 and size with the lock.
import { createHash } from "node:crypto";
import { createWriteStream, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import tls from "node:tls";
import { ComponentInstallError } from "./types.js";
import type { LockFile, LockTarget } from "./lock.js";

export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000];
export const IDLE_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;

const PYTHON_SOURCE = /^https:\/\/github\.com\/astral-sh\/python-build-standalone\/releases\/download\//;
const PYPI_FILES = /^https:\/\/files\.pythonhosted\.org(?=\/)/;

function mirrorBase(raw: string, name: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ComponentInstallError("network", `${name} is not a URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ComponentInstallError("network", `${name} must be an http(s) URL`);
  return raw.replace(/\/+$/, "");
}

/**
 * Where one lock entry is fetched from. `NEMA_GRAPHIFY_PYTHON_MIRROR` stands in for
 * `https://github.com/astral-sh/python-build-standalone/releases/download`, `NEMA_GRAPHIFY_PYPI_BASE` for
 * `https://files.pythonhosted.org`; the rest of the path is kept. Only the address changes: the bytes are
 * still checked against the lock.
 */
export function sourceUrl(entry: LockFile, kind: "python" | "wheel", env: NodeJS.ProcessEnv): string {
  if (kind === "python") {
    const mirror = env.NEMA_GRAPHIFY_PYTHON_MIRROR;
    if (!mirror) return entry.url;
    if (!PYTHON_SOURCE.test(entry.url)) throw new ComponentInstallError("network", `Cannot mirror ${entry.url}`);
    return `${mirrorBase(mirror, "NEMA_GRAPHIFY_PYTHON_MIRROR")}/${entry.url.replace(PYTHON_SOURCE, "")}`;
  }
  const base = env.NEMA_GRAPHIFY_PYPI_BASE;
  if (!base) return entry.url;
  if (!PYPI_FILES.test(entry.url)) throw new ComponentInstallError("network", `Cannot mirror ${entry.url}`);
  return entry.url.replace(PYPI_FILES, mirrorBase(base, "NEMA_GRAPHIFY_PYPI_BASE"));
}

/** Every URL an install of `target` would contact first, in lock order. */
export function sourceUrls(target: LockTarget, env: NodeJS.ProcessEnv): string[] {
  return [sourceUrl(target.python, "python", env), ...target.wheels.map((wheel) => sourceUrl(wheel, "wheel", env))];
}

const pick = (env: NodeJS.ProcessEnv, ...names: string[]): string | undefined => {
  for (const name of names) {
    const value = env[name];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
};

/** NO_PROXY: `*`, or comma/space separated hosts, `.suffix` or `suffix` domain matches, optional `:port`. */
export function bypassesProxy(url: URL, env: NodeJS.ProcessEnv): boolean {
  const raw = pick(env, "NO_PROXY", "no_proxy");
  if (!raw) return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  for (const item of raw.split(/[\s,]+/)) {
    if (!item) continue;
    if (item === "*") return true;
    let entry = item.toLowerCase();
    let entryPort: string | undefined;
    const bracketed = /^\[(.+)\](?::(\d+))?$/.exec(entry);
    if (bracketed) {
      entry = bracketed[1]!;
      entryPort = bracketed[2];
    } else if (/^[^:]+:\d+$/.test(entry)) {
      entryPort = entry.slice(entry.indexOf(":") + 1);
      entry = entry.slice(0, entry.indexOf(":"));
    }
    entry = entry.replace(/^\*?\./, ".");
    if (entryPort && entryPort !== port) continue;
    if (entry.startsWith(".") ? host === entry.slice(1) || host.endsWith(entry) : host === entry || host.endsWith(`.${entry}`)) return true;
  }
  return false;
}

/** The proxy for `url`: HTTPS_PROXY for https, HTTP_PROXY for http (upper case first), unless NO_PROXY matches. */
export function proxyFor(url: URL, env: NodeJS.ProcessEnv): URL | null {
  const raw = url.protocol === "https:" ? pick(env, "HTTPS_PROXY", "https_proxy") : pick(env, "HTTP_PROXY", "http_proxy");
  if (!raw || bypassesProxy(url, env)) return null;
  let proxy: URL;
  try {
    proxy = new URL(raw.includes("://") ? raw : `http://${raw}`);
  } catch {
    throw new ComponentInstallError("proxy", `Proxy setting is not a URL: ${raw}`);
  }
  if (proxy.protocol !== "http:") throw new ComponentInstallError("proxy", `Only http:// proxies are supported, got ${proxy.protocol}`);
  return proxy;
}

/**
 * Extra roots for TLS: SSL_CERT_FILE and NODE_EXTRA_CA_CERTS from the given environment, on top of Node's
 * bundled roots. Undefined keeps Node's default store (which already holds NODE_EXTRA_CA_CERTS read at start).
 */
export function caBundle(env: NodeJS.ProcessEnv): string[] | undefined {
  const files = [pick(env, "SSL_CERT_FILE"), pick(env, "NODE_EXTRA_CA_CERTS")].filter((file): file is string => !!file);
  if (files.length === 0) return undefined;
  const extra = files.map((file) => {
    try {
      return readFileSync(file, "utf8");
    } catch (error) {
      throw new ComponentInstallError("network", `Cannot read CA bundle ${file}: ${(error as Error).message}`);
    }
  });
  return [...tls.rootCertificates, ...extra];
}

function proxyAuth(proxy: URL): Record<string, string> {
  if (!proxy.username && !proxy.password) return {};
  const token = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64");
  return { "proxy-authorization": `Basic ${token}` };
}

export type DownloadOptions = {
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Idle socket timeout per request. */
  timeoutMs?: number;
  /** Called with each chunk's length as it arrives. */
  onBytes?: (bytes: number) => void;
  /** Stop reading once the body passes this many bytes: it cannot match the lock anyway. */
  maxBytes?: number;
};

function abortError(): Error {
  const error = new Error("Download cancelled");
  error.name = "AbortError";
  return error;
}

/** A tunnel through `proxy` to `target`'s host, resolved once the proxy answers 200. */
function connectTunnel(proxy: URL, target: URL, o: DownloadOptions): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const authority = `${target.hostname}:${target.port || 443}`;
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port || 80),
      method: "CONNECT",
      path: authority,
      headers: { host: authority, ...proxyAuth(proxy) },
      signal: o.signal,
    });
    req.setTimeout(o.timeoutMs ?? IDLE_TIMEOUT_MS, () => req.destroy(new ComponentInstallError("proxy", `Proxy ${proxy.host} did not answer`)));
    req.once("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new ComponentInstallError("proxy", `Proxy ${proxy.host} refused the tunnel to ${authority} (${res.statusCode})`));
        return;
      }
      resolve(socket as Socket);
    });
    req.once("error", (error) => {
      if (o.signal?.aborted) reject(abortError());
      else reject(error instanceof ComponentInstallError ? error : new ComponentInstallError("proxy", `Proxy ${proxy.host} unreachable: ${error.message}`));
    });
    req.end();
  });
}

/** One GET, no redirects followed. Rejects with a ComponentInstallError naming network or proxy. */
async function get(url: URL, o: DownloadOptions): Promise<IncomingMessage> {
  const proxy = proxyFor(url, o.env);
  const ca = url.protocol === "https:" ? caBundle(o.env) : undefined;
  const headers = { "user-agent": "nema-component-installer", accept: "*/*" };
  let tunnel: Socket | undefined;
  if (proxy && url.protocol === "https:") tunnel = await connectTunnel(proxy, url, o);
  return new Promise((resolve, reject) => {
    let req: http.ClientRequest;
    if (tunnel) {
      const socket = tunnel;
      req = https.request(url, {
        headers,
        signal: o.signal,
        createConnection: () => tls.connect({ socket, servername: url.hostname, ...(ca ? { ca } : {}) }),
      });
    } else if (proxy) {
      req = http.request({
        host: proxy.hostname,
        port: Number(proxy.port || 80),
        method: "GET",
        path: url.href,
        headers: { ...headers, host: url.host, ...proxyAuth(proxy) },
        signal: o.signal,
      });
    } else {
      req = (url.protocol === "https:" ? https : http).request(url, { headers, signal: o.signal, ...(ca ? { ca } : {}) });
    }
    req.setTimeout(o.timeoutMs ?? IDLE_TIMEOUT_MS, () => req.destroy(new ComponentInstallError("network", `No data from ${url.host} for ${Math.round((o.timeoutMs ?? IDLE_TIMEOUT_MS) / 1000)}s`)));
    req.once("response", (res) => {
      if (proxy && !tunnel && res.statusCode === 407) {
        res.resume();
        reject(new ComponentInstallError("proxy", `Proxy ${proxy.host} requires authentication (407)`));
        return;
      }
      resolve(res);
    });
    req.once("error", (error) => {
      if (o.signal?.aborted) reject(abortError());
      else if (error instanceof ComponentInstallError) reject(error);
      else if (proxy && !tunnel) reject(new ComponentInstallError("proxy", `Proxy ${proxy.host} unreachable: ${error.message}`));
      else reject(new ComponentInstallError("network", `${url.host}: ${error.message}`));
    });
    req.end();
  });
}

export class HttpStatusError extends ComponentInstallError {
  constructor(readonly status: number, url: URL) {
    super("network", `${url.host} answered ${status} for ${url.pathname.split("/").pop() ?? url.pathname}`);
  }
}

/**
 * Stream one URL into `dest`, following redirects. Returns the sha256 and length of what was written.
 * A partial file is removed on any failure.
 */
export async function downloadOnce(rawUrl: string, dest: string, o: DownloadOptions): Promise<{ sha256: string; size: number }> {
  let url = new URL(rawUrl);
  for (let hop = 0; ; hop++) {
    if (o.signal?.aborted) throw abortError();
    const res = await get(url, o);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      if (hop >= MAX_REDIRECTS) throw new ComponentInstallError("network", `Too many redirects from ${rawUrl}`);
      url = new URL(res.headers.location, url);
      continue;
    }
    if (status !== 200) {
      res.resume();
      throw new HttpStatusError(status, url);
    }
    const hash = createHash("sha256");
    let size = 0;
    const out = createWriteStream(dest, { flags: "wx" });
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          // Settle before destroying: destroying the response can synchronously
          // raise its own error/aborted events, and the first error must win so
          // a hash-mismatch is not reclassified as a network failure.
          reject(error);
          res.destroy();
          out.destroy();
        };
        res.on("data", (chunk: Buffer) => {
          if (settled) return;
          size += chunk.length;
          if (o.maxBytes !== undefined && size > o.maxBytes) {
            fail(new ComponentInstallError("hash-mismatch", `${url.pathname.split("/").pop()} is larger than the lock's size`));
            return;
          }
          hash.update(chunk);
          o.onBytes?.(chunk.length);
          if (!out.write(chunk)) {
            res.pause();
            out.once("drain", () => res.resume());
          }
        });
        res.once("end", () => {
          if (settled) return;
          settled = true;
          out.end(() => resolve());
        });
        res.once("aborted", () => fail(new ComponentInstallError("network", `Connection to ${url.host} closed mid-download`)));
        res.once("error", (error) => fail(o.signal?.aborted ? abortError() : error instanceof ComponentInstallError ? error : new ComponentInstallError("network", `${url.host}: ${error.message}`)));
        out.once("error", (error) => fail(error));
      });
    } catch (error) {
      await rm(dest, { force: true });
      throw error;
    }
    return { sha256: hash.digest("hex"), size };
  }
}

const retryable = (error: unknown): boolean => {
  if (error instanceof HttpStatusError) return error.status >= 500 || error.status === 429 || error.status === 408;
  if (error instanceof ComponentInstallError) return error.reason === "network" || error.reason === "proxy";
  return false;
};

/**
 * `downloadOnce` with up to `delaysMs.length` retries (1s, 2s, 4s by default) for network and proxy
 * failures. A body that cannot match the lock, or a cancel, is not retried. No resume: each retry
 * starts the file over, and the bytes already counted are reported back through `onRestart`.
 */
export async function downloadWithRetry(
  url: string,
  dest: string,
  o: DownloadOptions & { delaysMs?: readonly number[]; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; onRestart?: (lostBytes: number) => void },
): Promise<{ sha256: string; size: number }> {
  const delays = o.delaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = o.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    let received = 0;
    try {
      return await downloadOnce(url, dest, { ...o, onBytes: (n) => { received += n; o.onBytes?.(n); } });
    } catch (error) {
      if (received > 0) o.onRestart?.(received);
      if (o.signal?.aborted || (error as Error).name === "AbortError") throw abortError();
      if (attempt >= delays.length || !retryable(error)) throw error;
      await sleep(delays[attempt]!, o.signal);
    }
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
