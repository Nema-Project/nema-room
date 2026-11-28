import { parseDaemonToHub } from "@nema/shared";
import { expect, test } from "vitest";
import { DAEMON_DISCONNECTED, DAEMON_NOT_CONNECTED, DAEMON_TIMED_OUT, DaemonRpcError, createConnectionRpc, daemonErrorBody } from "../src/daemonRpc.js";

async function rejected(response: Record<string, unknown>): Promise<unknown> {
  let id = "";
  const rpc = createConnectionRpc((requestId) => { id = requestId; });
  const pending = rpc.call("repo.inspect", {});
  const message = parseDaemonToHub(JSON.parse(JSON.stringify({ type: "rpc.response", id, ok: false, ...response })));
  if (message.type !== "rpc.response") throw new Error("Expected an RPC response");
  rpc.onResponse(message);
  return pending.catch((e: unknown) => e);
}

test("a coded daemon error keeps its code and clean params; an older daemon's error has none (#299 batch 1)", async () => {
  const coded = await rejected({ error: "不是 git 仓库的根目录", code: "repo.not-git-root", params: { path: "/x", deep: { a: 1 } } });
  expect(coded).toBeInstanceOf(DaemonRpcError);
  expect(coded).toMatchObject({ message: "不是 git 仓库的根目录", code: "repo.not-git-root", params: { path: "/x" } });
  expect(daemonErrorBody(coded as DaemonRpcError)).toEqual({ error: "不是 git 仓库的根目录", code: "repo.not-git-root", params: { path: "/x" } });

  const old = await rejected({ error: "不是 git 仓库的根目录" }) as DaemonRpcError;
  expect(old.code).toBeUndefined();
  expect(daemonErrorBody(old)).toEqual({ error: "不是 git 仓库的根目录" });

  const malformed = await rejected({ error: "x", code: "Not A Code", params: { a: "1" } }) as DaemonRpcError;
  expect(daemonErrorBody(malformed)).toEqual({ error: "x" });
});

test("the hub's own offline texts carry their codes", () => {
  expect(new DaemonRpcError(DAEMON_NOT_CONNECTED).code).toBe("daemon.not-connected");
  expect(new DaemonRpcError(DAEMON_DISCONNECTED).code).toBe("daemon.disconnected");
  expect(new DaemonRpcError(DAEMON_TIMED_OUT).code).toBe("daemon.timed-out");
  expect(new DaemonRpcError("anything else").code).toBeUndefined();
});

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
