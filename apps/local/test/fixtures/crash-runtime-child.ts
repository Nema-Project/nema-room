import { startLocalRuntime, setRuntimeReadyHookForTests, type LocalRuntime } from "../../src/runtime.js";
import { claimNextTask } from "@nema/hub/tasks";
import { postUserMessage } from "@nema/hub/messages";
import { createWorkspace } from "@nema/hub/workspaces";

const home = process.argv[2];
const assetsDir = process.argv[3];
if (!home || !assetsDir) throw new Error("crash fixture requires a home and assets directory");

let runtime: LocalRuntime | undefined;
setRuntimeReadyHookForTests(async ({ db, dataDir, webPort, webChild }) => {
  void webChild;
  process.stdout.write(`${JSON.stringify({ phase: "web-port", port: webPort })}\n`);
  const workspace = await createWorkspace(db, dataDir, "process crash fixture");
  const posted = await postUserMessage(db, workspace.id, "committed running token before forced core exit");
  const running = await claimNextTask(db, "test-crashed-daemon");
  if (!running?.runToken) throw new Error("could not seed a running token");
  await db.query("update workspaces set archived_at = now() where id = $1", [workspace.id]);
  process.stdout.write(`${JSON.stringify({ phase: "seeded", taskId: posted.task.id, token: running.runToken })}\n`);
});

runtime = await startLocalRuntime({ home, assetsDir });
process.stdout.write(`${JSON.stringify({ phase: "ready", origin: runtime.origin })}\n`);

process.on("message", async (message: unknown) => {
  if (!message || typeof message !== "object") return;
  if ((message as { action?: unknown }).action === "close-runtime" && runtime) {
    await runtime.close();
    process.send?.({ action: "closed" });
    process.exit(0);
  }
});
