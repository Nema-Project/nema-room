// #56 Python line change, spec D-4: a Graphify component installed under the previous lock (CPython 3.11)
// is not reused or migrated when the program ships a lock on another line (CPython 3.14). It reports
// `lock-mismatch`, is disabled, and graph resolution fails with GraphifyUnavailableError naming the manual
// install; the user's standard install under the new lock then works. A workspace graph file is never
// touched along the way. The fake python is a shell script, so this runs on POSIX; nothing leaves 127.0.0.1.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { installComponent, type InstallOptions } from "../../src/components/install.js";
import { lockHash } from "../../src/components/lock.js";
import { componentBin, componentStatus, readPointer, type ComponentEnv } from "../../src/components/store.js";
import { buildIndex, graphifyInstallStatus, GraphifyUnavailableError, INSTALL_COMMAND, resolveGraphify } from "../../src/repos/graphify.js";
import { fakeComponent, fakeSource, OLD_PYTHON_LINE, PYTHON_LINE, writeLock, type FakeSource } from "./fixtures.js";

let root: string;
let execLog: string;
let source: FakeSource | undefined;
const saved = { bin: process.env.NEMA_GRAPHIFY_BIN, payload: process.env.NEMA_PAYLOAD_ROOT };

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "nema-python-line-"));
  execLog = path.join(root, "exec.log");
  writeFileSync(execLog, "");
  // Resolution must reach the component store: no explicit binary, no desktop payload fallback.
  delete process.env.NEMA_GRAPHIFY_BIN;
  process.env.NEMA_PAYLOAD_ROOT = path.join(root, "payload-without-graphify");
});

afterEach(async () => {
  await source?.close();
  source = undefined;
  rmSync(root, { recursive: true, force: true });
  for (const [key, value] of [["NEMA_GRAPHIFY_BIN", saved.bin], ["NEMA_PAYLOAD_ROOT", saved.payload]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const quick: InstallOptions["hooks"] = { retryDelaysMs: [0, 0, 0], timeoutMs: 2_000, freeBytes: async () => Number.MAX_SAFE_INTEGER };
const ran = () => readFileSync(execLog, "utf8").split("\n").filter(Boolean);

describe.skipIf(process.platform === "win32")("a component installed under the previous Python line (D-4)", () => {
  test("is lock-mismatch and unused under the new lock, graph calls name the manual install, and a manual install then works", async () => {
    const old = fakeComponent(execLog, "old", OLD_PYTHON_LINE);
    const next = fakeComponent(execLog, "new", PYTHON_LINE);
    source = await fakeSource(old, next);
    const runtimeRoot = path.join(root, "runtime");
    const store = path.join(runtimeRoot, "graphify");
    const platform = { platform: process.platform, arch: process.arch, musl: false };
    // The same store seen by two program builds: one shipping the old lock, one the new.
    const oldEnv: ComponentEnv = { env: source.env(), runtimeRoot, lockPath: writeLock(path.join(root, "lock-old.json"), old, OLD_PYTHON_LINE), platform };
    const newEnv: ComponentEnv = { env: source.env(), runtimeRoot, lockPath: writeLock(path.join(root, "lock-new.json"), next, PYTHON_LINE), platform };
    const oldHash = lockHash(old.target);
    const newHash = lockHash(next.target);
    expect(newHash).not.toBe(oldHash);

    // A workspace graph produced before the upgrade. Nothing in this flow may touch it.
    const snapshot = path.join(root, "workspace-snapshot");
    const graph = path.join(snapshot, "src", "graphify-out", "graph.json");
    mkdirSync(path.dirname(graph), { recursive: true });
    const graphBytes = Buffer.from(`${JSON.stringify({ nodes: [{ id: "Widget" }], links: [] })}\n`);
    writeFileSync(graph, graphBytes);
    const graphUnchanged = () => expect(readFileSync(graph).equals(graphBytes)).toBe(true);
    const graphOpts = (components: ComponentEnv) => ({ components, payloadRoot: path.join(root, "payload-without-graphify") });

    // 1. Installed under the old lock: it runs on the old line's interpreter.
    expect(await installComponent("graphify", { env: oldEnv, hooks: quick })).toMatchObject({ state: "installed", lockHash: oldHash, version: { python: OLD_PYTHON_LINE.version } });
    const oldLauncher = path.join(store, oldHash, "graphify");
    expect(componentBin("graphify", oldEnv)).toBe(oldLauncher);
    expect(readFileSync(oldLauncher, "utf8")).toContain(`/python/bin/${OLD_PYTHON_LINE.interpreter}"`);
    graphUnchanged();

    // 2. The program now ships the new lock: the old component is lock-mismatch, disabled and unused.
    writeFileSync(execLog, "");
    expect(await componentStatus(newEnv)).toEqual({ state: "lock-mismatch", name: "graphify", lockHash: newHash, installedLockHash: oldHash });
    expect(componentBin("graphify", newEnv)).toBeNull();
    const resolved = resolveGraphify(process.env, graphOpts(newEnv));
    expect(resolved).toMatchObject({ found: false, state: "lock-mismatch" });
    expect(JSON.stringify(resolved)).not.toContain(oldLauncher);

    // 3. A graph call in that state throws GraphifyUnavailableError naming the manual install, and runs nothing.
    const error = await buildIndex(snapshot, graphOpts(newEnv)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GraphifyUnavailableError);
    expect(error).toMatchObject({ code: "graphify-unavailable", state: "lock-mismatch" });
    expect((error as Error).message).toContain("已停用");
    expect((error as Error).message).toContain(INSTALL_COMMAND);
    expect(await graphifyInstallStatus(graphOpts(newEnv))).toMatchObject({ installed: false, state: "lock-mismatch" });
    expect(ran()).toEqual([]);
    // Nothing was installed, migrated or removed on its own: the old version is still the pointer's active one.
    expect(readPointer(store)).toEqual({ active: oldHash, previous: null });
    graphUnchanged();

    // 4. The user's manual, standard install under the new lock: self-checked on the new interpreter, then used.
    expect(await installComponent("graphify", { env: newEnv, hooks: quick })).toMatchObject({ state: "installed", lockHash: newHash, version: { python: PYTHON_LINE.version } });
    expect(ran()).toEqual([path.join(store, `${newHash}.staging`, "python", "bin", PYTHON_LINE.interpreter)]);
    const newLauncher = path.join(store, newHash, "graphify");
    expect(readFileSync(newLauncher, "utf8")).toContain(`/python/bin/${PYTHON_LINE.interpreter}"`);
    expect(readFileSync(newLauncher, "utf8")).not.toContain(OLD_PYTHON_LINE.interpreter);
    expect(readPointer(store)).toEqual({ active: newHash, previous: oldHash });
    expect(await componentStatus(newEnv)).toMatchObject({ state: "installed", lockHash: newHash, launcher: newLauncher });
    expect(resolveGraphify(process.env, graphOpts(newEnv))).toEqual({ found: true, bin: newLauncher, source: "component" });
    expect(execFileSync(newLauncher, ["--version"], { encoding: "utf8" }).trim()).toBe("graphify 0.9.95-new");
    expect(await graphifyInstallStatus(graphOpts(newEnv))).toMatchObject({ installed: true, state: "installed", source: "component", detail: "graphify 0.9.95-new" });
    expect(ran().slice(1).every((entry) => entry === path.join(store, newHash, "python", "bin", PYTHON_LINE.interpreter))).toBe(true);
    graphUnchanged();
  });
});
