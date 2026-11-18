// `nema components status | install | pack | import`, run in-process against temp stores, a fixture lock and a
// local fake upstream. No daemon is involved: the CLI reads and writes the component store itself.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { saveConfig } from "../../src/config.js";
import { registerComponentsCommands, type ComponentsCommandDeps } from "../../src/components/componentsCommands.js";
import type { InstallOptions } from "../../src/components/install.js";
import { lockHash } from "../../src/components/lock.js";
import { componentBin, readPointer } from "../../src/components/store.js";
import { fakeComponent, fakeSource, writeLock, type FakeComponent, type FakeSource } from "./fixtures.js";

let root: string;
let execLog: string;
let sources: FakeSource[] = [];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "nema-components-cli-"));
  execLog = path.join(root, "exec.log");
  writeFileSync(execLog, "");
});

afterEach(async () => {
  for (const source of sources.splice(0)) await source.close();
  rmSync(root, { recursive: true, force: true });
});

const quick: InstallOptions["hooks"] = { retryDelaysMs: [0, 0, 0], timeoutMs: 2_000, freeBytes: async () => Number.MAX_SAFE_INTEGER };

async function serve(component: FakeComponent): Promise<FakeSource> {
  const source = await fakeSource(component);
  sources.push(source);
  return source;
}

type Harness = { lines: string[]; errors: string[]; codes: number[]; run: (...args: string[]) => Promise<number> };

function harness(component: FakeComponent, deps: Partial<ComponentsCommandDeps> = {}, home = path.join(root, "home")): Harness {
  const lines: string[] = [];
  const errors: string[] = [];
  const codes: number[] = [];
  const lockPath = writeLock(path.join(root, "lock.json"), component);
  const run = async (...args: string[]) => {
    const program = new Command().exitOverride();
    const components = program.command("components");
    registerComponentsCommands(
      components,
      {
        nemaHome: home,
        out: { log: (s) => void lines.push(s), error: (s) => void errors.push(s) },
        stdin: () => Readable.from([]),
        interactive: () => false,
        version: "0.0.0-test",
        env: {},
        components: { runtimeRoot: path.join(root, "runtime"), lockPath, platform: { platform: process.platform, arch: process.arch, musl: false } },
        hooks: quick,
        onInterrupt: () => () => {},
        ...deps,
      },
      (code) => void codes.push(code),
    );
    await program.parseAsync(["components", ...args], { from: "user" });
    return codes.at(-1)!;
  };
  return { lines, errors, codes, run };
}

const store = () => path.join(root, "runtime", "graphify");

test("the four subcommands are registered", () => {
  const program = new Command();
  registerComponentsCommands(program.command("components"), { nemaHome: root, out: { log() {}, error() {} }, stdin: () => process.stdin, version: "t" });
  const components = program.commands.find((command) => command.name() === "components")!;
  expect(components.commands.map((command) => command.name()).sort()).toEqual(["import", "install", "pack", "status"]);
});

describe("status", () => {
  test("prints the state, lock-hash, location and download size without a daemon", async () => {
    const component = fakeComponent(execLog);
    const h = harness(component);
    expect(await h.run("status")).toBe(0);
    const hash = lockHash(component.target);
    const text = h.lines.join("\n");
    expect(text).toContain("graphify: not installed");
    expect(text).toContain(`lock-hash: ${hash}`);
    expect(text).toContain(`location: ${store()}`);
    const total = component.target.python.size + component.target.wheels.reduce((sum, wheel) => sum + wheel.size, 0);
    expect(text).toContain(`(${total} bytes) from github.com, files.pythonhosted.org`);
    expect(text).toContain("install: nema components install graphify");

    const json = harness(component);
    expect(await json.run("status", "--json")).toBe(0);
    expect(JSON.parse(json.lines.join("\n"))).toMatchObject({ name: "graphify", status: { state: "not-installed", lockHash: hash }, offer: { totalBytes: total, location: store() } });
  });
});

describe.skipIf(process.platform === "win32")("install", () => {
  test("--yes prints the offer and installs without asking", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const h = harness(component, { env: source.env() });
    expect(await h.run("install", "graphify", "--yes")).toBe(0);
    const hash = lockHash(component.target);
    expect(h.lines.join("\n")).toMatch(/Download: .*MiB \(\d+ bytes\) from 127\.0\.0\.1:\d+/);
    expect(h.lines.join("\n")).toContain(`Install location: ${store()}`);
    expect(h.lines.join("\n")).not.toContain("[y/N]");
    expect(h.lines.at(-1)).toBe(`graphify is installed (lock-hash ${hash}) at ${path.join(store(), hash)}`);
    expect(readPointer(store()).active).toBe(hash);

    const again = harness(component, { env: source.env() });
    expect(await again.run("status")).toBe(0);
    expect(again.lines.join("\n")).toContain("graphify: installed");
    expect(again.lines.join("\n")).toContain(`location: ${path.join(store(), hash)}`);
  });

  test("--force reinstalls the installed version; without it the install is a no-op", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const h = harness(component, { env: source.env() });
    expect(await h.run("install", "graphify", "--yes")).toBe(0);
    const hash = lockHash(component.target);
    const firstRequests = source.requests.length;
    expect(firstRequests).toBeGreaterThan(0);

    const again = harness(component, { env: source.env() });
    expect(await again.run("install", "graphify", "--yes")).toBe(0);
    expect(again.lines.join("\n")).toContain("already installed");
    expect(again.lines.join("\n")).toContain("nema components install graphify --force");
    expect(source.requests.length).toBe(firstRequests);

    const force = harness(component, { env: source.env() });
    expect(await force.run("install", "graphify", "--yes", "--force")).toBe(0);
    expect(force.lines.join("\n")).toContain("reinstalls the current version");
    expect(source.requests.length).toBeGreaterThan(firstRequests);
    expect(readPointer(store()).active).toBe(hash);
  });

  test("a failed --force reinstall exits 1, names the failure, and leaves the old version installed", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const h = harness(component, { env: source.env() });
    expect(await h.run("install", "graphify", "--yes")).toBe(0);
    const hash = lockHash(component.target);
    // Tamper the installed tree so the reinstall cannot take the identical-tree reuse path.
    writeFileSync(path.join(store(), hash, "python", "lib", "python3.11", "os.py"), "# damaged\n");

    const failing = harness(component, {
      env: source.env(),
      hooks: {
        ...quick,
        rename: async () => {
          throw new Error("injected: could not move staging into place");
        },
      },
    });
    expect(await failing.run("install", "graphify", "--yes", "--force")).toBe(1);
    expect(failing.errors.join("\n")).toContain("the reinstall failed (the self-check failed)");
    expect(failing.errors.join("\n")).toContain("injected: could not move staging into place");
    expect(failing.errors.join("\n")).toContain("is unchanged");

    const again = harness(component, { env: source.env() });
    expect(await again.run("status")).toBe(0);
    expect(again.lines.join("\n")).toContain("graphify: installed");
    // The text status shows the failed repair too, not just the installed state.
    expect(again.lines.join("\n")).toContain("last reinstall failed: the self-check failed");
    expect(readPointer(store()).active).toBe(hash);
  });

  test("a failed first install is not called a reinstall when another process installs first", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const hash = lockHash(component.target);
    const h = harness(component, {
      env: source.env(),
      // The attempt fails; by the time the result is reported, another process has installed the
      // component. The report must stay about this attempt.
      install: async () => {
        const dir = path.join(store(), hash);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "graphify"), "#!/bin/sh\nexit 0\n");
        writeFileSync(path.join(store(), "current.json"), JSON.stringify({ active: hash }));
        return { state: "failed", name: "graphify", lockHash: hash, reason: "network", detail: "connect ECONNREFUSED", at: "2026-11-18T00:00:00.000Z" } as const;
      },
    });
    expect(await h.run("install", "graphify", "--yes")).toBe(1);
    expect(h.errors.join("\n")).toContain("last attempt failed: network error");
    expect(h.errors.join("\n")).not.toContain("the reinstall failed");
  });

  test("cancelling a reinstall reports the cancel, not the still-installed copy", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const h = harness(component, { env: source.env() });
    expect(await h.run("install", "graphify", "--yes")).toBe(0);

    let interrupt: (() => void) | undefined;
    const cancelling = harness(component, {
      env: source.env(),
      onInterrupt: (cb) => {
        interrupt = cb;
        return () => {};
      },
      // The installer's contract after a cancelled repair: it throws the abort error (no failure
      // record; the previous state is unchanged). The command must not call that a success.
      install: async () => {
        interrupt?.();
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        throw error;
      },
    });
    expect(await cancelling.run("install", "graphify", "--yes", "--force")).toBe(130);
    expect(cancelling.errors.join("\n")).toContain("Cancelled; nothing was changed.");
    expect(cancelling.lines.join("\n")).not.toContain("is installed");
  });

  test("an interactive yes installs; a no or a closed stdin downloads nothing", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const no = harness(component, { env: source.env(), interactive: () => true, stdin: () => Readable.from(["n\n"]) });
    expect(await no.run("install", "graphify")).toBe(1);
    expect(no.lines.join("\n")).toContain("Download and install? [y/N]");
    expect(no.errors.join("\n")).toContain("graphify was not installed.");
    const closed = harness(component, { env: source.env(), interactive: () => true, stdin: () => Readable.from([]) });
    expect(await closed.run("install", "graphify")).toBe(1);
    expect(source.requests).toEqual([]);

    const yes = harness(component, { env: source.env(), interactive: () => true, stdin: () => Readable.from(["y\n"]) });
    expect(await yes.run("install", "graphify")).toBe(0);
    expect(componentBin("graphify", { runtimeRoot: path.join(root, "runtime"), lockPath: path.join(root, "lock.json"), platform: { platform: process.platform, arch: process.arch, musl: false } })).toBe(
      path.join(store(), lockHash(component.target), "graphify"),
    );
  });

  test("without a terminal and without --yes it refuses before any download", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const install = vi.fn();
    const h = harness(component, { env: source.env(), install });
    expect(await h.run("install", "graphify")).toBe(1);
    expect(h.errors.join("\n")).toContain("pass --yes");
    expect(install).not.toHaveBeenCalled();
    expect(source.requests).toEqual([]);
  });

  test("the offline switch (variable or config) refuses with zero download attempts, even with --yes", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const install = vi.fn();
    const byEnv = harness(component, { env: source.env({ NEMA_GRAPHIFY_OFFLINE: "1" }), install });
    expect(await byEnv.run("install", "graphify", "--yes")).toBe(1);
    expect(byEnv.errors.join("\n")).toContain("Downloads are turned off (NEMA_GRAPHIFY_OFFLINE)");
    expect(byEnv.errors.join("\n")).toContain("nema components import <file>");

    const home = path.join(root, "offline-home");
    saveConfig(home, { components: { offline: true } });
    const byConfig = harness(component, { env: source.env(), install, interactive: () => true, stdin: () => Readable.from(["y\n"]) }, home);
    expect(await byConfig.run("install", "graphify")).toBe(1);
    expect(byConfig.errors.join("\n")).toContain("Downloads are turned off (components.offline)");
    expect(install).not.toHaveBeenCalled();
    expect(source.requests).toEqual([]);
  });

  test("a failed install names the reason and exits 1", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const bad = Buffer.from(component.files.get(component.target.python.file)!);
    bad[10] ^= 0xff;
    source.override.set(component.target.python.file, bad);
    const h = harness(component, { env: source.env() });
    expect(await h.run("install", "graphify", "--yes")).toBe(1);
    expect(h.errors.join("\n")).toContain("graphify: not installed (last attempt failed: an archive did not match the lock (sha256 or size))");
    expect(readPointer(store()).active).toBeNull();
  });

  test("an unknown component is an error", async () => {
    const h = harness(fakeComponent(execLog));
    expect(await h.run("install", "nodejs", "--yes")).toBe(1);
    expect(h.errors.join("\n")).toContain("Unknown component: nodejs");
  });
});

describe.skipIf(process.platform === "win32")("pack and import", () => {
  test("pack states the distributor's license duty; import of a mismatched pack is rejected with nothing changed", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const output = path.join(root, "graphify.nema-component");
    const maker = harness(component, { env: source.env() });
    expect(await maker.run("pack", "graphify", "--output", output)).toBe(0);
    const text = maker.lines.join("\n");
    expect(text).toContain(`Wrote ${output}`);
    expect(text).toContain("You make and distribute this pack");
    expect(text).toContain("python-build-standalone");

    const importer = harness(component, { env: { NEMA_GRAPHIFY_OFFLINE: "1" } });
    expect(await importer.run("import", output)).toBe(0);
    expect(importer.lines.join("\n")).toContain("Pack matches this Nema build");
    expect(importer.lines.at(-1)).toMatch(/^graphify is installed \(lock-hash [a-f0-9]{64}\)/);

    const other = fakeComponent(execLog, "other");
    const mismatched = harness(other, { env: { NEMA_GRAPHIFY_OFFLINE: "1" } });
    expect(await mismatched.run("import", output)).toBe(1);
    expect(mismatched.errors.join("\n")).toMatch(/^Pack rejected: The pack's lock-hash/);
    expect(mismatched.errors.join("\n")).toContain("Nothing was installed or changed.");
  });
});
