import http from "node:http";

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const ENTRY_RE = /^[A-Za-z0-9_-]+$/;
const SHARE_BODY_LIMIT = 2 * 1024 * 1024;
const SHARE_TIMEOUT_MS = 10_000;

export type ShareFetchInput = { hostname: string; port: number; path: string; headers: Record<string, string> };
export type ShareFetch = (input: ShareFetchInput) => Promise<{ statusCode: number; body: Buffer }>;

let shareFetchForTests: ShareFetch | undefined;

export function setShareFetchForTests(fetchImpl: ShareFetch | undefined): void {
  shareFetchForTests = fetchImpl;
}

type HubTarget = { hostname: string; port: number };

function hubTarget(): HubTarget | null {
  const raw = process.env.NEMA_HUB_INTERNAL_URL ?? "http://127.0.0.1:4400";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || url.username || url.password) return null;
  const hostname = url.hostname;
  if (hostname !== "localhost" && hostname !== "127.0.0.1" && !/^[a-z0-9-]{1,63}$/.test(hostname)) return null;
  const port = url.port === "" ? 4400 : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { hostname, port };
}

function sharePath(kind: "list" | "entry", token: string, entryId?: string): string | null {
  if (!TOKEN_RE.test(token)) return null;
  switch (kind) {
    case "list":
      return `/share/${token}`;
    case "entry":
      return entryId && ENTRY_RE.test(entryId) ? `/share/${token}/entries/${entryId}` : null;
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

function httpGet(input: ShareFetchInput): Promise<{ statusCode: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: input.hostname,
        port: input.port,
        path: input.path,
        method: "GET",
        headers: { host: input.headers.host },
        timeout: SHARE_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > SHARE_BODY_LIMIT) {
            req.destroy(new Error("share body too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ statusCode: res.statusCode ?? 503, body: Buffer.concat(chunks) }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("share timeout")));
    req.on("error", reject);
    req.end();
  });
}

/** Reads the hub's public share JSON. A bad hub URL or an oversized body is 503 and does not return the payload. */
export async function fetchShare(kind: "list" | "entry", token: string, entryId?: string): Promise<{ status: number; body: unknown }> {
  const target = hubTarget();
  const path = sharePath(kind, token, entryId);
  if (!target) return { status: 503, body: null };
  if (!path) return { status: 404, body: null };
  const input: ShareFetchInput = {
    hostname: target.hostname,
    port: target.port,
    path,
    headers: { host: `127.0.0.1:${target.port}` },
  };
  let response: { statusCode: number; body: Buffer };
  try {
    response = await (shareFetchForTests ?? httpGet)(input);
  } catch {
    return { status: 503, body: null };
  }
  if (response.body.length > SHARE_BODY_LIMIT) return { status: 503, body: null };
  if (response.statusCode !== 200) return { status: response.statusCode, body: null };
  try {
    return { status: 200, body: JSON.parse(response.body.toString("utf8")) as unknown };
  } catch {
    return { status: 503, body: null };
  }
}
