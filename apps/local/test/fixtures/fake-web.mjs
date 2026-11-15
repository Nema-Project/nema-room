// Test-only HTTP fixture. Production assets must use the staged Next standalone server.
import http from "node:http";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const server = http.createServer((req, res) => {
  if (req.url === "/__test/stop") {
    res.writeHead(200);
    res.once("finish", () => exitFixture("post-crash test cleanup"));
    res.end("stopping");
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end("<!doctype html><title>test web fixture</title>");
});
const exitFixture = (reason) => {
  writeFileSync(fileURLToPath(new URL("./web-exited.marker", import.meta.url)), reason);
  try { server.close(); } catch { /* the test fixture is exiting regardless */ }
  process.exit(0);
};
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => exitFixture(signal));
if (process.connected) {
  process.once("disconnect", () => exitFixture("parent disconnected"));
}
// Optional siblings in the copied assets directory. Production web is the staged Next server and never reads these.
const sibling = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url));
if (existsSync(sibling("web-exit-before-listen"))) process.exit(1);
if (existsSync(sibling("web-wait-for-release"))) {
  const deadline = Date.now() + 30_000;
  while (!existsSync(sibling("web-release"))) {
    if (Date.now() > deadline) process.exit(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
let acceptingHttp = false;
const hubUrlDeliveries = [];
if (process.connected) {
  process.on("message", (message) => {
    if (!message || typeof message !== "object" || message.type !== "hub-url" || typeof message.url !== "string") return;
    hubUrlDeliveries.push({ url: message.url, acceptingHttp });
    writeFileSync(sibling("hub-url.json"), JSON.stringify(hubUrlDeliveries));
  });
}
server.listen(Number(process.env.PORT), "127.0.0.1", () => { acceptingHttp = true; });
