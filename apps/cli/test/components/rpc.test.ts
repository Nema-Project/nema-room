// The daemon's component RPC with a fixture lock and a fake installer: no download, no real ~/.nema.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { detectAgentClis } from "../../src/agentClis.js";
import { componentProcessEnv, registerComponentHandlers, type ComponentRpcOptions, type ComponentView } from "../../src/components/rpc.js";
import type { InstallOptions } from "../../src/components/install.js";
import { lockHash } from "../../src/components/lock.js";
import { launcherName } from "../../src/components/store.js";
import type { ComponentStatus } from "../../src/components/types.js";
import { RpcRouter } from "../../src/daemon/rpc.js";
import { fakeComponent, writeLock, type FakeComponent } from "./fixtures.js";

let root: string;
let nemaHome: string;
let runtimeRoot: string;
let lockPath: string;
let component: FakeComponent;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "nema-component-rpc-"));
  nemaHome = path.join(root, "home");
  runtimeRoot = path.join(root, "runtime");
  component = fakeComponent(path.join(root, "exec.log"));
  lockPath = writeLock(path.join(root, "graphify-lock.json"), component);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const platform = { platform: process.platform, arch: process.arch, musl: false };

function setup(extra: Partial<Omit<ComponentRpcOptions, "nemaHome">> = {}) {
  const rpc = new RpcRouter();
  const handle = registerComponentHandlers(rpc, { nemaHome, env: {}, components: { runtimeRoot, lockPath, platform }, ...extra });
  let seq = 0;
  const call = async (method: string, params: unknown = {}) => {
    const response = await rpc.handle({ type: "rpc.request", id: `r${++seq}`, method, params });
    if (!response.ok) throw new Error(response.error);
    return response.result;
  };
  const status = async () => ((await call("components.status")) as { components: ComponentView[] }).components[0]!;
  return { call, status, close: handle.close };
}

const lockTotal = () => [component.target.python, ...component.target.wheels].reduce((sum, entry) => sum + entry.size, 0);
const notInstalled = (): ComponentStatus => ({ state: "not-installed", name: "graphify", lockHash: lockHash(component.target) });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("components.status", () => {
  test("offers the lock's summed size, the store location and the upstream hosts without installing anything", async () => {
    const install = vi.fn();
    const view = await setup({ install }).status();
    expect(view.name).toBe("graphify");
    expect(view.status.state).toBe("not-installed");
    expect(view.offer).toEqual({
      lockHash: lockHash(component.target),
      totalBytes: lockTotal(),
      location: path.join(runtimeRoot, "graphify"),
      hosts: ["github.com", "files.pythonhosted.org"],
    });
    expect(view.settings.offline).toEqual({ value: false, source: null, config: false });
    expect(install).not.toHaveBeenCalled();
  });

  test("an unsupported platform has no offer and says why", async () => {
    const view = await setup({ components: { runtimeRoot, lockPath, platform: { platform: "linux", arch: "x64", musl: true } } }).status();
    expect(view.offer).toBeNull();
    expect(view.status).toMatchObject({ state: "failed", reason: "unsupported-platform" });
  });

  test("an unreadable lock is reported as such, not as not-installed", async () => {
    writeFileSync(lockPath, "{");
    const view = await setup().status();
    expect(view.offer).toBeNull();
    expect(view.status).toMatchObject({ state: "failed", reason: "lock-unreadable" });
  });
});

describe("components.install", () => {
  test("refuses without the user's confirmation and never calls the installer", async () => {
    const install = vi.fn();
    const { call } = setup({ install });
    await expect(call("components.install", { name: "graphify" })).rejects.toThrow(/confirmation/);
    await expect(call("components.install", { name: "graphify", confirmed: "yes" })).rejects.toThrow(/confirmation/);
    expect(install).not.toHaveBeenCalled();
  });

  test("refuses an unknown component", async () => {
    const { call } = setup({ install: vi.fn() });
    await expect(call("components.install", { name: "other", confirmed: true })).rejects.toThrow(/Unknown component/);
  });

  test("refuses when the confirmed offer was for another lock", async () => {
    const install = vi.fn();
    const { call } = setup({ install });
    await expect(call("components.install", { name: "graphify", confirmed: true, lockHash: "0".repeat(64) })).rejects.toThrow(/confirm again/);
    expect(install).not.toHaveBeenCalled();
  });

  test("answers at once, reports installing while the installer runs, and runs one install at a time", async () => {
    const gate = deferred<ComponentStatus>();
    const install = vi.fn((_name: string, _o: InstallOptions) => gate.promise);
    const { call, status } = setup({ install });
    const started = (await call("components.install", { name: "graphify", confirmed: true, lockHash: lockHash(component.target) })) as ComponentView;
    expect(started.status.state).toBe("installing");
    expect((await status()).status).toMatchObject({ state: "installing", progress: { downloadedBytes: 0, totalBytes: lockTotal() } });
    await call("components.install", { name: "graphify", confirmed: true });
    await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(1));
    gate.resolve(notInstalled());
    await vi.waitFor(async () => expect((await status()).status.state).toBe("not-installed"));
    expect(install).toHaveBeenCalledTimes(1);
  });

  test("force reinstalls an installed component; without it the install is a no-op", async () => {
    // Seed the store as installed: the active pointer's launcher file is what the status reads.
    const hash = lockHash(component.target);
    const dir = path.join(runtimeRoot, "graphify", hash);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, launcherName(process.platform)), "#!/bin/sh\nexit 0\n");
    writeFileSync(path.join(runtimeRoot, "graphify", "current.json"), JSON.stringify({ active: hash }));
    expect((await setup().status()).status.state).toBe("installed");

    const install = vi.fn(async (_name: string, _o: InstallOptions) => notInstalled());
    const { call } = setup({ install });
    const current = (await call("components.install", { name: "graphify", confirmed: true, lockHash: hash })) as ComponentView;
    expect(current.status.state).toBe("installed");
    expect(install).not.toHaveBeenCalled();

    await call("components.install", { name: "graphify", confirmed: true, lockHash: hash, force: true });
    await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(1));
    expect(install.mock.calls[0]![1].force).toBe(true);
  });

  test("cancel aborts the running install", async () => {
    let signal: AbortSignal | undefined;
    const install = vi.fn((_name: string, o: InstallOptions) => {
      signal = o.signal;
      return new Promise<ComponentStatus>((resolve) => {
        o.signal?.addEventListener("abort", () => resolve(notInstalled()));
      });
    });
    const { call } = setup({ install });
    await call("components.install", { name: "graphify", confirmed: true });
    await vi.waitFor(() => expect(signal).toBeDefined());
    const after = (await call("components.cancel", { name: "graphify" })) as ComponentView;
    expect(signal?.aborted).toBe(true);
    expect(after.status.state).toBe("not-installed");
  });

  test("passes the offline setting and the saved mirrors to the installer", async () => {
    const install = vi.fn(async (_name: string, _o: InstallOptions) => notInstalled());
    const { call } = setup({ install });
    await call("components.configure", { name: "graphify", pythonMirror: "https://mirror.example/python/", pypiBase: "https://pypi.example" });
    await call("components.install", { name: "graphify", confirmed: true });
    await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(1));
    const env = install.mock.calls[0]![1].env!;
    expect(env.env?.NEMA_GRAPHIFY_PYTHON_MIRROR).toBe("https://mirror.example/python");
    expect(env.env?.NEMA_GRAPHIFY_PYPI_BASE).toBe("https://pypi.example");
    expect(env.offline).toBe(false);
  });

  test("close aborts a running install", async () => {
    let signal: AbortSignal | undefined;
    const install = vi.fn((_name: string, o: InstallOptions) => {
      signal = o.signal;
      return new Promise<ComponentStatus>((resolve) => {
        o.signal?.addEventListener("abort", () => resolve(notInstalled()));
      });
    });
    const { call, close } = setup({ install });
    await call("components.install", { confirmed: true });
    await vi.waitFor(() => expect(signal).toBeDefined());
    await close();
    expect(signal?.aborted).toBe(true);
  });
});

describe("components.configure", () => {
  test("saves the mirror fields to the same config the variables stand for, and clears them", async () => {
    const { call } = setup();
    const view = (await call("components.configure", { name: "graphify", pythonMirror: "https://mirror.example/python/", pypiBase: "https://pypi.example" })) as ComponentView;
    expect(view.settings.pythonMirror).toEqual({ value: "https://mirror.example/python", source: "config", config: "https://mirror.example/python" });
    expect(view.offer?.hosts).toEqual(["mirror.example", "pypi.example"]);
    expect(JSON.parse(readFileSync(path.join(nemaHome, "config.json"), "utf8")).components).toEqual({
      pythonMirror: "https://mirror.example/python",
      pypiBase: "https://pypi.example",
    });
    const cleared = (await call("components.configure", { name: "graphify", pythonMirror: null, pypiBase: "" })) as ComponentView;
    expect(cleared.settings.pythonMirror).toEqual({ value: null, source: null, config: null });
    expect(JSON.parse(readFileSync(path.join(nemaHome, "config.json"), "utf8")).components).toBeUndefined();
  });

  test("rejects a mirror that is not a plain http(s) URL", async () => {
    const { call } = setup();
    await expect(call("components.configure", { pythonMirror: "ftp://mirror.example" })).rejects.toThrow(/http\(s\)/);
    await expect(call("components.configure", { pypiBase: "https://user:pw@pypi.example" })).rejects.toThrow(/http\(s\)/);
    await expect(call("components.configure", { pypiBase: 42 })).rejects.toThrow(/invalid pypiBase/);
  });

  test("an environment variable wins over the saved field and is reported as the source", async () => {
    const install = vi.fn(async (_name: string, _o: InstallOptions) => notInstalled());
    const { call } = setup({ install, env: { NEMA_GRAPHIFY_PYTHON_MIRROR: "https://env.example/py" } });
    const view = (await call("components.configure", { pythonMirror: "https://saved.example/py" })) as ComponentView;
    expect(view.settings.pythonMirror).toEqual({ value: "https://env.example/py", source: "env", config: "https://saved.example/py" });
    expect(view.offer?.hosts[0]).toBe("env.example");
    await call("components.install", { confirmed: true });
    await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(1));
    expect(install.mock.calls[0]![1].env?.env?.NEMA_GRAPHIFY_PYTHON_MIRROR).toBe("https://env.example/py");
  });

  test("the offline switch is saved and reported, and an environment variable that sets it wins", async () => {
    const { call } = setup();
    const on = (await call("components.configure", { offline: true })) as ComponentView;
    expect(on.settings.offline).toEqual({ value: true, source: "config", config: true });
    expect(on.status).toMatchObject({ state: "failed", reason: "offline" });
    const off = (await call("components.configure", { offline: false })) as ComponentView;
    expect(off.settings.offline).toEqual({ value: false, source: null, config: false });
    const forced = await setup({ env: { NEMA_GRAPHIFY_OFFLINE: "1" } }).status();
    expect(forced.settings.offline).toEqual({ value: true, source: "env", config: false });
  });
});

describe("componentProcessEnv", () => {
  test("fills only the variables that are unset or blank", () => {
    const config = { components: { pythonMirror: "https://a.example", pypiBase: "https://b.example" } };
    expect(componentProcessEnv(config, { NEMA_GRAPHIFY_PYTHON_MIRROR: "https://env.example", NEMA_GRAPHIFY_PYPI_BASE: "  " })).toMatchObject({
      NEMA_GRAPHIFY_PYTHON_MIRROR: "https://env.example",
      NEMA_GRAPHIFY_PYPI_BASE: "https://b.example",
    });
  });
});

describe("agent CLI detection", () => {
  test("reports versions of installed CLIs and the official install page of missing ones, running no installer", async () => {
    const ran: string[] = [];
    const agents = await detectAgentClis(async (command) => {
      ran.push(command);
      if (command === "claude") return "2.1.400 (Claude Code)\nextra\n";
      throw new Error("ENOENT");
    });
    expect(ran.sort()).toEqual(["claude", "codex"]);
    expect(agents).toEqual([
      { id: "codex", command: "codex", installed: false, version: null, installUrl: "https://developers.openai.com/codex/cli" },
      { id: "claude-code", command: "claude", installed: true, version: "2.1.400 (Claude Code)", installUrl: "https://code.claude.com/docs/en/setup" },
    ]);
  });

  test("agents.detect answers through the injected detector", async () => {
    const detectAgents = vi.fn(async () => [{ id: "codex", installed: true }]);
    const { call } = setup({ detectAgents });
    expect(await call("agents.detect")).toEqual({ agents: [{ id: "codex", installed: true }] });
  });
});
