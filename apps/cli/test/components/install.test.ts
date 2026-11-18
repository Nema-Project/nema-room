// Installer tests against a local fake upstream reached only through the mirror variables. The fake
// python is a shell script, so the suite runs on POSIX; Windows uses the shipped launcher binary.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { activate, acquireInstallLock, installComponent, verifyArchives, verifyLockHeld, type InstallOptions } from "../../src/components/install.js";
import { lockHash } from "../../src/components/lock.js";
import { componentBin, componentStatus, readFailure, readPointer, writePointer, type ComponentEnv } from "../../src/components/store.js";
import type { ComponentStatus, InstallProgress } from "../../src/components/types.js";
import { fakeComponent, fakeSource, writeLock, type FakeComponent, type FakeSource } from "./fixtures.js";

let root: string;
let runtimeRoot: string;
let execLog: string;
let sources: FakeSource[] = [];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "nema-components-"));
  runtimeRoot = path.join(root, "runtime");
  execLog = path.join(root, "exec.log");
  writeFileSync(execLog, "");
});

afterEach(async () => {
  for (const source of sources.splice(0)) await source.close();
  rmSync(root, { recursive: true, force: true });
});

const graphifyRoot = () => path.join(runtimeRoot, "graphify");
const ran = () => readFileSync(execLog, "utf8").split("\n").filter(Boolean);

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function serve(...components: FakeComponent[]): Promise<FakeSource> {
  const source = await fakeSource(...components);
  sources.push(source);
  return source;
}

function envFor(component: FakeComponent, source: FakeSource, extra: Partial<ComponentEnv> = {}, vars: NodeJS.ProcessEnv = {}): ComponentEnv {
  const lockPath = writeLock(path.join(root, `lock-${lockHash(component.target).slice(0, 8)}.json`), component);
  return { env: source.env(vars), runtimeRoot, lockPath, platform: { platform: process.platform, arch: process.arch, musl: false }, ...extra };
}

const quick: InstallOptions["hooks"] = { retryDelaysMs: [0, 0, 0], timeoutMs: 2_000, freeBytes: async () => Number.MAX_SAFE_INTEGER };

function install(env: ComponentEnv, o: Omit<InstallOptions, "env"> = {}): Promise<ComponentStatus> {
  return installComponent("graphify", { env, ...o, hooks: { ...quick, ...o.hooks } });
}

describe.skipIf(process.platform === "win32")("graphify component install", () => {
  test("installs into <lock-hash>, points current.json at it and self-checks the launcher", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const env = envFor(component, source);
    const hash = lockHash(component.target);
    expect(await componentStatus(env)).toEqual({ state: "not-installed", name: "graphify", lockHash: hash });
    const progress: InstallProgress[] = [];
    const status = await install(env, { onProgress: (p) => progress.push(p) });
    expect(status).toMatchObject({ state: "installed", lockHash: hash, path: path.join(graphifyRoot(), hash) });
    expect(readPointer(graphifyRoot())).toEqual({ active: hash, previous: null });
    expect(readdirSync(graphifyRoot()).sort()).toEqual(["current.json", hash].sort());
    const launcher = componentBin("graphify", env);
    expect(launcher).toBe(path.join(graphifyRoot(), hash, "graphify"));
    expect(execFileSync(launcher!, ["--version"], { encoding: "utf8" }).trim()).toBe("graphify 0.9.95-a");
    // The self-check ran the staged copy, before the move; nothing ran the final directory until now.
    expect(ran()).toEqual([path.join(graphifyRoot(), `${hash}.staging`, "python", "bin", "python3.11"), path.join(graphifyRoot(), hash, "python", "bin", "python3.11")]);
    expect(existsSync(path.join(graphifyRoot(), hash, "python", "lib", "python3.11", "site-packages", "graphify", "__init__.py"))).toBe(true);
    expect(existsSync(path.join(graphifyRoot(), hash, "python", "lib", "python3.11", "tkinter"))).toBe(false);
    expect(existsSync(path.join(graphifyRoot(), hash, "licenses", "graphify", "LICENSE"))).toBe(true);
    const total = component.target.python.size + component.target.wheels.reduce((sum, wheel) => sum + wheel.size, 0);
    expect(progress.every((p) => p.totalBytes === total)).toBe(true);
    expect(Math.max(...progress.map((p) => p.downloadedBytes))).toBe(total);
    expect(progress.map((p) => p.phase)).toEqual(expect.arrayContaining(["download", "verify", "extract", "self-check", "activate"]));
    // Mirrors only: every request reached the local fake source, none named an upstream host.
    expect(source.requests).toEqual([
      `/python/20261026/${encodeURIComponent(component.target.python.file)}`,
      ...component.target.wheels.map((wheel) => `/pypi/packages/aa/bb/${wheel.file}`),
    ]);
  });

  test.each([
    ["one flipped byte", (bytes: Buffer) => Buffer.from(bytes.map((byte, index) => (index === 10 ? byte ^ 1 : byte)))],
    ["one extra byte", (bytes: Buffer) => Buffer.concat([bytes, Buffer.from([0])])],
  ])("a wheel with %s fails the whole install as hash-mismatch and activates nothing", async (_label, tamper) => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const env = envFor(component, source);
    const wheel = component.target.wheels[1]!;
    source.override.set(wheel.file, tamper(component.files.get(wheel.file)!));
    const status = await install(env);
    expect(status).toMatchObject({ state: "failed", reason: "hash-mismatch", lockHash: lockHash(component.target) });
    expect(existsSync(path.join(graphifyRoot(), lockHash(component.target)))).toBe(false);
    expect(existsSync(path.join(graphifyRoot(), `${lockHash(component.target)}.staging`))).toBe(false);
    expect(existsSync(path.join(graphifyRoot(), "current.json"))).toBe(false);
    expect(componentBin("graphify", env)).toBeNull();
    expect(ran()).toEqual([]);
  });

  test("a cancelled download clears staging and the active older version keeps working", async () => {
    const older = fakeComponent(execLog, "old");
    const newer = fakeComponent(execLog, "new");
    const source = await serve(older, newer);
    const oldEnv = envFor(older, source);
    expect(await install(oldEnv)).toMatchObject({ state: "installed" });
    const oldHash = lockHash(older.target);
    const newEnv = envFor(newer, source);
    const controller = new AbortController();
    source.intercept = (file, _req, res) => {
      if (file !== newer.target.wheels[0]!.file) return false;
      res.writeHead(200, { "content-length": 1_000_000 });
      res.write(Buffer.alloc(1024));
      controller.abort();
      return true;
    };
    const status = await install(newEnv, { signal: controller.signal });
    expect(status).toMatchObject({ state: "lock-mismatch", installedLockHash: oldHash });
    expect(existsSync(path.join(graphifyRoot(), `${lockHash(newer.target)}.staging`))).toBe(false);
    expect(existsSync(path.join(graphifyRoot(), "last-failure.json"))).toBe(false);
    expect(readPointer(graphifyRoot()).active).toBe(oldHash);
    const oldLauncher = componentBin("graphify", oldEnv);
    expect(oldLauncher).toBe(path.join(graphifyRoot(), oldHash, "graphify"));
    expect(execFileSync(oldLauncher!, ["--version"], { encoding: "utf8" }).trim()).toBe("graphify 0.9.95-old");
    // Under the new lock the old version is not offered as a stand-in.
    expect(componentBin("graphify", newEnv)).toBeNull();
  });

  /** A finished `<lock-hash>` directory with no current.json: an install stopped after the rename. */
  async function orphanOf(component: FakeComponent, source: FakeSource): Promise<string> {
    const other = path.join(root, "elsewhere");
    const env = { ...envFor(component, source), runtimeRoot: other };
    expect(await install(env)).toMatchObject({ state: "installed" });
    const hash = lockHash(component.target);
    mkdirSync(graphifyRoot(), { recursive: true });
    renameSync(path.join(other, "graphify", hash), path.join(graphifyRoot(), hash));
    writeFileSync(execLog, "");
    return path.join(graphifyRoot(), hash);
  }

  test("an intact orphan from an interrupted install is reused after a file-by-file match, without running it first", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const orphan = await orphanOf(component, source);
    const marker = path.join(orphan, "python", "lib", "python3.11", "os.py");
    const before = readFileSync(marker);
    const env = envFor(component, source);
    expect(await install(env)).toMatchObject({ state: "installed", path: orphan });
    expect(readPointer(graphifyRoot()).active).toBe(lockHash(component.target));
    expect(readFileSync(marker)).toEqual(before);
    // Only the fresh staging copy ran; the orphan's launcher was never executed by the installer.
    expect(ran()).toEqual([path.join(graphifyRoot(), `${lockHash(component.target)}.staging`, "python", "bin", "python3.11")]);
    expect(readdirSync(graphifyRoot()).filter((name) => name.includes(".staging") || name.includes(".replaced-"))).toEqual([]);
  });

  test("an orphan with one changed file is replaced, never activated, never run", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const orphan = await orphanOf(component, source);
    writeFileSync(path.join(orphan, "python", "bin", "python3.11"), `#!/bin/sh\necho "tampered $0" >> ${JSON.stringify(execLog)}\n`, { mode: 0o755 });
    const env = envFor(component, source);
    expect(await install(env)).toMatchObject({ state: "installed" });
    expect(readFileSync(path.join(orphan, "python", "bin", "python3.11"), "utf8")).toContain("graphify 0.9.95-a");
    expect(readFileSync(path.join(orphan, "python", "bin", "python3.11"), "utf8")).not.toContain("tampered");
    expect(ran()).toEqual([path.join(graphifyRoot(), `${lockHash(component.target)}.staging`, "python", "bin", "python3.11")]);
  });

  test("an orphan with an extra file is not reused", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const orphan = await orphanOf(component, source);
    writeFileSync(path.join(orphan, "python", "sitecustomize.py"), "import os\n");
    expect(await install(envFor(component, source))).toMatchObject({ state: "installed" });
    expect(existsSync(path.join(orphan, "python", "sitecustomize.py"))).toBe(false);
  });

  test("an invalid active directory is set aside, restored when the new one cannot be put in place, and replaced on retry", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const env = envFor(component, source);
    expect(await install(env)).toMatchObject({ state: "installed" });
    const hash = lockHash(component.target);
    const active = path.join(graphifyRoot(), hash);
    const damaged = path.join(active, "python", "lib", "python3.11", "os.py");
    writeFileSync(damaged, "# damaged\n");
    const pointerBefore = readFileSync(path.join(graphifyRoot(), "current.json"), "utf8");
    const failing = await install(env, {
      force: true,
      hooks: {
        rename: async (from, to) => {
          if (from.endsWith(".staging") && to === active) throw new Error("injected: could not move staging into place");
          await rename(from, to);
        },
      },
    });
    expect(failing).toMatchObject({ state: "failed", reason: "self-check", lockHash: hash });
    // The attempt failed, but the still-serving previous version is what the store reports.
    expect(await componentStatus(env)).toMatchObject({ state: "installed", path: active, lastFailure: { reason: "self-check" } });
    expect(readFileSync(path.join(graphifyRoot(), "current.json"), "utf8")).toBe(pointerBefore);
    expect(readFileSync(damaged, "utf8")).toBe("# damaged\n");
    expect(execFileSync(path.join(active, "graphify"), ["--version"], { encoding: "utf8" }).trim()).toBe("graphify 0.9.95-a");
    expect(readdirSync(graphifyRoot()).filter((name) => name.includes(".staging") || name.includes(".replaced-"))).toEqual([]);

    const seenBackup: boolean[] = [];
    const repaired = await install(env, {
      force: true,
      hooks: {
        writePointer: async (dir, pointer) => {
          seenBackup.push(readdirSync(dir).some((name) => name.includes(".replaced-")));
          const { writePointer } = await import("../../src/components/store.js");
          await writePointer(dir, pointer);
        },
      },
    });
    expect(repaired).toMatchObject({ state: "installed", path: active });
    expect(seenBackup).toEqual([true]);
    expect(readFileSync(damaged, "utf8")).toBe("# stdlib fixture a\n");
    expect(readdirSync(graphifyRoot()).filter((name) => name.includes(".replaced-"))).toEqual([]);
  });

  test("readers do not restore the backup while activation is between its two moves", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const env = envFor(component, source);
    expect((await install(env)).state).toBe("installed");
    const hash = lockHash(component.target);
    // Tamper the installed tree so the next install replaces the referenced version.
    writeFileSync(path.join(graphifyRoot(), hash, "python", "bin", "python3.11"), "tampered\n");
    const atFirstMove = deferred();
    const releaseMove = deferred();
    const reinstall = install(env, {
      force: true,
      hooks: {
        rename: async (from, to) => {
          await rename(from, to);
          if (from === path.join(graphifyRoot(), hash)) {
            // Pause after the first move: the active directory is aside as a backup and
            // the replacement is not placed yet.
            atFirstMove.resolve();
            await releaseMove.promise;
          }
        },
      },
    });
    await atFirstMove.promise;
    // The active directory is aside as a backup and the replacement is not placed yet.
    // A status/bin read must leave the backup alone for activation's rollback.
    const backup = readdirSync(graphifyRoot()).find((name) => name.includes(".replaced-"))!;
    expect(backup).toBeDefined();
    expect((await componentStatus(env)).state).toBe("installing");
    expect(componentBin("graphify", env)).toBeNull();
    expect(existsSync(path.join(graphifyRoot(), backup))).toBe(true);
    expect(existsSync(path.join(graphifyRoot(), hash))).toBe(false);
    releaseMove.resolve();
    expect((await reinstall).state).toBe("installed");
    expect(readdirSync(graphifyRoot()).filter((name) => name.includes(".replaced-"))).toEqual([]);
  });

  test("readers do not delete the backup while staging is placed but the pointer is unwritten", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const env = envFor(component, source);
    expect((await install(env)).state).toBe("installed");
    const hash = lockHash(component.target);
    writeFileSync(path.join(graphifyRoot(), hash, "python", "bin", "python3.11"), "tampered\n");
    const atPointer = deferred();
    const releasePointer = deferred();
    let paused = false;
    const reinstall = install(env, {
      force: true,
      hooks: {
        writePointer: async (r, p) => {
          if (!paused) {
            paused = true;
            atPointer.resolve();
            await releasePointer.promise;
          }
          await writePointer(r, p);
        },
      },
    });
    await atPointer.promise;
    // Staging is already at <hash> and the backup still exists; the pointer still names
    // the old directory. A reader must not prune the backup activation may need to roll back to.
    const backup = readdirSync(graphifyRoot()).find((name) => name.includes(".replaced-"))!;
    expect(backup).toBeDefined();
    expect(existsSync(path.join(graphifyRoot(), hash))).toBe(true);
    expect((await componentStatus(env)).state).toBe("installing");
    expect(existsSync(path.join(graphifyRoot(), backup))).toBe(true);
    releasePointer.resolve();
    expect((await reinstall).state).toBe("installed");
    expect(readdirSync(graphifyRoot()).filter((name) => name.includes(".replaced-"))).toEqual([]);
  });

  test("activation aborts and restores the previous version when its lock is displaced", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const env = envFor(component, source);
    expect((await install(env)).state).toBe("installed");
    const hash = lockHash(component.target);
    writeFileSync(path.join(graphifyRoot(), hash, "python", "bin", "python3.11"), "tampered\n");
    const atFirstMove = deferred();
    const releaseMove = deferred();
    const reinstall = install(env, {
      force: true,
      hooks: {
        rename: async (from, to) => {
          await rename(from, to);
          if (from === path.join(graphifyRoot(), hash)) {
            atFirstMove.resolve();
            await releaseMove.promise;
          }
        },
      },
    });
    await atFirstMove.promise;
    // Displace the installer's lock between activation's two moves, as the takeover race
    // does: its record is moved aside and another installer claims the freed path. The
    // displacing token carries a live pid, so later recovery is skipped while it is held
    // and only activation's own rollback can restore the previous version.
    const lockFile = path.join(graphifyRoot(), ".install.lock");
    renameSync(lockFile, `${lockFile}.stale-test`);
    writeFileSync(lockFile, `${process.pid}:foreign`);
    releaseMove.resolve();
    // The attempt reports its failure (its failure record is what shows the abort); the store still
    // reports the still-serving previous version, and the replacement itself was not published.
    expect(await reinstall).toMatchObject({ state: "failed", reason: "self-check", lockHash: hash });
    expect(await componentStatus(env)).toMatchObject({ state: "installed", lastFailure: { reason: "self-check" } });
    expect(readFailure(graphifyRoot())).toMatchObject({ reason: "self-check", lockHash: hash });
    expect(readFileSync(path.join(graphifyRoot(), hash, "python", "bin", "python3.11"), "utf8")).toBe("tampered\n");
    expect(readdirSync(graphifyRoot()).filter((name) => name.includes(".replaced-"))).toEqual([]);
  });

  test("a damaged previous version is replaced when the app goes back to its lock", async () => {
    const first = fakeComponent(execLog, "one");
    const second = fakeComponent(execLog, "two");
    const source = await serve(first, second);
    const firstEnv = envFor(first, source);
    await install(firstEnv);
    await install(envFor(second, source));
    const firstHash = lockHash(first.target);
    expect(readPointer(graphifyRoot())).toEqual({ active: lockHash(second.target), previous: firstHash });
    writeFileSync(path.join(graphifyRoot(), firstHash, "python", "lib", "python3.11", "os.py"), "# damaged\n");
    expect(await componentStatus(firstEnv)).toMatchObject({ state: "lock-mismatch", installedLockHash: lockHash(second.target) });
    expect(await install(firstEnv)).toMatchObject({ state: "installed", lockHash: firstHash });
    expect(readFileSync(path.join(graphifyRoot(), firstHash, "python", "lib", "python3.11", "os.py"), "utf8")).toBe("# stdlib fixture one\n");
    expect(readPointer(graphifyRoot())).toEqual({ active: firstHash, previous: lockHash(second.target) });
  });

  test("a backup left by a replacement cut off midway is put back before the next install", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const env = envFor(component, source);
    await install(env);
    const hash = lockHash(component.target);
    renameSync(path.join(graphifyRoot(), hash), path.join(graphifyRoot(), `${hash}.replaced-abc123`));
    // Readers heal the interrupted replacement too: resolving the bin puts the backup
    // back instead of reporting the component missing until an install happens to run.
    expect(componentBin("graphify", env)).toBe(path.join(graphifyRoot(), hash, "graphify"));
    expect(await install(env)).toMatchObject({ state: "installed" });
    expect(readdirSync(graphifyRoot()).filter((name) => name.includes(".replaced-"))).toEqual([]);
  });

  test("keeps only the active and previous versions after three installs", async () => {
    const versions = ["one", "two", "three"].map((variant) => fakeComponent(execLog, variant));
    const source = await serve(...versions);
    for (const version of versions) expect(await install(envFor(version, source))).toMatchObject({ state: "installed" });
    const hashes = versions.map((version) => lockHash(version.target));
    expect(readdirSync(graphifyRoot()).filter((name) => /^[a-f0-9]{64}$/.test(name)).sort()).toEqual([hashes[1], hashes[2]].sort());
    expect(readPointer(graphifyRoot())).toEqual({ active: hashes[2], previous: hashes[1] });
  });

  test("mirrors that serve the wrong bytes fail verification", async () => {
    const component = fakeComponent(execLog);
    const impostor = fakeComponent(execLog, "impostor");
    const source = await serve(component);
    source.override.set(component.target.python.file, impostor.files.get(impostor.target.python.file)!);
    expect(await install(envFor(component, source))).toMatchObject({ state: "failed", reason: "hash-mismatch" });
  });

  test("offline mode makes no download attempt", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    expect(await install(envFor(component, source, {}, { NEMA_GRAPHIFY_OFFLINE: "1" }))).toMatchObject({ state: "failed", reason: "offline", at: null });
    expect(await install(envFor(component, source, { offline: true }))).toMatchObject({ state: "failed", reason: "offline" });
    expect(source.requests).toEqual([]);
  });

  test("too little disk space stops before the download and names the shortfall", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const status = await install(envFor(component, source), { hooks: { freeBytes: async () => 1 } });
    expect(status).toMatchObject({ state: "failed", reason: "disk-space", detail: expect.stringMatching(/short by/) });
    expect(source.requests).toEqual([]);
  });

  test("a declined confirmation downloads nothing; the offer carries the lock's total size and hosts", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const env = envFor(component, source);
    const offers: unknown[] = [];
    const status = await install(env, { confirm: (offer) => { offers.push(offer); return false; } });
    expect(status).toMatchObject({ state: "not-installed" });
    expect(offers).toEqual([{
      name: "graphify",
      lockHash: lockHash(component.target),
      totalBytes: component.target.python.size + component.target.wheels.reduce((sum, wheel) => sum + wheel.size, 0),
      location: graphifyRoot(),
      hosts: [new URL(source.url).host],
    }]);
    expect(source.requests).toEqual([]);
  });

  test("an unsupported platform is reported without any attempt", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const env = { ...envFor(component, source), platform: { platform: "linux" as const, arch: process.arch, musl: true } };
    expect(await install(env)).toMatchObject({ state: "failed", reason: "unsupported-platform", lockHash: null });
    expect(source.requests).toEqual([]);
  });
});

describe("installer contracts", () => {
  test("only graphify is a component", async () => {
    await expect(installComponent("python")).rejects.toThrow(/Unknown component/);
  });

  test("archive verification wants exactly the lock's files", async () => {
    const component = fakeComponent(execLog);
    const dir = path.join(root, "archives");
    mkdirSync(dir);
    for (const [file, bytes] of component.files) writeFileSync(path.join(dir, file), bytes);
    await verifyArchives(dir, component.target);
    writeFileSync(path.join(dir, "extra.whl"), "x");
    await expect(verifyArchives(dir, component.target)).rejects.toMatchObject({ reason: "hash-mismatch" });
    rmSync(path.join(dir, "extra.whl"));
    rmSync(path.join(dir, component.target.wheels[0]!.file));
    await expect(verifyArchives(dir, component.target)).rejects.toMatchObject({ reason: "hash-mismatch" });
  });

  test("activation refuses a name that is not a lock-hash", async () => {
    await expect(activate(root, "../escape", path.join(root, "staging"))).rejects.toThrow(/lock-hash/);
  });
});

describe.skipIf(process.platform === "win32")("install lock and interrupted replacements", () => {
  test("a status read restores a replacement cut off by a crash, without an install", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const env = envFor(component, source);
    const hash = lockHash(component.target);
    expect((await install(env)).state).toBe("installed");
    // A crash mid-replacement: the active directory was moved aside, its replacement
    // never landed, and current.json still names the hash.
    renameSync(path.join(graphifyRoot(), hash), path.join(graphifyRoot(), `${hash}.replaced-cafebabe`));
    expect(existsSync(path.join(graphifyRoot(), hash))).toBe(false);
    const status = await componentStatus(env);
    expect(status.state).toBe("installed");
    expect(existsSync(path.join(graphifyRoot(), hash, "graphify"))).toBe(true);
    expect(componentBin("graphify", env)).toBe(path.join(graphifyRoot(), hash, "graphify"));
  });

  test("a fresh empty lock owner is a legacy leftover and is taken over, not treated as live", async () => {
    mkdirSync(graphifyRoot(), { recursive: true });
    const file = path.join(graphifyRoot(), ".install.lock");
    // Current code never creates an empty record (the owner is linked complete), so an
    // empty file can only be a leftover: the atomic takeover protocol claims it.
    writeFileSync(file, "");
    const { release } = await acquireInstallLock(graphifyRoot());
    expect(readFileSync(file, "utf8")).toMatch(new RegExp(`^${process.pid}:`));
    await release();
    expect(existsSync(file)).toBe(false);
  });

  test("a lock owned by a live process is respected; a dead owner's lock is taken over", async () => {
    mkdirSync(graphifyRoot(), { recursive: true });
    const file = path.join(graphifyRoot(), ".install.lock");
    writeFileSync(file, String(process.pid));
    await expect(acquireInstallLock(graphifyRoot())).rejects.toThrow(/already running/);
    expect(readFileSync(file, "utf8")).toBe(String(process.pid));
    // A PID above the kernel's maximum can never be a live process.
    writeFileSync(file, String(2 ** 22 + 123_456));
    const { release } = await acquireInstallLock(graphifyRoot());
    await release();
    expect(existsSync(file)).toBe(false);
  });

  test("releasing a lock never removes a successor's lock", async () => {
    mkdirSync(graphifyRoot(), { recursive: true });
    const file = path.join(graphifyRoot(), ".install.lock");
    const { release } = await acquireInstallLock(graphifyRoot());
    // A successor took the lock over (the holder's record was replaced out from under it).
    writeFileSync(file, `${process.pid}:successor-token`);
    await release();
    expect(readFileSync(file, "utf8")).toBe(`${process.pid}:successor-token`);
  });

  test("two contenders racing for the lock leave exactly one holder", async () => {
    mkdirSync(graphifyRoot(), { recursive: true });
    const results = await Promise.allSettled([acquireInstallLock(graphifyRoot()), acquireInstallLock(graphifyRoot())]);
    const winners = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ release: () => Promise<void>; token: string }>[];
    const losers = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0]?.reason as Error).message).toMatch(/already running/);
    await winners[0]!.value.release();
    expect(existsSync(path.join(graphifyRoot(), ".install.lock"))).toBe(false);
  });

  test("two takers racing a stale lock leave exactly one holder", async () => {
    for (let round = 0; round < 5; round++) {
      mkdirSync(graphifyRoot(), { recursive: true });
      const file = path.join(graphifyRoot(), ".install.lock");
      writeFileSync(file, String(2 ** 22 + 123_456));
      const results = await Promise.allSettled([acquireInstallLock(graphifyRoot()), acquireInstallLock(graphifyRoot())]);
      const winners = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ release: () => Promise<void>; token: string }>[];
      const losers = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect((losers[0]?.reason as Error).message).toMatch(/already running/);
      await winners[0]!.value.release();
      expect(existsSync(file)).toBe(false);
      rmSync(graphifyRoot(), { recursive: true, force: true });
    }
  });

  test("a holder displaced by the takeover race fails its ownership check", async () => {
    mkdirSync(graphifyRoot(), { recursive: true });
    const file = path.join(graphifyRoot(), ".install.lock");
    const holder = await acquireInstallLock(graphifyRoot());
    // Replay the takeover interleave: a taker moves the holder's record aside while a
    // third installer claims the freed path; the taker's non-replacing restore refuses
    // to clobber the new claim, so the holder's record is stranded.
    renameSync(file, `${file}.stale-test`);
    const successor = await acquireInstallLock(graphifyRoot());
    await expect(verifyLockHeld(graphifyRoot(), holder.token)).rejects.toThrow(/Lost the component install lock/);
    await expect(verifyLockHeld(graphifyRoot(), successor.token)).resolves.toBeUndefined();
    // The displaced holder's release must not remove the successor's lock.
    await holder.release();
    expect(readFileSync(file, "utf8")).toBe(successor.token);
    await successor.release();
    expect(existsSync(file)).toBe(false);
  });
});
