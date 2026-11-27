// #299 batch 0: hub decisions that used to compare against copied Chinese wording now read the producer's
// constant. Each test feeds the decision the text its producer actually emits, so the pair stays in step
// whatever the wording becomes.
import { MIRROR_URL_ERROR, bundledExtensions, parseVersionSkew, unknownRpcMethodError } from "@nema/shared";
import { expect, test } from "vitest";
import { componentHttpStatus } from "../src/components.js";
import { DAEMON_DISCONNECTED, DAEMON_NOT_CONNECTED, DAEMON_TIMED_OUT, DaemonRpcError, createConnectionRpc, isDaemonOffline } from "../src/daemonRpc.js";
import { versionSkewMessage } from "../src/hubVersion.js";
import { daemonHttpStatus, listExtensions, mcpHttpStatus } from "../src/plugins.js";

const OFFLINE = [DAEMON_NOT_CONNECTED, DAEMON_DISCONNECTED, DAEMON_TIMED_OUT];

test("the connection's own timeout and disconnect errors count as offline", async () => {
  const rpc = createConnectionRpc(() => {});
  const timedOut = await rpc.call("code__read", {}, 5).catch((e: unknown) => e);
  expect(timedOut).toBeInstanceOf(DaemonRpcError);
  expect(isDaemonOffline((timedOut as Error).message)).toBe(true);
  const pending = rpc.call("code__read", {}, 10_000).catch((e: unknown) => e);
  rpc.failAll(DAEMON_DISCONNECTED);
  expect(isDaemonOffline(((await pending) as Error).message)).toBe(true);
});

test("every offline error maps to 503 and anything else to 502", () => {
  for (const message of OFFLINE) {
    expect(daemonHttpStatus(message)).toBe(503);
    expect(mcpHttpStatus(message)).toBe(503);
  }
  expect(daemonHttpStatus(`${DAEMON_NOT_CONNECTED}!`)).toBe(502);
  expect(daemonHttpStatus(unknownRpcMethodError("x"))).toBe(502);
});

test("every offline error falls back to the extension index on disk", async () => {
  for (const message of OFFLINE) {
    const rows = await listExtensions({ call: async () => { throw new DaemonRpcError(message); } });
    expect(rows.map((row) => row.id)).toEqual(bundledExtensions().map((row) => row.id));
  }
  await expect(listExtensions({ call: async () => { throw new DaemonRpcError("boom"); } })).rejects.toThrow("boom");
});

test("the hub's version-skew refusal is what the daemon's parser recognizes", () => {
  expect(parseVersionSkew(versionSkewMessage("1.2.3"))).toEqual({ installVersion: "1.2.3" });
  expect(parseVersionSkew(versionSkewMessage("0.5.0-beta.1", "0.4.0"))).toEqual({ installVersion: "0.5.0-beta.1" });
});

test("the daemon's mirror refusal is a 400, also when wrapped", () => {
  expect(componentHttpStatus(MIRROR_URL_ERROR)).toBe(400);
  expect(componentHttpStatus(`invalid settings: ${MIRROR_URL_ERROR}`)).toBe(400);
  expect(componentHttpStatus("mirror unreachable")).toBe(502);
});
