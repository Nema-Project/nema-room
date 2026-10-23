import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { RoomClient } from "../../src/room/client.js";

let hub: Server;
let hubUrl: string;
let reply: { status: number; body: string };
let seen: { method?: string; url?: string; auth?: string; type?: string; body: string }[];

beforeEach(async () => {
  reply = { status: 200, body: '{"entries":[]}' };
  seen = [];
  hub = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, type: req.headers["content-type"], body });
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(reply.body);
    });
  });
  await new Promise<void>((r) => hub.listen(0, "127.0.0.1", r));
  hubUrl = `http://127.0.0.1:${(hub.address() as AddressInfo).port}/`;
});
afterEach(() => new Promise<void>((r) => hub.close(() => r())));

describe("RoomClient", () => {
  test("maps calls to hub routes with the run token", async () => {
    const c = new RoomClient(hubUrl, "tok123");
    expect(await c.listEntries()).toEqual({ ok: true, json: { entries: [] } });
    await c.readEntry("R/1");
    await c.upsertEntry({ kind: "requirement", title: "t" });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(["GET /room/entries", "GET /room/entries/R%2F1", "POST /room/entries"]);
    expect(seen.every((s) => s.auth === "Bearer tok123")).toBe(true);
    expect(seen[2]!.type).toBe("application/json");
    expect(JSON.parse(seen[2]!.body)).toEqual({ kind: "requirement", title: "t" });
  });

  test("non-2xx -> ok:false with the hub's error message", async () => {
    reply = { status: 401, body: '{"error":"missing or invalid run token"}' };
    expect(await new RoomClient(hubUrl, "x").listEntries()).toEqual({ ok: false, status: 401, error: "missing or invalid run token" });
  });

  test("non-2xx with a non-JSON body uses the raw text, or the status when empty", async () => {
    reply = { status: 500, body: "boom" };
    expect(await new RoomClient(hubUrl, "x").readEntry("R-1")).toEqual({ ok: false, status: 500, error: "boom" });
    reply = { status: 502, body: "" };
    expect(await new RoomClient(hubUrl, "x").readEntry("R-1")).toEqual({ ok: false, status: 502, error: "hub returned HTTP 502" });
  });

  test("an oversized non-JSON error body is capped at 64 KB with a marker", async () => {
    reply = { status: 500, body: "z".repeat(300_000) };
    const r = (await new RoomClient(hubUrl, "x").readEntry("R-1")) as { ok: false; error: string };
    expect(Buffer.byteLength(r.error)).toBeLessThanOrEqual(64 * 1024);
    expect(r.error).toContain("…[已截断：原始 300000 字节，仅保留前 64KB]");
  });

  test("callPlugin posts to /room/plugins/<name> with the run token", async () => {
    reply = { status: 200, body: '{"result":{"text":"ok"}}' };
    const c = new RoomClient(hubUrl, "tok123");
    expect(await c.listPluginTools()).toEqual({ ok: true, json: { result: { text: "ok" } } });
    expect(await c.callPlugin("code__read", { repo: "repo_demo", path: "a.ts" })).toEqual({
      ok: true,
      json: { result: { text: "ok" } },
    });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(["GET /room/plugins", "POST /room/plugins/code__read"]);
    expect(seen.every((s) => s.auth === "Bearer tok123")).toBe(true);
    expect(seen[1]!.type).toBe("application/json");
    expect(JSON.parse(seen[1]!.body)).toEqual({ repo: "repo_demo", path: "a.ts" });
  });

  test("unreachable hub -> ok:false status 0", async () => {
    await new Promise<void>((r) => hub.close(() => r()));
    hub = createServer();
    hub.listen(0); // keep afterEach happy
    const r = await new RoomClient("http://127.0.0.1:1", "x").listEntries();
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ status: 0 });
    expect((r as { error: string }).error).toContain("无法连接 hub");
  });
});
