import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocketServer } from "ws";
import { connectDaemon } from "../../src/daemon/connection.js";
import { Runner } from "../../src/daemon/runner.js";
import { ensureReportToken, reportTokenHash } from "../../src/report/token.js";
import { tmp } from "./helpers.js";

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

async function helloFor(nemaHome: string): Promise<Record<string, unknown>> {
  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: "/daemon" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanup.push(async () => {
    for (const c of wss.clients) c.terminate();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const hello = new Promise<Record<string, unknown>>((resolve) => wss.on("connection", (ws) => ws.once("message", (d) => resolve(JSON.parse(String(d))))));
  const port = (server.address() as AddressInfo).port;
  const d = connectDaemon({ hubUrl: `http://127.0.0.1:${port}`, token: "tk", runner: new Runner([{ name: "codex-direct", run: async () => ({ ok: true, reply: "" }) }]), nemaHome });
  cleanup.push(() => d.close());
  return hello;
}

describe("daemon hello", () => {
  test("hello carries the report token hash when the token file exists", async () => {
    const nemaHome = tmp("nema-home-");
    const token = ensureReportToken(nemaHome);
    const hello = await helloFor(nemaHome);
    expect(hello.reportTokenHash).toBe(reportTokenHash(nemaHome));
    expect(JSON.stringify(hello)).not.toContain(token);
  });

  test("hello has no report token hash without the token file", async () => {
    const hello = await helloFor(tmp("nema-home-"));
    expect(hello.type).toBe("hello");
    expect("reportTokenHash" in hello).toBe(false);
  });
});
