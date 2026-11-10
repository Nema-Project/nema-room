import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sharePeerDecision as guardDecision } from "./share-peer-guard.mjs";
import { sharePeerDecision as sourceDecision } from "../../../apps/local/src/sharePeer.ts";

test("the process guard uses the same peer decision as the runtime", () => {
  const cases = [
    ["127.0.0.1", {}],
    ["192.168.1.10", {}],
    ["fd00::10", {}],
    ["fe80::1%eth0", {}],
    ["::ffff:192.168.0.5", {}],
    ["::1", {}],
    ["8.8.8.8", {}],
    ["172.32.0.1", {}],
    ["0.0.0.0", {}],
    ["::", {}],
    ["example.com", {}],
    ["10.1.2.3", { "x-forwarded-for": "10.0.0.1" }],
    ["203.0.113.5", { "X-Forwarded-For": "10.0.0.5" }],
    [null, {}],
    ["::1", { forwarded: "for=127.0.0.1" }],
  ];
  for (const [peer, headers] of cases) {
    assert.equal(guardDecision(peer, headers), sourceDecision(peer, headers), String(peer));
  }
});

test("a forwarded share request stops before Next and an allowed one keeps the socket peer", async () => {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url, peer: req.headers["x-nema-share-peer"] });
    res.end("next");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const ask = (path, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: address.port, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body, cache: res.headers["cache-control"] }));
    });
    req.on("error", reject);
    req.end();
  });
  const token = "a".repeat(43);
  const blocked = await ask(`/s/${token}`, { "x-forwarded-for": "10.0.0.1", "x-nema-share-peer": "127.0.0.1" });
  assert.equal(blocked.status, 404);
  assert.equal(blocked.body, "not found");
  assert.equal(blocked.cache, "no-store");
  assert.equal(hits.length, 0);
  const allowed = await ask(`/s/${token}`, { "x-nema-share-peer": "8.8.8.8" });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body, "next");
  assert.equal(hits[0].peer, "127.0.0.1");
  const home = await ask("/");
  assert.equal(home.body, "next");
  assert.equal(hits[1].peer, undefined);
  server.close();
});

test("desktop and container wrappers install the guard before Next starts", () => {
  const parent = readFileSync(new URL("./web-parent.mjs", import.meta.url), "utf8");
  const entry = readFileSync(new URL("../../images/web-entrypoint.sh", import.meta.url), "utf8");
  const guard = readFileSync(new URL("./share-peer-guard.mjs", import.meta.url), "utf8");
  assert.ok(parent.indexOf("installSharePeerGuard") < parent.indexOf('import("./server.js")'));
  assert.ok(parent.indexOf("hub-url") < parent.indexOf('import("./server.js")'));
  assert.match(entry, /--import \/opt\/nema\/share-peer-guard\.mjs/);
  assert.match(entry, /^export HOSTNAME=0\.0\.0\.0$/m);
  assert.match(entry, /^exec node apps\/web\/server\.js$/m);
  assert.doesNotMatch(`${parent}\n${entry}\n${guard}`, /NextRequest/);
});
