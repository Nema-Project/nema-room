// Test-only HTTP fixture. Production assets must use the staged Next standalone server.
import http from "node:http";
import { writeFileSync } from "node:fs";
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
server.listen(Number(process.env.PORT), "127.0.0.1");
const exitFixture = (reason) => {
  writeFileSync(fileURLToPath(new URL("./web-exited.marker", import.meta.url)), reason);
  try { server.close(); } catch { /* the test fixture is exiting regardless */ }
  process.exit(0);
};
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => exitFixture(signal));
if (process.connected) {
  process.once("disconnect", () => exitFixture("parent disconnected"));
}
