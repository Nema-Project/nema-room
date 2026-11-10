import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { readFileSync } from "node:fs";
import test from "node:test";
import "./share-peer-guard.mjs";

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
  try {
    const blocked = await ask(`/s/${token}`, { "x-forwarded-for": "10.0.0.1", "x-nema-share-peer": "127.0.0.1" });
    assert.equal(blocked.status, 404);
    assert.equal(blocked.body, "not found");
    assert.equal(blocked.cache, "no-store");
    assert.equal(hits.length, 0);
    const allowed = await ask(`/s/${token}`, { "x-nema-share-peer": "8.8.8.8" });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body, "next");
    assert.equal(hits[0].peer, "127.0.0.1");
    const home = await ask("/", { "x-nema-share-peer": "127.0.0.1" });
    assert.equal(home.body, "next");
    assert.equal(hits[1].peer, undefined);
    for (const path of [`/./s/${token}`, `/x/../s/${token}`, `/%2e/s/${token}`]) {
      const disguised = await ask(path, { "x-nema-share-peer": "127.0.0.1" });
      assert.equal(disguised.body, "next", path);
      assert.equal(hits.at(-1).peer, undefined, path);
    }
  } finally {
    server.close();
  }
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
