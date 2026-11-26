// #299 batch 0: texts one app produces and another matches live in one place. These tests pin the helpers
// (including the wording older daemons and hubs already send) and guard against a copy of the wording
// creeping back into a matcher, where a later translation would silently break it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  ARCHITECTURE_DIAGRAM_MARKER,
  UNKNOWN_RPC_METHOD_PREFIX,
  VERSION_SKEW_MARKER,
  isUnknownRpcMethodError,
  nemaCliSpec,
  parseVersionSkew,
  unknownRpcMethodError,
} from "../src/index.js";

test("an unknown-method error built by the daemon is recognized by the hub's check", () => {
  expect(isUnknownRpcMethodError(unknownRpcMethodError("skills.catalog"))).toBe(true);
  expect(unknownRpcMethodError("attachments.capabilities").startsWith(UNKNOWN_RPC_METHOD_PREFIX)).toBe(true);
  expect(isUnknownRpcMethodError("daemon 未连接")).toBe(false);
  expect(isUnknownRpcMethodError(`x ${UNKNOWN_RPC_METHOD_PREFIX}skills.catalog`)).toBe(false);
});

test("released daemons' unknown-method wording is still recognized", () => {
  expect(isUnknownRpcMethodError("未知方法 skills.catalog")).toBe(true);
});

test("parseVersionSkew reads any message carrying the marker and the CLI spec", () => {
  expect(parseVersionSkew(`refused: ${VERSION_SKEW_MARKER}, install ${nemaCliSpec("1.2.3")}`)).toEqual({ installVersion: "1.2.3" });
  expect(parseVersionSkew(`${VERSION_SKEW_MARKER} ${nemaCliSpec("0.4.0-beta.2")} then restart`)).toEqual({ installVersion: "0.4.0-beta.2" });
  expect(parseVersionSkew(`${VERSION_SKEW_MARKER} without a spec`)).toEqual({ installVersion: null });
  expect(parseVersionSkew(`some other refusal ${nemaCliSpec("1.2.3")}`)).toBeNull();
});

test("released hubs' version-skew wording is still parsed", () => {
  expect(parseVersionSkew("hub 与 nema CLI 版本不一致（hub 1.2.3），请安装 @nema-project/nema@1.2.3")).toEqual({ installVersion: "1.2.3" });
  expect(parseVersionSkew("hub 与 nema CLI 版本不一致，请同时更新（重新构建 compose 并重启 nema daemon）")).toEqual({ installVersion: null });
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SOURCE_DIRS = ["apps/hub/src", "apps/cli/src", "apps/web/components", "apps/web/lib", "apps/web/app", "packages/shared/src"];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|mts)$/.test(name)) out.push(full);
  }
  return out;
}

/** Each coupled wording may appear only where it is defined (plus the listed, reviewed exceptions). */
const OWNERS: { text: string; files: string[] }[] = [
  { text: "daemon 未连接", files: ["apps/hub/src/daemonRpc.ts"] },
  { text: "daemon 已断开", files: ["apps/hub/src/daemonRpc.ts"] },
  { text: "daemon 响应超时", files: ["apps/hub/src/daemonRpc.ts"] },
  { text: UNKNOWN_RPC_METHOD_PREFIX.trim(), files: ["packages/shared/src/protocol.ts"] },
  { text: "镜像地址", files: ["packages/shared/src/protocol.ts"] },
  // connection.ts: the daemon's own task-failure text for a skewed task; nothing matches on it.
  { text: VERSION_SKEW_MARKER, files: ["packages/shared/src/protocol.ts", "apps/cli/src/daemon/connection.ts"] },
  // MessageItem.tsx parses the whole stored request format for display; left for the notice batch (#299).
  { text: ARCHITECTURE_DIAGRAM_MARKER, files: ["packages/shared/src/systemMessages.ts", "apps/web/components/MessageItem.tsx"] },
];

test("coupled wordings are not copied into matchers", () => {
  const files = SOURCE_DIRS.flatMap((dir) => sourceFiles(path.join(ROOT, dir)));
  expect(files.length).toBeGreaterThan(100);
  for (const { text, files: allowed } of OWNERS) {
    const found = files
      .filter((file) => readFileSync(file, "utf8").includes(text))
      .map((file) => path.relative(ROOT, file).split(path.sep).join("/"));
    expect(found.sort(), text).toEqual([...allowed].sort());
  }
});
