import http from "node:http";
import { installSharePeerGuard } from "./share-peer-guard.mjs";

installSharePeerGuard();

if (!process.connected) {
  process.stderr.write("Managed Web entry requires its owning local core IPC channel\n");
  process.exit(1);
}

process.on("message", (message) => {
  if (message && typeof message === "object" && message.type === "hub-url" && typeof message.url === "string") {
    process.env.NEMA_HUB_INTERNAL_URL = message.url;
  }
});

process.once("disconnect", () => process.exit(0));
try {
  await import("./server.js");
} catch (error) {
  process.stderr.write(`Managed Web server failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
const deadline = Date.now() + 20_000;
const announceReady = () => new Promise((resolve, reject) => {
  const req = http.get(`http://127.0.0.1:${process.env.PORT}/`, (res) => {
    res.resume();
    res.once("end", () => resolve(true));
  });
  req.setTimeout(500, () => req.destroy(new Error("Web readiness timed out")));
  req.once("error", reject);
});
while (process.connected && Date.now() < deadline) {
  try {
    await announceReady();
    process.send?.({ type: "managed-web-ready", port: Number(process.env.PORT) });
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
}
