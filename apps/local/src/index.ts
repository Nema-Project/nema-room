import { pathToFileURL } from "node:url";
import { startLocalRuntime, ensureLocalRuntime } from "./runtime.js";

export { startLocalRuntime, ensureLocalRuntime, shutdownLocalRuntime } from "./runtime.js";
export type { LocalRuntime, LocalRuntimeOptions } from "./runtime.js";
export { acquireInstance, discoverInstance, requestInstanceShutdown } from "./instance.js";
export { SessionManager } from "./session.js";
export { createGatewayCredential, createGatewayUiAuth, startGateway, GATEWAY_CREDENTIAL_HEADER, sessionCookieName } from "./gateway.js";

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && pathToFileURL(entry).href === import.meta.url);
}

async function serve(home: string, assetsDir: string, webPort?: number): Promise<void> {
  const runtime = await startLocalRuntime({ home, assetsDir, ...(webPort !== undefined ? { webPort } : {}) });
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= runtime.close().then(() => { process.exitCode = 0; }, (error) => {
      console.error("managed local runtime shutdown failed", error);
      process.exitCode = 1;
    });
    stop();
  };
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => { stop = resolve; });
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  if (!process.stdin.isTTY) {
    process.stdin.setEncoding("utf8");
    let input = "";
    process.stdin.on("data", (chunk: string) => {
      input += chunk;
      if (input.includes("\n") && input.trim() === "close") close();
    });
  }
  process.stdout.write(`${JSON.stringify({ state: "ready", origin: runtime.origin })}\n`);
  if (process.send && process.connected) process.send({ type: "core-ready" });
  await stopped;
  await closing;
}

async function main(): Promise<void> {
  if (process.argv[2] === "--serve") {
    const [, , , home, assetsDir, rawPort] = process.argv;
    if (!home || !assetsDir || (rawPort !== undefined && !/^\d+$/.test(rawPort))) throw new Error("Usage: local-core --serve <home> <assetsDir> [webPort]");
    await serve(home, assetsDir, rawPort === undefined ? undefined : Number(rawPort));
    return;
  }
  const home = process.argv[2];
  const assetsDir = process.argv[3];
  if (!assetsDir) throw new Error("Usage: local-core <home> <assetsDir>");
  const instance = await ensureLocalRuntime({ home, assetsDir });
  process.stdout.write(`${instance.origin}\n`);
}

if (isDirectExecution()) {
  main().catch((error) => {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "NEMA_LOCAL_START_FAILED";
    if (process.send && process.connected) {
      const collision = code === "NEMA_LOCAL_OWNER_COLLISION";
      process.send({
        type: "core-error",
        code: collision ? code : "NEMA_LOCAL_START_FAILED",
        message: collision ? "Another local core owns the control port" : "Managed local core failed to start",
      });
    }
    console.error("managed local core failed", code);
    process.exitCode = 1;
  });
}
