// Sending hooks and reports to the hub, and the local spool used while the hub is unreachable.
import { randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";

export type HubPath = "/report/hook" | "/report";
export type SendResult = "ok" | "dropped" | "failed";
export type SendOpts = { connectMs: number; totalMs: number };
export const HOOK_TIMEOUTS: SendOpts = { connectMs: 500, totalMs: 1500 };

/** POSTs JSON with a bearer token. Never throws: network errors and timeouts are status 0. */
export function postToHub(hubUrl: string, p: HubPath, token: string, body: unknown, opts: SendOpts = HOOK_TIMEOUTS): Promise<{ status: number; text: string }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (status: number, text: string) => {
      if (done) return;
      done = true;
      clearTimeout(total);
      clearTimeout(connect);
      resolve({ status, text });
    };
    let url: URL;
    try {
      url = new URL(hubUrl.replace(/\/+$/, "") + p);
    } catch {
      resolve({ status: 0, text: "" });
      return;
    }
    const data = Buffer.from(JSON.stringify(body));
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(url, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(data.length), authorization: `Bearer ${token}` },
    });
    const connect = setTimeout(() => req.destroy(new Error("connect timeout")), opts.connectMs);
    const total = setTimeout(() => req.destroy(new Error("timeout")), opts.totalMs);
    req.on("socket", (s) => {
      if (!s.connecting) clearTimeout(connect);
      else s.once("connect", () => clearTimeout(connect));
    });
    req.on("error", () => finish(0, ""));
    req.on("response", (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => {
        if (text.length < 4096) text += c;
      });
      res.on("end", () => finish(res.statusCode ?? 0, text));
      res.on("error", () => finish(0, ""));
    });
    req.end(data);
  });
}

/** GETs with a bearer token. Never throws: network errors and timeouts are status 0. */
export function getFromHub(hubUrl: string, p: string, token: string, opts: SendOpts = { connectMs: 2000, totalMs: 15000 }): Promise<{ status: number; text: string }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (status: number, text: string) => {
      if (done) return;
      done = true;
      clearTimeout(total);
      clearTimeout(connect);
      resolve({ status, text });
    };
    let url: URL;
    try {
      url = new URL(hubUrl.replace(/\/+$/, "") + p);
    } catch {
      resolve({ status: 0, text: "" });
      return;
    }
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(url, { method: "GET", headers: { authorization: `Bearer ${token}` } });
    const connect = setTimeout(() => req.destroy(new Error("connect timeout")), opts.connectMs);
    const total = setTimeout(() => req.destroy(new Error("timeout")), opts.totalMs);
    req.on("socket", (s) => {
      if (!s.connecting) clearTimeout(connect);
      else s.once("connect", () => clearTimeout(connect));
    });
    req.on("error", () => finish(0, ""));
    req.on("response", (res) => {
      const chunks: string[] = [];
      res.setEncoding("utf8");
      res.on("data", (c: string) => chunks.push(c));
      res.on("end", () => finish(res.statusCode ?? 0, chunks.join("")));
      res.on("error", () => finish(0, ""));
    });
    req.end();
  });
}

export function classify(status: number): SendResult {
  if (status >= 200 && status < 300) return "ok";
  if (status >= 400 && status < 500) return "dropped";
  return "failed";
}

/** 2xx (204 too: dropped hub-side) is "ok"; 4xx is "dropped"; network failure, timeout or 5xx is "failed". */
export async function sendToHub(hubUrl: string, p: HubPath, token: string, body: unknown, opts: SendOpts = HOOK_TIMEOUTS): Promise<SendResult> {
  return classify((await postToHub(hubUrl, p, token, body, opts)).status);
}

// --- spool ---

export const SPOOL_MAX_BYTES = 5 * 1024 * 1024;
const SPOOL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export type SpoolLine = { path: HubPath; body: unknown; spooledAt: string };

export const spoolPath = (nemaHome: string): string => path.join(nemaHome, "report-spool.jsonl");

/** Appends one line (0600). Returns false, writing nothing, when the spool would grow past 5 MB. */
export function appendSpool(nemaHome: string, line: SpoolLine): boolean {
  mkdirSync(nemaHome, { recursive: true, mode: 0o700 });
  const text = JSON.stringify(line) + "\n";
  const fd = openSync(spoolPath(nemaHome), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return false;
    if ((st.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600);
    if (st.size + Buffer.byteLength(text) > SPOOL_MAX_BYTES) return false;
    writeSync(fd, text);
    return true;
  } finally {
    closeSync(fd);
  }
}

function readSpool(nemaHome: string): string | null {
  let fd: number;
  try {
    fd = openSync(spoolPath(nemaHome), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  try {
    if (!fstatSync(fd).isFile()) return null;
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function writeSpool(nemaHome: string, lines: SpoolLine[]): void {
  const file = spoolPath(nemaHome);
  if (lines.length === 0) {
    try {
      unlinkSync(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    return;
  }
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, lines.map((l) => JSON.stringify(l) + "\n").join(""));
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

function parseLine(raw: string): SpoolLine | null {
  try {
    const v = JSON.parse(raw) as SpoolLine;
    if ((v.path === "/report/hook" || v.path === "/report") && typeof v.spooledAt === "string" && v.body !== undefined) return v;
  } catch {
    /* malformed: dropped */
  }
  return null;
}

/**
 * Replays the spool oldest first and stops at the first "failed". "ok" and "dropped" lines are removed;
 * lines older than 7 days or malformed are dropped unsent. The rest is rewritten atomically.
 * Returns "failed" when something is still waiting, else "ok".
 */
export async function flushSpool(nemaHome: string, send: (line: SpoolLine) => Promise<SendResult>, now: number = Date.now()): Promise<"ok" | "failed"> {
  const raw = readSpool(nemaHome);
  if (raw === null) return "ok";
  const lines = raw
    .split("\n")
    .filter((l) => l !== "")
    .map(parseLine)
    .filter((l): l is SpoolLine => l !== null && now - Date.parse(l.spooledAt) <= SPOOL_MAX_AGE_MS);
  let i = 0;
  let result: "ok" | "failed" = "ok";
  for (; i < lines.length; i++) {
    if ((await send(lines[i]!)) === "failed") {
      result = "failed";
      break;
    }
  }
  writeSpool(nemaHome, lines.slice(i));
  return result;
}
