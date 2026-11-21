// The npm / Compose host-daemon path (#132 task 7): a freshly installed npm CLI has no Graphify, its daemon
// reports that without downloading, `nema components install graphify` installs from the lock's Linux
// target, and graph resolution and `nema doctor` then use the component. Compose runs this same host daemon,
// so the containers are untouched. Fixture locks stand in for linux-x64 and linux-arm64; the fake python is
// a shell script, so this runs on POSIX hosts of any architecture. Nothing reaches beyond 127.0.0.1.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { registerComponentsCommands } from "../../src/components/componentsCommands.js";
import type { InstallOptions } from "../../src/components/install.js";
import { lockHash, readLock, resolveTarget, shippedLockPath, totalBytes } from "../../src/components/lock.js";
import { registerComponentHandlers, type ComponentView } from "../../src/components/rpc.js";
import { componentBin, type ComponentEnv } from "../../src/components/store.js";
import { RpcRouter } from "../../src/daemon/rpc.js";
import { runDoctor } from "../../src/doctor.js";
import { graphifyInstallStatus, resolveGraphify } from "../../src/repos/graphify.js";
import { fakeComponent, fakeSource, writeLock, type FakeComponent, type FakeSource } from "./fixtures.js";

let root: string;
let execLog: string;
let source: FakeSource | undefined;
const saved = { bin: process.env.NEMA_GRAPHIFY_BIN, payload: process.env.NEMA_PAYLOAD_ROOT };

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "nema-npm-host-"));
  execLog = path.join(root, "exec.log");
  writeFileSync(execLog, "");
  // The npm form: no explicit binary and no desktop payload root.
  delete process.env.NEMA_GRAPHIFY_BIN;
  delete process.env.NEMA_PAYLOAD_ROOT;
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

/** A fixture component whose lock target key is a Linux one, whatever this host is. */
function linuxComponent(arch: "x64" | "arm64", variant = "a"): FakeComponent {
  return { ...fakeComponent(execLog, variant), key: `linux-${arch}` };
}

/** A fresh npm install's daemon: an empty ~/.nema (here a temp dir) and the CLI's shipped lock (here a fixture). */
function host(component: FakeComponent, arch: "x64" | "arm64", musl = false) {
  const nemaHome = path.join(root, "home", ".nema");
  const components: Omit<ComponentEnv, "env" | "offline"> = {
    runtimeRoot: path.join(nemaHome, "runtime"),
    lockPath: writeLock(path.join(root, `lock-${component.key}-${lockHash(component.target).slice(0, 8)}.json`), component),
    platform: { platform: "linux", arch, musl },
  };
  return { nemaHome, components };
}

async function daemonStatus(nemaHome: string, components: Omit<ComponentEnv, "env" | "offline">, env: NodeJS.ProcessEnv): Promise<ComponentView> {
  const rpc = new RpcRouter();
  const handle = registerComponentHandlers(rpc, { nemaHome, env, components, detectAgents: async () => [] });
  try {
    const response = await rpc.handle({ type: "rpc.request", id: "s1", method: "components.status", params: {} });
    if (!response.ok) throw new Error(response.error);
    return (response.result as { components: ComponentView[] }).components[0]!;
  } finally {
    await handle.close();
  }
}

async function cli(nemaHome: string, components: Omit<ComponentEnv, "env" | "offline">, env: NodeJS.ProcessEnv, ...args: string[]) {
  const lines: string[] = [];
  const errors: string[] = [];
  let code = -1;
  const program = new Command().exitOverride();
  registerComponentsCommands(
    program.command("components"),
    {
      nemaHome,
      out: { log: (s) => void lines.push(s), error: (s) => void errors.push(s) },
      stdin: () => process.stdin,
      interactive: () => false,
      version: "0.0.0-test",
      env,
      components,
      hooks: quick,
      onInterrupt: () => () => {},
    },
    (c) => {
      code = c;
    },
  );
  await program.parseAsync(["components", ...args], { from: "user" });
  return { code, lines, errors };
}

const doctorGraphify = async (components: Omit<ComponentEnv, "env" | "offline">) => {
  const checks = await runDoctor({
    codexBin: path.join(root, "none"),
    userCodexHome: path.join(root, "none"),
    hubUrl: "http://127.0.0.1:1",
    tokenFile: path.join(root, "token"),
    nemaHome: path.join(root, "doctor-home"),
    adapter: "codex-direct",
    graphify: { components },
    agentHome: path.join(root, "agent-home"),
    githubMcpServerBin: path.join(root, "missing-github-mcp-server"),
  });
  return checks.find((check) => check.name.startsWith("graphify"))!;
};

test("the shipped lock pins glibc Linux targets for both npm host architectures", () => {
  const lock = readLock(shippedLockPath());
  for (const arch of ["x64", "arm64"]) {
    const resolved = resolveTarget(lock, { platform: "linux", arch, musl: false });
    expect(resolved.ok, `linux-${arch}`).toBe(true);
    if (resolved.ok) expect(resolved.totalBytes).toBeGreaterThan(0);
    expect(resolveTarget(lock, { platform: "linux", arch, musl: true })).toMatchObject({ ok: false, detail: expect.stringMatching(/musl/) });
  }
});

for (const arch of ["x64", "arm64"] as const) describe.skipIf(process.platform === "win32")(`npm host daemon on linux-${arch}`, () => {
  test("uninstalled -> nema components install graphify -> self-check -> componentBin, graph resolution and doctor use it", async () => {
    const component = linuxComponent(arch);
    source = await fakeSource(component);
    const env = source.env();
    const { nemaHome, components } = host(component, arch);
    const hash = lockHash(component.target);
    const store = path.join(nemaHome, "runtime", "graphify");

    // 1. Fresh install: the daemon reports not installed with the lock's size, and nothing downloaded.
    const before = await daemonStatus(nemaHome, components, env);
    expect(before.status).toEqual({ state: "not-installed", name: "graphify", lockHash: hash });
    expect(before.offer).toMatchObject({ lockHash: hash, totalBytes: totalBytes(component.target), location: store });
    expect(source.requests).toEqual([]);
    expect(resolveGraphify(process.env, { components })).toMatchObject({ found: false, state: "not-installed" });
    const missing = await graphifyInstallStatus({ components });
    expect(missing).toMatchObject({ installed: false, state: "not-installed" });
    expect(missing.detail).toContain("nema components install graphify");
    expect((await doctorGraphify(components)).detail).toMatch(/^未安装：.*nema components install graphify/);

    // 2. The no-UI path: the CLI command downloads, verifies, assembles and self-checks.
    const installed = await cli(nemaHome, components, env, "install", "graphify", "--yes");
    expect(installed.code).toBe(0);
    expect(source.requests.length).toBe(1 + component.target.wheels.length);
    // The self-check ran the staged launcher's python before activation.
    expect(readFileSync(execLog, "utf8").split("\n").filter(Boolean)).toEqual([path.join(store, `${hash}.staging`, "python", "bin", "python3.11")]);

    // 3. Usable: componentBin, the daemon's graph resolution and its status agree.
    const launcher = path.join(store, hash, "graphify");
    expect(componentBin("graphify", components)).toBe(launcher);
    expect(resolveGraphify(process.env, { components })).toEqual({ found: true, bin: launcher, source: "component" });
    expect(await graphifyInstallStatus({ components })).toMatchObject({ installed: true, state: "installed", source: "component", detail: "graphify 0.9.95-a" });
    expect((await daemonStatus(nemaHome, components, env)).status).toMatchObject({ state: "installed", lockHash: hash, launcher });
    expect(await doctorGraphify(components)).toMatchObject({ ok: true, detail: "graphify 0.9.95-a" });

    // 4. The npm CLI is upgraded to a build with another lock: the old version is disabled, not reused.
    const upgraded = linuxComponent(arch, "b");
    const next = host(upgraded, arch);
    expect(componentBin("graphify", next.components)).toBeNull();
    expect(resolveGraphify(process.env, { components: next.components })).toMatchObject({ found: false, state: "lock-mismatch" });
    expect(await doctorGraphify(next.components)).toMatchObject({ ok: true, detail: expect.stringMatching(/^版本不匹配（已停用）：/) });
  });

  test("musl (Alpine) is reported unsupported and never downloads", async () => {
    const component = linuxComponent(arch);
    source = await fakeSource(component);
    const { nemaHome, components } = host(component, arch, true);
    const view = await daemonStatus(nemaHome, components, source.env());
    expect(view.status).toMatchObject({ state: "failed", reason: "unsupported-platform", lockHash: null });
    expect(view.offer).toBeNull();
    const refused = await cli(nemaHome, components, source.env(), "install", "graphify", "--yes");
    expect(refused.code).toBe(1);
    expect(refused.errors.join("\n")).toMatch(/cannot be installed here: .*musl/);
    expect(source.requests).toEqual([]);
    expect(existsSync(path.join(nemaHome, "runtime", "graphify"))).toBe(false);
  });
});

test("Compose runs the host daemon: the images and the compose files carry no Graphify component", () => {
  const repo = (file: string) => readFileSync(new URL(`../../../../${file}`, import.meta.url), "utf8");
  for (const file of ["Dockerfile", "docker-compose.yml", "docker-compose.build.yml"]) {
    expect(repo(file), file).not.toMatch(/graphify|NEMA_GRAPHIFY|nema components/i);
  }
});
