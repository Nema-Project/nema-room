import { parseDaemonToHub } from "@nema/shared";
import { expect, test } from "vitest";
import { createConnectionRpc } from "../src/daemonRpc.js";

test.each([
  {
    graphifyError: { code: "graphify-unavailable", state: "failed", status: { state: "failed", reason: "proxy", detail: "Proxy refused", installedLockHash: "old" } },
    recognized: true,
  },
  { graphifyError: { code: "graphify-interrupted" }, recognized: true },
  { graphifyError: { code: "future-code" }, recognized: false },
  { graphifyError: undefined, recognized: false },
])("RPC errors retain the fallback and keep only understood metadata ($graphifyError.code)", async ({ graphifyError, recognized }) => {
  let id = "";
  const rpc = createConnectionRpc((requestId) => { id = requestId; });
  const pending = rpc.call("plugin.call", {});
  const message = parseDaemonToHub(JSON.parse(JSON.stringify({
    type: "rpc.response", id, ok: false, error: "fallback", graphifyError,
  })));
  if (message.type !== "rpc.response") throw new Error("Expected an RPC response");
  rpc.onResponse(message);
  await expect(pending).rejects.toMatchObject({ message: "fallback", graphifyError: recognized ? graphifyError : undefined });
});
