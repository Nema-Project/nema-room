// Installer tests against a local fake upstream reached only through the mirror variables. The fake
// python is a shell script, so the suite runs on POSIX; Windows uses the shipped launcher binary.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { activate, acquireInstallLock, installComponent, takeOverStaleLock, verifyArchives, verifyLockHeld, type InstallOptions } from "../../src/components/install.js";
import { lockHash } from "../../src/components/lock.js";
import { acquireInstallLockSync, componentBin, componentStatus, installLockHeldByLiveOwner, readFailure, readInstallGeneration, readInstallLockToken, readPointer, recoverReplacementsSync, writeFailure, writeFileAtomic, writePointer, type ComponentEnv } from "../../src/components/store.js";
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
    expect(readdirSync(graphifyRoot()).sort()).toEqual(["current.json", "install-generation", "install-generation-high-water", hash].sort());
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
    const status = await install(newEnv, { signal: controller.signal }).catch((error: unknown) => error);
    // A cancel throws the abort error instead of resolving with a status a caller could read as
    // the outcome; the store is exactly as it was before the attempt.
    expect(status).toBeInstanceOf(Error);
    expect((status as Error).name).toBe("AbortError");
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
    let renames = 0;
    const reinstall = install(env, {
      force: true,
      hooks: {
        rename: async () => {
          renames += 1;
          if (renames === 2) {
            // Pause before the placement: the active directory is aside as a backup and
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

  test("activation aborts when its lock is displaced, leaving the placed tree and the replaced copy untouched", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const env = envFor(component, source);
    expect((await install(env)).state).toBe("installed");
    const hash = lockHash(component.target);
    writeFileSync(path.join(graphifyRoot(), hash, "python", "bin", "python3.11"), "tampered\n");
    const atFirstMove = deferred();
    const releaseMove = deferred();
    let renames = 0;
    const reinstall = install(env, {
      force: true,
      hooks: {
        rename: async () => {
          renames += 1;
          if (renames === 1) {
            // Pause before the first move: the displacement below lands while the
            // active directory is still in place, and the re-validation between the
            // two moves catches it — the placement never runs.
            atFirstMove.resolve();
            await releaseMove.promise;
          }
        },
      },
    });
    await atFirstMove.promise;
    // Displace the installer's lock before activation's first move, as the takeover race
    // does: its record is moved aside and another installer claims the freed path. The
    // displacing token carries a live pid, so later recovery is skipped while it is held.
    const lockFile = path.join(graphifyRoot(), ".install.lock");
    renameSync(lockFile, `${lockFile}.stale-test`);
    writeFileSync(lockFile, `${process.pid}:foreign`);
    releaseMove.resolve();
    // The attempt reports its failure (its failure record is what shows the abort). But the
    // displaced attempt rolls nothing back: once its lock is gone, the tree it was placing may
    // already be the successor's published runtime, so the shared directory is left to the
    // successor or to recovery under the install lock. The displacement landed before the
    // first move, so the re-validation between the two moves caught it: the active
    // directory is missing and the replaced copy waits as a backup; while the successor's
    // lock is held, recovery stays skipped and the status surfaces the recorded failure.
    expect(await reinstall).toMatchObject({ state: "failed", reason: "self-check", lockHash: hash });
    expect(await componentStatus(env)).toMatchObject({ state: "failed", reason: "self-check" });
    expect(readFailure(graphifyRoot())).toMatchObject({ reason: "self-check", lockHash: hash });
    expect(existsSync(path.join(graphifyRoot(), hash))).toBe(false);
    const backups = readdirSync(graphifyRoot()).filter((name) => name.includes(".replaced-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(graphifyRoot(), backups[0]!, "python", "bin", "python3.11"), "utf8")).toBe("tampered\n");
    // Once the successor's lock is gone, recovery restores the replaced copy and the store
    // serves the previous version again.
    rmSync(lockFile);
    expect(await componentStatus(env)).toMatchObject({ state: "installed", lastFailure: { reason: "self-check" } });
    expect(readFileSync(path.join(graphifyRoot(), hash, "python", "bin", "python3.11"), "utf8")).toBe("tampered\n");
    expect(readdirSync(graphifyRoot()).filter((name) => name.includes(".replaced-"))).toEqual([]);
  });

  test("activation rolls back its own cancellation but not a displacement", async () => {
    const hash = "a".repeat(64);
    const setup = async (failWith: () => Error) => {
      const dir = mkdtempSync(path.join(root, "activate-"));
      const final = path.join(dir, hash);
      mkdirSync(final, { recursive: true });
      writeFileSync(path.join(final, "marker"), "old\n");
      await writePointer(dir, { active: hash, previous: null });
      const staging = path.join(dir, "staging");
      mkdirSync(staging, { recursive: true });
      writeFileSync(path.join(staging, "marker"), "new\n");
      let calls = 0;
      const verifyLockHeld = async () => {
        calls += 1;
        // The entry and between-moves checks pass; the checked-point check fails.
        if (calls >= 3) throw failWith();
      };
      await expect(activate(dir, hash, staging, { verifyLockHeld })).rejects.toThrow();
      return { dir, final };
    };
    // Cancellation: the attempt still owns the tree, so the backup is restored.
    const cancelled = await setup(() => Object.assign(new Error("aborted"), { name: "AbortError" }));
    expect(readFileSync(path.join(cancelled.final, "marker"), "utf8")).toBe("old\n");
    expect(readdirSync(cancelled.dir).filter((name) => name.includes(".replaced-"))).toEqual([]);
    // Displacement: the lock is gone, so the placed tree and the backup stay untouched.
    const displaced = await setup(() => new Error("Lost the component install lock to another installer; aborting the install"));
    expect(readFileSync(path.join(displaced.final, "marker"), "utf8")).toBe("new\n");
    expect(readdirSync(displaced.dir).filter((name) => name.includes(".replaced-"))).toHaveLength(1);
  });

  test("a cancellation after a successor claimed the lock does not remove the successor's tree", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const env = envFor(component, source);
    expect((await install(env)).state).toBe("installed");
    const hash = lockHash(component.target);
    writeFileSync(path.join(graphifyRoot(), hash, "python", "bin", "python3.11"), "tampered\n");
    const controller = new AbortController();
    const atFirstMove = deferred();
    const releaseMove = deferred();
    let renames = 0;
    const reinstall = install(env, {
      force: true,
      signal: controller.signal,
      hooks: {
        rename: async () => {
          renames += 1;
          if (renames === 2) {
            // Pause before the placement: the active directory is aside as a backup and
            // the replacement is not placed yet.
            atFirstMove.resolve();
            await releaseMove.promise;
          }
        },
      },
    }).catch((error: unknown) => error);
    await atFirstMove.promise;
    // The successor claims the lock and publishes its own tree before this attempt is
    // cancelled: the lock file carries a live pid and the active directory holds the
    // successor's copy (the staging tree, still unpublished by this attempt).
    const lockFile = path.join(graphifyRoot(), ".install.lock");
    renameSync(lockFile, `${lockFile}.stale-test`);
    writeFileSync(lockFile, `${process.pid}:foreign`);
    cpSync(path.join(graphifyRoot(), `${hash}.staging`), path.join(graphifyRoot(), hash), { recursive: true });
    controller.abort();
    releaseMove.resolve();
    const outcome = await reinstall;
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).name).toBe("AbortError");
    // The attempt is a cancellation, not a failure: no record is written, and the
    // successor's tree — the one the pointer names — is untouched, with the replaced copy
    // still aside for recovery once the successor's lock is gone.
    expect(readFailure(graphifyRoot())).toBeNull();
    expect(readFileSync(path.join(graphifyRoot(), hash, "python", "bin", "python3.11"), "utf8")).not.toBe("tampered\n");
    const backups = readdirSync(graphifyRoot()).filter((name) => name.includes(".replaced-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(graphifyRoot(), backups[0]!, "python", "bin", "python3.11"), "utf8")).toBe("tampered\n");
  });

  test("a displacement after the ownership read does not let rollback remove the successor's tree", async () => {
    const hash = "a".repeat(64);
    const dir = mkdtempSync(path.join(root, "activate-"));
    const final = path.join(dir, hash);
    mkdirSync(final, { recursive: true });
    writeFileSync(path.join(final, "marker"), "old\n");
    await writePointer(dir, { active: hash, previous: null });
    const staging = path.join(dir, "staging");
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, "marker"), "new\n");
    // The ownership read (the checked-point check) succeeds, then a successor displaces the
    // attempt and publishes its own tree before the rollback's re-check.
    let calls = 0;
    let displaced = false;
    const atOwnershipRead = deferred();
    const releaseOwnershipRead = deferred();
    const verifyLockHeld = async () => {
      calls += 1;
      if (calls === 3) {
        // The checked-point check: the lock read passes, then the cancel lands.
        atOwnershipRead.resolve();
        await releaseOwnershipRead.promise;
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }
      if (displaced) throw new Error("Lost the component install lock to another installer; aborting the install");
    };
    const outcome = activate(dir, hash, staging, { verifyLockHeld }).catch((error: unknown) => error);
    await atOwnershipRead.promise;
    // The successor publishes its tree at the active directory while this attempt is paused
    // between its ownership read and its rollback.
    rmSync(final, { recursive: true, force: true });
    mkdirSync(final, { recursive: true });
    writeFileSync(path.join(final, "marker"), "successor\n");
    displaced = true;
    releaseOwnershipRead.resolve();
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("AbortError");
    // The rollback was skipped: the successor's tree stands, the backup stays aside for
    // recovery, and the pointer still names the hash.
    expect(readFileSync(path.join(final, "marker"), "utf8")).toBe("successor\n");
    const backups = readdirSync(dir).filter((name) => name.includes(".replaced-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(dir, backups[0]!, "marker"), "utf8")).toBe("old\n");
    expect(readPointer(dir).active).toBe(hash);
  });

  test("a displacement after the final ownership read does not let rollback move the backup over the successor's tree", async () => {
    const hash = "a".repeat(64);
    const successorHash = "b".repeat(64);
    const dir = mkdtempSync(path.join(root, "activate-"));
    const final = path.join(dir, hash);
    mkdirSync(final, { recursive: true });
    writeFileSync(path.join(final, "marker"), "old\n");
    await writePointer(dir, { active: hash, previous: null });
    const staging = path.join(dir, "staging");
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, "marker"), "new\n");
    // The final ownership read (call 4) passes; the removal's pre-check (call 5) is
    // where the attempt is paused — the lock is lost before the removal moves anything,
    // so the placed tree stays in place.
    let calls = 0;
    let displaced = false;
    const atPreMoveRead = deferred();
    const releasePreMoveRead = deferred();
    const verifyLockHeld = async () => {
      calls += 1;
      if (calls === 3) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      if (calls === 5) {
        atPreMoveRead.resolve();
        await releasePreMoveRead.promise;
      }
      if (displaced) throw new Error("Lost the component install lock to another installer; aborting the install");
    };
    const outcome = activate(dir, hash, staging, { verifyLockHeld }).catch((error: unknown) => error);
    await atPreMoveRead.promise;
    // A successor displaces the attempt and publishes its tree while the re-check is paused.
    mkdirSync(final, { recursive: true });
    writeFileSync(path.join(final, "marker"), "successor\n");
    await writePointer(dir, { active: successorHash, previous: hash });
    displaced = true;
    releasePreMoveRead.resolve();
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("AbortError");
    // The restore move was skipped and the removal never moved the placed tree: the
    // successor's tree stands (its marker overwrote the placed tree's in place), the
    // backup stays aside for recovery, and the pointer still names the successor.
    expect(readFileSync(path.join(final, "marker"), "utf8")).toBe("successor\n");
    const backups = readdirSync(dir).filter((name) => name.includes(".replaced-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(dir, backups[0]!, "marker"), "utf8")).toBe("old\n");
    expect(readPointer(dir).active).toBe(successorHash);
  });

  test("a takeover delayed after its ownership read does not let rollback move the backup over the successor's tree", async () => {
    const hash = "a".repeat(64);
    const dir = mkdtempSync(path.join(root, "activate-"));
    const final = path.join(dir, hash);
    mkdirSync(final, { recursive: true });
    writeFileSync(path.join(final, "marker"), "old\n");
    await writePointer(dir, { active: hash, previous: null });
    const staging = path.join(dir, "staging");
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, "marker"), "new\n");
    // The holder's activation is cancelled at its checked point; its rollback is paused
    // at the removal's pre-check, after the final ownership read passed — the lock is
    // lost before the removal moves anything.
    let calls = 0;
    let displaced = false;
    const atPreMoveRead = deferred();
    const releasePreMoveRead = deferred();
    const verifyLockHeld = async () => {
      calls += 1;
      if (calls === 3) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      if (calls === 5) {
        atPreMoveRead.resolve();
        await releasePreMoveRead.promise;
      }
      if (displaced) throw new Error("Lost the component install lock to another installer; aborting the install");
    };
    const outcome = activate(dir, hash, staging, { verifyLockHeld }).catch((error: unknown) => error);
    await atPreMoveRead.promise;
    // A stale lock for the takeover to judge: a contender reads it and pauses before its
    // rename, after the pre-rename re-validation.
    const lockFile = path.join(dir, ".install.lock");
    writeFileSync(lockFile, String(2 ** 22 + 123_456));
    const atRename = deferred();
    const releaseRename = deferred();
    const afterRename = deferred();
    const releaseAfterRename = deferred();
    let renamed = false;
    const renameFile = async (from: string, to: string) => {
      if (!renamed) {
        atRename.resolve();
        await releaseRename.promise;
        await rename(from, to);
        renamed = true;
        afterRename.resolve();
        await releaseAfterRename.promise;
      } else {
        await rename(from, to);
      }
    };
    const takeover = takeOverStaleLock(lockFile, { content: String(2 ** 22 + 123_456), ino: 0, mtimeMs: 0 }, renameFile);
    await atRename.promise;
    // Another contender replaces the record with a live holder's claim.
    const live = await acquireInstallLock(dir);
    // The delayed rename moves the live claim aside.
    releaseRename.resolve();
    await afterRename.promise;
    // A successor claims the vacant path and publishes its tree while the takeover's
    // restore is still paused. It is a same-version repair, so its tree is the same final
    // directory and the pointer still names that lock-hash.
    const successor = await acquireInstallLock(dir);
    mkdirSync(final, { recursive: true });
    writeFileSync(path.join(final, "marker"), "successor\n");
    await writePointer(dir, { active: hash, previous: null });
    releaseAfterRename.resolve();
    expect(await takeover).toBeNull();
    // The takeover's restore could not put the live claim back (the successor's claim is
    // in place); the holder's rollback resumes and must skip the restore move. The
    // removal's pre-check already failed, so the placed tree was never moved aside.
    displaced = true;
    releasePreMoveRead.resolve();
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("AbortError");
    expect(readFileSync(path.join(final, "marker"), "utf8")).toBe("successor\n");
    const backups = readdirSync(dir).filter((name) => name.includes(".replaced-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(dir, backups[0]!, "marker"), "utf8")).toBe("old\n");
    expect(readPointer(dir).active).toBe(hash);
    // The successor's lock is live while its tree stands.
    expect(readInstallLockToken(dir)).toBe(successor.token);
    await successor.release();
    await live.release();
  });

  test("a takeover and publication after the final ownership check does not let rollback replace the successor's tree", async () => {
    const hash = "a".repeat(64);
    const dir = mkdtempSync(path.join(root, "activate-"));
    const final = path.join(dir, hash);
    mkdirSync(final, { recursive: true });
    writeFileSync(path.join(final, "marker"), "old\n");
    await writePointer(dir, { active: hash, previous: null });
    const staging = path.join(dir, "staging");
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, "marker"), "new\n");
    // The holder's activation is cancelled at its checked point. Its rollback passes the
    // final ownership check and pauses at the restore move, after the check returned — the
    // check and the mutation are separated by the move's own hook.
    let calls = 0;
    const verifyLockHeld = async () => {
      calls += 1;
      if (calls === 3) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    };
    // The restore move is the fourth rename (final -> backup, staging -> final, final ->
    // trash for the inode-verified removal of the placed tree, backup -> final).
    let renames = 0;
    const atRestoreMove = deferred();
    const releaseRestoreMove = deferred();
    const renameHook = async (from: string, to: string) => {
      renames += 1;
      if (renames === 4) {
        atRestoreMove.resolve();
        await releaseRestoreMove.promise;
      }
    };
    const outcome = activate(dir, hash, staging, { verifyLockHeld, rename: renameHook }).catch((error: unknown) => error);
    await atRestoreMove.promise;
    // A delayed stale-lock takeover moves the holder's (dead) record aside, and a successor
    // claims the vacant path and publishes the same final directory while the rollback is
    // paused at the move. It is a same-version repair, so its tree is the same final
    // directory and the pointer still names that lock-hash.
    const lockFile = path.join(dir, ".install.lock");
    writeFileSync(lockFile, String(2 ** 22 + 123_456));
    const stale = await takeOverStaleLock(lockFile, { content: String(2 ** 22 + 123_456), ino: 0, mtimeMs: 0 });
    expect(stale).not.toBeNull();
    const successor = await acquireInstallLock(dir);
    mkdirSync(final, { recursive: true });
    writeFileSync(path.join(final, "marker"), "successor\n");
    await writePointer(dir, { active: hash, previous: null });
    // The restore move resumes: renaming the backup over the successor's non-empty tree
    // fails, so the rollback cannot replace it — and the failure is the install's outcome,
    // not a deleted successor.
    releaseRestoreMove.resolve();
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect(readFileSync(path.join(final, "marker"), "utf8")).toBe("successor\n");
    expect(readPointer(dir).active).toBe(hash);
    // The successor's lock is live while its tree stands.
    expect(readInstallLockToken(dir)).toBe(successor.token);
    await successor.release();
    // The backup stays aside for recovery: the rollback could not restore it.
    const backups = readdirSync(dir).filter((name) => name.includes(".replaced-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(dir, backups[0]!, "marker"), "utf8")).toBe("old\n");
  });

  test("a successor publishing after the final ownership check does not lose its tree to the rollback's removal", async () => {
    const hash = "b".repeat(64);
    const dir = mkdtempSync(path.join(root, "activate-"));
    const final = path.join(dir, hash);
    const staging = path.join(dir, "staging");
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, "marker"), "new\n");
    // The placement's checked point fails. The rollback passes its ownership checks and
    // pauses at the removal itself — the second rename (staging -> final, then final ->
    // trash for the verified removal) — after the final check returned.
    let renames = 0;
    const atRemoval = deferred();
    const releaseRemoval = deferred();
    const renameHook = async (from: string, to: string) => {
      renames += 1;
      if (renames === 2) {
        atRemoval.resolve();
        await releaseRemoval.promise;
      }
    };
    const outcome = activate(dir, hash, staging, {
      verifyLockHeld: async () => {},
      writePointer: async () => {
        throw new Error("pointer write failed");
      },
      rename: renameHook,
    }).catch((error: unknown) => error);
    await atRemoval.promise;
    // A successor publishes the same directory while the rollback is paused at the
    // removal: it moves the placed tree aside as its backup, places its own tree, and
    // points at it.
    const successorBackup = path.join(dir, `${hash}.replaced-succ`);
    renameSync(final, successorBackup);
    const successorStaging = path.join(dir, "staging2");
    mkdirSync(successorStaging, { recursive: true });
    writeFileSync(path.join(successorStaging, "marker"), "successor\n");
    renameSync(successorStaging, final);
    await writePointer(dir, { active: hash, previous: null });
    // The removal resumes: it renames the successor's tree aside, finds its inode is not
    // the staging directory this attempt placed, and renames it back — the successor's
    // tree is never deleted.
    releaseRemoval.resolve();
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect(readFileSync(path.join(final, "marker"), "utf8")).toBe("successor\n");
    expect(readPointer(dir).active).toBe(hash);
    // The placed tree survives as the successor's backup, and the removal left no trash.
    expect(readFileSync(path.join(successorBackup, "marker"), "utf8")).toBe("new\n");
    expect(readdirSync(dir).filter((name) => name.includes(".replaced-"))).toEqual([`${hash}.replaced-succ`]);
  });

  test("a successor reusing the placed tree after the final ownership check does not lose it to the rollback's removal", async () => {
    const hash = "e".repeat(64);
    const dir = mkdtempSync(path.join(root, "activate-"));
    const final = path.join(dir, hash);
    const staging = path.join(dir, "staging");
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, "marker"), "new\n");
    // The rollback attempt holds a real lock, and its ownership check reads the lock
    // file: it passes only while its own token is still there.
    const holder = await acquireInstallLock(dir);
    const verifyLockHeld = async () => {
      if (readInstallLockToken(dir) !== holder.token) throw new Error("lock lost");
    };
    // The placement's checked point fails. The rollback passes its ownership checks and
    // pauses at the removal itself — the second rename — after the final check returned.
    let renames = 0;
    const atRemoval = deferred();
    const releaseRemoval = deferred();
    const renameHook = async (from: string, to: string) => {
      renames += 1;
      if (renames === 2) {
        atRemoval.resolve();
        await releaseRemoval.promise;
      }
    };
    const outcome = activate(dir, hash, staging, {
      verifyLockHeld,
      writePointer: async () => {
        throw new Error("pointer write failed");
      },
      rename: renameHook,
    }).catch((error: unknown) => error);
    await atRemoval.promise;
    // A successor displaces the holder's lock the way a delayed takeover's rename does
    // — the lock file is moved aside after the check — claims the vacant path, and
    // reuses the placed tree: its staging is byte-identical, so it publishes a pointer
    // to the same directory instead of replacing it.
    renameSync(path.join(dir, ".install.lock"), path.join(dir, ".install.lock.displaced"));
    const successor = await acquireInstallLock(dir);
    await writePointer(dir, { active: hash, previous: null });
    // The removal resumes: it renames the tree aside and the inode still matches, but
    // the lock is lost, so the tree goes back — it is the successor's published runtime.
    releaseRemoval.resolve();
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect(readFileSync(path.join(final, "marker"), "utf8")).toBe("new\n");
    expect(readPointer(dir).active).toBe(hash);
    // The successor's lock is live while its tree stands, and the removal left no trash.
    expect(readInstallLockToken(dir)).toBe(successor.token);
    expect(readdirSync(dir).filter((name) => name.includes(".replaced-"))).toEqual([]);
    // The holder's release is token-verified: it must not remove the successor's claim.
    await holder.release();
    expect(readInstallLockToken(dir)).toBe(successor.token);
    await successor.release();
  });

  test("a successor that published before the removal's pre-check keeps its tree and launcher", async () => {
    const component = fakeComponent(execLog);
    const hash = lockHash(component.target);
    const dir = graphifyRoot();
    mkdirSync(dir, { recursive: true });
    const final = path.join(dir, hash);
    const staging = path.join(dir, "staging");
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, "marker"), "new\n");
    writeFileSync(path.join(staging, "graphify"), "#!/bin/sh\necho graphify\n");
    const lockPath = writeLock(path.join(root, "lock.json"), component);
    const env = { runtimeRoot, lockPath, platform: { platform: process.platform, arch: process.arch, musl: false } };
    // The rollback attempt holds a real lock. Its ownership check pauses at the first
    // re-verification after the placement (ownsTree) — the gate that runs before the
    // removal's pre-check — so a successor can publish while the rollback is paused.
    const holder = await acquireInstallLock(dir);
    let calls = 0;
    const atOwnership = deferred();
    const releaseOwnership = deferred();
    const verifyLockHeld = async () => {
      calls += 1;
      if (calls === 3) {
        atOwnership.resolve();
        await releaseOwnership.promise;
      }
      if (readInstallLockToken(dir) !== holder.token) throw new Error("lock lost");
    };
    let renames = 0;
    const renameHook = async (from: string, to: string) => {
      renames += 1;
    };
    const outcome = activate(dir, hash, staging, {
      verifyLockHeld,
      writePointer: async () => {
        throw new Error("pointer write failed");
      },
      rename: renameHook,
    }).catch((error: unknown) => error);
    await atOwnership.promise;
    // A successor displaces the holder's lock the way a delayed takeover's rename
    // does, claims the vacant path, and reuses the placed tree: its staging is
    // byte-identical, so it publishes a pointer to the same directory.
    renameSync(path.join(dir, ".install.lock"), path.join(dir, ".install.lock.displaced"));
    const successor = await acquireInstallLock(dir);
    await writePointer(dir, { active: hash, previous: null });
    // While the rollback is paused and the successor's lock is live, the tree, the
    // pointer and the launcher all stand: the ownership check fails on resume, so
    // the removal never runs and the rename-aside never happens.
    expect(readPointer(dir).active).toBe(hash);
    expect(componentBin("graphify", env)).toBe(path.join(final, "graphify"));
    expect(readInstallLockToken(dir)).toBe(successor.token);
    expect(renames).toBe(1);
    releaseOwnership.resolve();
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect(readFileSync(path.join(final, "marker"), "utf8")).toBe("new\n");
    expect(readPointer(dir).active).toBe(hash);
    expect(componentBin("graphify", env)).toBe(path.join(final, "graphify"));
    expect(readdirSync(dir).filter((name) => name.includes(".replaced-"))).toEqual([]);
    expect(renames).toBe(1);
    await holder.release();
    expect(readInstallLockToken(dir)).toBe(successor.token);
    await successor.release();
  });

  test("a successor that published between the pre-check and the rename-aside leaves the tree in place", async () => {
    const component = fakeComponent(execLog);
    const hash = lockHash(component.target);
    const dir = graphifyRoot();
    mkdirSync(dir, { recursive: true });
    const final = path.join(dir, hash);
    const staging = path.join(dir, "staging");
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, "marker"), "new\n");
    writeFileSync(path.join(staging, "graphify"), "#!/bin/sh\necho graphify\n");
    const lockPath = writeLock(path.join(root, "lock.json"), component);
    const env = { runtimeRoot, lockPath, platform: { platform: process.platform, arch: process.arch, musl: false } };
    // The rollback attempt holds a real lock. The removal passes its pre-check, then
    // pauses at the rename-aside seam. A successor publishes during the pause — directly,
    // bypassing the tree mutex the way a pre-change binary would (it does not know
    // about the mutex): the re-check after the seam is what catches it, so the
    // rename-aside is skipped and the published tree stays in place. An in-protocol
    // successor (through activate) cannot publish here at all — it waits for the mutex,
    // which the next test covers. The post-rename re-verification stays as defense in
    // depth for a publication that lands after the re-check but before the rename.
    const holder = await acquireInstallLock(dir);
    let calls = 0;
    const atPostCheck = deferred();
    const releasePostCheck = deferred();
    const verifyLockHeld = async () => {
      calls += 1;
      if (calls === 6) {
        atPostCheck.resolve();
        await releasePostCheck.promise;
      }
      if (readInstallLockToken(dir) !== holder.token) throw new Error("lock lost");
    };
    let renames = 0;
    const atAside = deferred();
    const releaseAside = deferred();
    const renameHook = async (from: string, to: string) => {
      renames += 1;
      if (renames === 2) {
        atAside.resolve();
        await releaseAside.promise;
      }
    };
    const outcome = activate(dir, hash, staging, {
      verifyLockHeld,
      writePointer: async () => {
        throw new Error("pointer write failed");
      },
      rename: renameHook,
    }).catch((error: unknown) => error);
    await atAside.promise;
    renameSync(path.join(dir, ".install.lock"), path.join(dir, ".install.lock.displaced"));
    const successor = await acquireInstallLock(dir);
    await writePointer(dir, { active: hash, previous: null });
    releaseAside.resolve();
    // At the re-check after the seam, while the successor's lock is live: the
    // rename-aside has not run yet, so the successor's published tree is still in
    // place and the launcher is available — the window the pre-check cannot close
    // for a publication that bypassed the mutex. The re-check is what closes it.
    await atPostCheck.promise;
    expect(readPointer(dir).active).toBe(hash);
    expect(componentBin("graphify", env)).toBe(path.join(final, "graphify"));
    expect(readInstallLockToken(dir)).toBe(successor.token);
    releasePostCheck.resolve();
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect(readFileSync(path.join(final, "marker"), "utf8")).toBe("new\n");
    expect(readPointer(dir).active).toBe(hash);
    expect(componentBin("graphify", env)).toBe(path.join(final, "graphify"));
    expect(readdirSync(dir).filter((name) => name.includes(".replaced-"))).toEqual([]);
    await holder.release();
    expect(readInstallLockToken(dir)).toBe(successor.token);
    await successor.release();
  });

  test("a successor activating while the rollback holds the tree mutex waits, then publishes cleanly", async () => {
    const component = fakeComponent(execLog);
    const hash = lockHash(component.target);
    const dir = graphifyRoot();
    mkdirSync(dir, { recursive: true });
    const final = path.join(dir, hash);
    const staging = path.join(dir, "staging");
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, "marker"), "new\n");
    writeFileSync(path.join(staging, "graphify"), "#!/bin/sh\necho graphify\n");
    const successorStaging = path.join(dir, "staging-successor");
    mkdirSync(successorStaging, { recursive: true });
    writeFileSync(path.join(successorStaging, "marker"), "new\n");
    writeFileSync(path.join(successorStaging, "graphify"), "#!/bin/sh\necho graphify\n");
    const lockPath = writeLock(path.join(root, "lock.json"), component);
    const env = { runtimeRoot, lockPath, platform: { platform: process.platform, arch: process.arch, musl: false } };
    // The rollback attempt holds a real lock. Its removal pauses at the rename-aside
    // while holding the tree mutex; a successor activating in between must wait for
    // the mutex instead of publishing in the gap, so the rollback removes only its
    // own unpublished tree and the successor's tree is never moved aside.
    const holder = await acquireInstallLock(dir);
    const verifyLockHeld = async () => {
      if (readInstallLockToken(dir) !== holder.token) throw new Error("lock lost");
    };
    let renames = 0;
    const atAside = deferred();
    const releaseAside = deferred();
    const renameHook = async (from: string, to: string) => {
      renames += 1;
      if (renames === 2) {
        atAside.resolve();
        await releaseAside.promise;
      }
    };
    const outcome = activate(dir, hash, staging, {
      verifyLockHeld,
      writePointer: async () => {
        throw new Error("pointer write failed");
      },
      rename: renameHook,
    }).catch((error: unknown) => error);
    await atAside.promise;
    // The successor activates through the normal path (no hooks: it holds no install
    // lock). Its tree is at final, so it re-reads and then must wait for the tree
    // mutex before its sameTree check and pointer write.
    let successorDone = false;
    const successorOutcome = activate(dir, hash, successorStaging).then((result) => {
      successorDone = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(successorDone).toBe(false);
    // While the rollback is paused, the successor has not published: the version was
    // never active, so the launcher is unavailable — but nothing of the successor's
    // was moved aside either.
    expect(componentBin("graphify", env)).toBeNull();
    releaseAside.resolve();
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    // The rollback removed only its own unpublished tree (two renames: the placement
    // and the aside — no rename-back), and the successor then placed and published
    // its own staging cleanly.
    expect(await successorOutcome).toBe("replaced-orphan");
    expect(renames).toBe(2);
    expect(readFileSync(path.join(final, "marker"), "utf8")).toBe("new\n");
    expect(readPointer(dir).active).toBe(hash);
    expect(componentBin("graphify", env)).toBe(path.join(final, "graphify"));
    expect(readdirSync(dir).filter((name) => name.includes(".replaced-"))).toEqual([]);
    await holder.release();
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

  test("a forced reinstall while offline reports the attempt, not the installed copy", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const env = envFor(component, source);
    expect(await install(env)).toMatchObject({ state: "installed" });
    const requests = source.requests.length;
    const offline = envFor(component, source, { offline: true });
    // A plain install still has nothing to do; the repair is the one that must not read as done.
    expect(await install(offline)).toMatchObject({ state: "installed" });
    const attempt = await install(offline, { force: true });
    expect(attempt).toMatchObject({ state: "failed", reason: "offline", lockHash: lockHash(component.target) });
    expect(source.requests).toHaveLength(requests);
    // The installed status carries the failed attempt, so polling consumers see it too.
    expect(await componentStatus(offline)).toMatchObject({ state: "installed", lastFailure: { reason: "offline" } });
    expect(readPointer(graphifyRoot()).active).toBe(lockHash(component.target));
  });

  test("a lock that changed since the caller's confirmation is refused before any download", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const env = envFor(component, source);
    expect(await install(env, { expectedLockHash: "0".repeat(64) })).toMatchObject({ state: "failed", reason: "offer-changed", lockHash: lockHash(component.target) });
    expect(source.requests).toEqual([]);
    // The refusal is recorded, so status polling (which never sees the install's return value)
    // reports the confirm-again outcome too.
    expect(await componentStatus(env)).toMatchObject({ state: "failed", reason: "offer-changed" });
    expect(readFailure(graphifyRoot())).toMatchObject({ reason: "offer-changed", lockHash: lockHash(component.target) });
    expect(await install(env, { expectedLockHash: lockHash(component.target) })).toMatchObject({ state: "installed" });
  });

  test("a cancel after the staging move but before the pointer write removes the unpublished tree", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const env = envFor(component, source);
    const hash = lockHash(component.target);
    const controller = new AbortController();
    const status = await install(env, {
      signal: controller.signal,
      hooks: {
        rename: async (from, to) => {
          if (to === path.join(graphifyRoot(), hash)) controller.abort();
        },
      },
    }).catch((error: unknown) => error);
    expect(status).toBeInstanceOf(Error);
    expect((status as Error).name).toBe("AbortError");
    expect(existsSync(path.join(graphifyRoot(), hash))).toBe(false);
    expect(existsSync(path.join(graphifyRoot(), "current.json"))).toBe(false);
  });

  test("a cleanup error after the pointer commits still reports the install, and logs the cleanup failure", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const env = envFor(component, source);
    expect(await install(env)).toMatchObject({ state: "installed" });
    // A directory where the failure record belongs makes clearing it fail after activation commits.
    mkdirSync(path.join(graphifyRoot(), "last-failure.json"));
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      expect(await install(env, { force: true })).toMatchObject({ state: "installed" });
    } finally {
      console.error = original;
    }
    expect(logged).toHaveLength(1);
    expect(String(logged[0]![0])).toContain("cleanup failed");
    expect(readPointer(graphifyRoot()).active).toBe(lockHash(component.target));
  });

  test("a backup-removal error after the pointer commits still reports the install", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const env = envFor(component, source);
    const hash = lockHash(component.target);
    expect(await install(env)).toMatchObject({ state: "installed" });
    // Damage the installed tree so the reinstall replaces the referenced copy (the path whose
    // post-commit step removes the backup).
    writeFileSync(path.join(graphifyRoot(), hash, "python", "bin", "python3.11"), "tampered\n");
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      const status = await install(env, {
        force: true,
        hooks: {
          rm: async () => {
            throw new Error("injected: could not remove the replaced copy");
          },
        },
      });
      expect(status).toMatchObject({ state: "installed" });
    } finally {
      console.error = original;
    }
    expect(logged).toHaveLength(1);
    expect(String(logged[0]![0])).toContain("removing the replaced copy failed");
    expect(readPointer(graphifyRoot()).active).toBe(hash);
    // The leftover replaced copy does not linger either: the status read that produced the
    // result above ran the replacement recovery, which finishes the interrupted cleanup.
    expect(readdirSync(graphifyRoot()).some((name) => name.includes(".replaced-"))).toBe(false);
  });

  test("the generation advances when an install starts under the lock, even if it then fails", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const env = envFor(component, source);
    // No install yet: the counter does not exist, which reads as uninitialized — not as 0.
    expect(readInstallGeneration(graphifyRoot())).toBeNull();
    expect(await install(env)).toMatchObject({ state: "installed" });
    expect(readInstallGeneration(graphifyRoot())).toBe(1);
    // A same-version repair rewrites the pointer with identical content; the generation is
    // what still changes, so a refusal recorded from an earlier read can tell it happened.
    expect(await install(env, { force: true })).toMatchObject({ state: "installed" });
    expect(readInstallGeneration(graphifyRoot())).toBe(2);
    // A repair that fails after the claim still advanced the generation: the claim is what
    // marks the attempt, so a refusal snapshotted before it is suppressed even though the
    // repair never committed.
    const failing = await install(env, {
      force: true,
      hooks: {
        selfCheck: async () => {
          throw new Error("injected self-check failure");
        },
      },
    });
    expect(failing).toMatchObject({ state: "failed", reason: "self-check" });
    expect(readInstallGeneration(graphifyRoot())).toBe(3);
  });

  test("an existing but unreadable install generation throws instead of reading as uninitialized", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const env = envFor(component, source);
    expect(await install(env)).toMatchObject({ state: "installed" });
    writeFileSync(path.join(graphifyRoot(), "install-generation"), "not-a-number\n");
    expect(() => readInstallGeneration(graphifyRoot())).toThrow(/Invalid install generation/);
    // A directory at the counter's path is a read failure, not a missing counter.
    rmSync(path.join(graphifyRoot(), "install-generation"));
    mkdirSync(path.join(graphifyRoot(), "install-generation"));
    expect(() => readInstallGeneration(graphifyRoot())).toThrow();
  });

  test("a failed generation update cannot be reused by a later repair", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const env = envFor(component, source);
    expect(await install(env)).toMatchObject({ state: "installed" });
    expect(readInstallGeneration(graphifyRoot())).toBe(1);
    // The first repair's claim fails (sabotaged counter) and it aborts without committing.
    rmSync(path.join(graphifyRoot(), "install-generation"));
    mkdirSync(path.join(graphifyRoot(), "install-generation"));
    expect(await install(env, { force: true })).toMatchObject({ state: "failed", reason: "self-check" });
    // The counter is gone now, but the store still serves the installed copy: the next
    // repair must not restart the generation at 1 — a refusal snapshotted at 1 would
    // otherwise mistake the repaired store for the state it read.
    rmSync(path.join(graphifyRoot(), "install-generation"), { recursive: true });
    expect(await install(env, { force: true })).toMatchObject({ state: "installed" });
    const generation = readInstallGeneration(graphifyRoot());
    expect(generation).not.toBeNull();
    expect(generation!).toBeGreaterThan(1);
    // A second loss reseeds again — and the new value must be strictly greater than the
    // first reseed: the reseed is one past the highest generation ever claimed, so two
    // losses can never restore the same generation.
    const firstReseed = generation;
    rmSync(path.join(graphifyRoot(), "install-generation"), { force: true });
    expect(await install(env, { force: true })).toMatchObject({ state: "installed" });
    const secondReseed = readInstallGeneration(graphifyRoot());
    expect(secondReseed).not.toBeNull();
    expect(secondReseed!).toBeGreaterThan(firstReseed!);
    // Recording still works after the reseed: a fresh offline refusal is recorded, because
    // nothing intervened since its own snapshot.
    const offline = envFor(component, source, { offline: true });
    expect(await install(offline, { force: true })).toMatchObject({ state: "failed", reason: "offline" });
    expect(readFailure(graphifyRoot())).toMatchObject({ reason: "offline" });
  });

  test("an offline refusal does not overwrite a failure when a repair was in progress at its snapshot", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const env = envFor(component, source);
    expect(await install(env)).toMatchObject({ state: "installed" });
    // Seed the record a failed repair leaves behind.
    const failing = await install(env, {
      force: true,
      hooks: {
        selfCheck: async () => {
          throw new Error("injected self-check failure");
        },
      },
    });
    expect(failing).toMatchObject({ state: "failed", reason: "self-check" });
    // A repair in another process holds the lock while this attempt begins: it claimed its
    // generation before this attempt's snapshot, so the generation alone cannot tell the
    // attempt that a repair is running.
    const lockFile = path.join(graphifyRoot(), ".install.lock");
    writeFileSync(lockFile, `${process.pid}:repair`);
    const offline = envFor(component, source, { offline: true });
    // Start the refusal: its entry snapshot (generation, lock held) runs synchronously up
    // to the first await, so releasing the lock below lands between the snapshot and the write.
    const refusedPromise = install(offline, { force: true });
    // The repair commits and releases the lock in the meantime.
    rmSync(lockFile, { force: true });
    const refused = await refusedPromise;
    // The refusal still reaches its own caller, but it must not overwrite the record the
    // repair left: the generation matches, yet a repair was in progress at the snapshot.
    expect(refused).toMatchObject({ state: "failed", reason: "offline" });
    expect(readFailure(graphifyRoot())).toMatchObject({ reason: "self-check" });
  });

  test("an offline refusal delayed across a repair and a counter loss does not write a stale failure", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const env = envFor(component, source);
    expect(await install(env)).toMatchObject({ state: "installed" });
    // Seed the record a failed repair leaves behind.
    const failing = await install(env, {
      force: true,
      hooks: {
        selfCheck: async () => {
          throw new Error("injected self-check failure");
        },
      },
    });
    expect(failing).toMatchObject({ state: "failed", reason: "self-check" });
    const offline = envFor(component, source, { offline: true });
    // Start the refusal with no installer running: its entry snapshot (generation 2, no
    // live lock, the seeded record) runs synchronously up to the first await, so the
    // generation check alone must suppress the write — the live-lock guard cannot save it,
    // and the record is deliberately left alone so the record guard cannot save it either.
    // This case must fail if the generation comparison is removed.
    const refusedPromise = install(offline, { force: true });
    // The repair's counter file is lost and reseeded in the meantime: the writes below
    // stand in for the repair's claim, made synchronously so the interleaving is
    // deterministic.
    rmSync(path.join(graphifyRoot(), "install-generation"), { force: true });
    writeFileSync(path.join(graphifyRoot(), "install-generation"), "123456789\n");
    const refused = await refusedPromise;
    // The refusal still reaches its own caller, but it must not stamp the repaired store
    // with its failure: the generation changed.
    expect(refused).toMatchObject({ state: "failed", reason: "offline" });
    expect(readFailure(graphifyRoot())).toMatchObject({ reason: "self-check" });
  });

  test("a same-version repair that commits after an offline refusal's snapshot leaves no stale failure", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const env = envFor(component, source);
    expect(await install(env)).toMatchObject({ state: "installed" });
    // Seed the record a failed repair leaves behind.
    const failing = await install(env, {
      force: true,
      hooks: {
        selfCheck: async () => {
          throw new Error("injected self-check failure");
        },
      },
    });
    expect(failing).toMatchObject({ state: "failed", reason: "self-check" });
    // Start a real same-version repair; while it runs, an offline refusal begins. The
    // repair holds the lock until it commits and clears the record. The refusal waits
    // in beforeAcquire for the repair to commit before acquiring the lock: without
    // this, the two installs race for the lock and the repair's loss surfaces as an
    // unhandled rejection (the repair is only awaited after the refusal). The
    // refusal's entry snapshot is already taken before beforeAcquire, so the repair's
    // commit still lands after it.
    const repair = install(env, { force: true });
    const offline = envFor(component, source, { offline: true });
    const refused = await install(offline, {
      force: true,
      hooks: {
        beforeAcquire: async () => {
          await repair;
        },
      },
    });
    expect(await repair).toMatchObject({ state: "installed" });
    // The refusal still reaches its own caller, but the repair's cleared record stands:
    // the refusal never wrote a stale failure over it.
    expect(refused).toMatchObject({ state: "failed", reason: "offline" });
    expect(readFailure(graphifyRoot())).toBeNull();
  });

  test("a refusal paused after its snapshot does not write after a repair commits and clears the record", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const env = envFor(component, source);
    expect(await install(env)).toMatchObject({ state: "installed" });
    // Seed the record a failed repair leaves behind.
    const failing = await install(env, {
      force: true,
      hooks: {
        selfCheck: async () => {
          throw new Error("injected self-check failure");
        },
      },
    });
    expect(failing).toMatchObject({ state: "failed", reason: "self-check" });
    // A partial claim left the high-water ahead of the counter: the counter still reads 1,
    // the high-water reads 2. The writes below stand in for a claim whose counter write
    // failed after its high-water write.
    writeFileSync(path.join(graphifyRoot(), "install-generation"), "1\n");
    writeFileSync(path.join(graphifyRoot(), "install-generation-high-water"), "2\n");
    // A stale lock for the refusal's acquire to take over: the refusal pauses inside the
    // takeover, after its entry snapshot (generation 1, the seeded record, no live lock).
    const lockFile = path.join(graphifyRoot(), ".install.lock");
    writeFileSync(lockFile, String(2 ** 22 + 123_456));
    const atTakeover = deferred();
    const releaseTakeover = deferred();
    const offline = envFor(component, source, { offline: true });
    const refusedPromise = install(offline, {
      force: true,
      hooks: {
        renameLockFile: async (from, to) => {
          atTakeover.resolve();
          await releaseTakeover.promise;
          await rename(from, to);
        },
      },
    });
    await atTakeover.promise;
    // The counter is lost while the refusal is paused; a real same-version repair then
    // commits: it reseeds from the high-water (generation 3, not a reuse of 2) and clears
    // the record.
    rmSync(path.join(graphifyRoot(), "install-generation"), { force: true });
    expect(await install(env, { force: true })).toMatchObject({ state: "installed" });
    expect(readInstallGeneration(graphifyRoot())).toBe(3);
    expect(readFailure(graphifyRoot())).toBeNull();
    // Resume the refusal: it takes the released lock and reaches its recheck after the
    // repair's commit — the generation changed, so it must not write a stale failure.
    releaseTakeover.resolve();
    const refused = await refusedPromise;
    expect(refused).toMatchObject({ state: "failed", reason: "offline" });
    expect(readFailure(graphifyRoot())).toBeNull();
  });

  test("a refusal snapshotted while a repair runs does not write after the repair commits", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const env = envFor(component, source);
    expect(await install(env)).toMatchObject({ state: "installed" });
    // No failure record: the only guard that can suppress the write is the live-lock snapshot.
    expect(readFailure(graphifyRoot())).toBeNull();
    // Start a real same-version repair and pause it after its generation claim: the
    // claim's counter write is the last step before the first progress emit, so the
    // repair holds the lock and has claimed generation 2 while the status still reads
    // installed (no installing marker yet) — the refusal can then reach its offline branch.
    const atClaim = deferred();
    const releaseClaim = deferred();
    const repair = install(env, {
      force: true,
      hooks: {
        writeGenerationFile: async (file: string, body: string) => {
          await writeFileAtomic(file, body);
          if (path.basename(file) === "install-generation") {
            atClaim.resolve();
            await releaseClaim.promise;
          }
        },
      },
    });
    await atClaim.promise;
    expect(readInstallGeneration(graphifyRoot())).toBe(2);
    // Start the offline refusal: it snapshots generation 2, a live lock held, and no record,
    // then pauses before its lock acquisition.
    const atAcquire = deferred();
    const releaseAcquire = deferred();
    const offline = envFor(component, source, { offline: true });
    const refusedPromise = install(offline, {
      force: true,
      hooks: {
        beforeAcquire: async () => {
          atAcquire.resolve();
          await releaseAcquire.promise;
        },
      },
    });
    await atAcquire.promise;
    // Let the repair commit and release, then resume the refusal: it takes the free lock and
    // reaches its recheck with the generation unchanged (the repair claimed before the refusal
    // snapshotted it) and no record to compare — only the live-lock snapshot suppresses the
    // write. The repair runs as a separate installer in this process, not a separate OS
    // process: a child process's claim is not observable to the parent without a protocol
    // the CLI does not have, and the ordering the test enforces is the same.
    releaseClaim.resolve();
    expect(await repair).toMatchObject({ state: "installed" });
    releaseAcquire.resolve();
    const refused = await refusedPromise;
    expect(refused).toMatchObject({ state: "failed", reason: "offline" });
    expect(readFailure(graphifyRoot())).toBeNull();
  });

  test("a refusal snapshotted while a repair runs in another process does not write after the repair commits", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const env = envFor(component, source);
    expect(await install(env)).toMatchObject({ state: "installed" });
    // No failure record: the only guard that can suppress the write is the live-lock snapshot.
    expect(readFailure(graphifyRoot())).toBeNull();
    // Run the same-version repair in a child process. It pauses after its generation
    // claim (counter written, lock held, no progress emitted in this process — so the
    // status here still reads installed and the refusal can reach its offline branch),
    // coordinated by marker files; see the worker for the protocol.
    const controlDir = path.join(root, "child-control");
    mkdirSync(controlDir, { recursive: true });
    const resultFile = path.join(root, "child-result.json");
    const jobFile = path.join(root, "child-job.json");
    writeFileSync(jobFile, JSON.stringify({ runtimeRoot, lockPath: env.lockPath, envVars: env.env, controlDir, resultFile }));
    const worker = fileURLToPath(new URL("../fixtures/component-repair-worker.mjs", import.meta.url));
    const cliDir = fileURLToPath(new URL("../..", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx", worker, jobFile], { cwd: cliDir, stdio: ["ignore", "pipe", "pipe"] });
    let childErr = "";
    child.stderr!.on("data", (d) => (childErr += d));
    const childDone = new Promise<number | null>((resolve) => child.on("exit", resolve));
    const waitForFile = async (file: string) => {
      const end = Date.now() + 15_000;
      while (!existsSync(file)) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${file}; child stderr: ${childErr}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    try {
      await waitForFile(path.join(controlDir, "claimed"));
      expect(readInstallGeneration(graphifyRoot())).toBe(2);
      // The lock's owner is the child — a different PID, so this process's liveness
      // check takes the cross-process path; the same-PID shortcut cannot apply.
      expect(installLockHeldByLiveOwner(graphifyRoot())).toBe(true);
      // Start the offline refusal: it snapshots generation 2, a live lock held by the
      // child, and no record, then pauses before its lock acquisition.
      const atAcquire = deferred();
      const releaseAcquire = deferred();
      const offline = envFor(component, source, { offline: true });
      const refusedPromise = install(offline, {
        force: true,
        hooks: {
          beforeAcquire: async () => {
            atAcquire.resolve();
            await releaseAcquire.promise;
          },
        },
      });
      await atAcquire.promise;
      // Let the child repair commit in its own process, then resume the refusal: it
      // takes the released lock and reaches its recheck with the generation unchanged
      // and no record to compare — only the live-lock snapshot suppresses the write.
      writeFileSync(path.join(controlDir, "release"), "");
      await waitForFile(resultFile);
      expect(JSON.parse(readFileSync(resultFile, "utf8"))).toMatchObject({ state: "installed" });
      expect(await childDone).toBe(0);
      releaseAcquire.resolve();
      const refused = await refusedPromise;
      expect(refused).toMatchObject({ state: "failed", reason: "offline" });
      expect(readFailure(graphifyRoot())).toBeNull();
    } finally {
      // Never leave the child paused if an assertion failed first.
      writeFileSync(path.join(controlDir, "release"), "");
      child.kill();
    }
  });

  test("a refusal does not write after a real partial claim and a repair commit", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const env = envFor(component, source);
    expect(await install(env)).toMatchObject({ state: "installed" });
    // A real partial claim: a repair whose counter write fails after its high-water write.
    // The write seam fails only the counter file, so the high-water records 2 while the
    // counter stays at 1 — no hand-written claim state.
    const partial = await install(env, {
      force: true,
      hooks: {
        writeGenerationFile: async (file: string, body: string) => {
          if (path.basename(file) === "install-generation") throw new Error("injected counter write failure");
          await writeFileAtomic(file, body);
        },
      },
    });
    expect(partial).toMatchObject({ state: "failed", reason: "self-check" });
    expect(readInstallGeneration(graphifyRoot())).toBe(1);
    expect(readFileSync(path.join(graphifyRoot(), "install-generation-high-water"), "utf8").trim()).toBe("2");
    const recordAtSnapshot = readFailure(graphifyRoot())!;
    // A stale lock for the refusal's acquire to take over: the refusal pauses inside the
    // takeover, after its entry snapshot (generation 1, the claim failure's record, no live lock).
    const lockFile = path.join(graphifyRoot(), ".install.lock");
    writeFileSync(lockFile, String(2 ** 22 + 123_456));
    const atTakeover = deferred();
    const releaseTakeover = deferred();
    const offline = envFor(component, source, { offline: true });
    const refusedPromise = install(offline, {
      force: true,
      hooks: {
        renameLockFile: async (from, to) => {
          atTakeover.resolve();
          await releaseTakeover.promise;
          await rename(from, to);
        },
      },
    });
    await atTakeover.promise;
    // The counter is lost while the refusal is paused; a real same-version repair then
    // commits: it reseeds from the high-water (generation 3, not a reuse of 2) and clears
    // the record. The record is restored with its original revision so the record guard
    // passes at the refusal's recheck — the generation comparison is the only suppressor,
    // and removing it would let the refusal overwrite the restored record.
    rmSync(path.join(graphifyRoot(), "install-generation"), { force: true });
    expect(await install(env, { force: true })).toMatchObject({ state: "installed" });
    expect(readInstallGeneration(graphifyRoot())).toBe(3);
    expect(readFailure(graphifyRoot())).toBeNull();
    writeFileSync(path.join(graphifyRoot(), "last-failure.json"), `${JSON.stringify(recordAtSnapshot, null, 2)}\n`);
    // Resume the refusal: it takes the released lock and reaches its recheck after the
    // repair's commit — the generation changed, so it must not write a stale failure.
    releaseTakeover.resolve();
    const refused = await refusedPromise;
    expect(refused).toMatchObject({ state: "failed", reason: "offline" });
    expect(readFailure(graphifyRoot())).toEqual(recordAtSnapshot);
  });

  test("a claim whose high-water write fails leaves the counter unchanged", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const env = envFor(component, source);
    expect(await install(env)).toMatchObject({ state: "installed" });
    expect(readInstallGeneration(graphifyRoot())).toBe(1);
    // Sabotage the high-water file: the claim writes it first, so a failed write aborts
    // the attempt before the counter is touched.
    rmSync(path.join(graphifyRoot(), "install-generation-high-water"));
    mkdirSync(path.join(graphifyRoot(), "install-generation-high-water"));
    expect(await install(env, { force: true })).toMatchObject({ state: "failed", reason: "self-check" });
    expect(readInstallGeneration(graphifyRoot())).toBe(1);
    // And the counter still advances normally on the next repair.
    rmSync(path.join(graphifyRoot(), "install-generation-high-water"), { recursive: true });
    expect(await install(env, { force: true })).toMatchObject({ state: "installed" });
    expect(readInstallGeneration(graphifyRoot())).toBe(2);
  });

  test("an older refusal does not overwrite a failure recorded by a newer attempt", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const env = envFor(component, source);
    const hash = lockHash(component.target);
    // No install: the component is not installed, so the refusal is not skipped for that
    // reason — only the generation and record checks can suppress the write.
    mkdirSync(graphifyRoot(), { recursive: true });
    // Start the older refusal: its entry snapshot (no generation, no failure record) runs
    // synchronously up to the first await.
    const refusedPromise = install(env, { expectedLockHash: "0".repeat(64) });
    // A newer attempt records its failure in the meantime. The synchronous write stands
    // in for the newer attempt's record — the file is the mechanism's state.
    writeFileSync(path.join(graphifyRoot(), "last-failure.json"), JSON.stringify({ lockHash: hash, reason: "offline", detail: "newer attempt failed", at: new Date().toISOString() }));
    const refused = await refusedPromise;
    expect(refused).toMatchObject({ state: "failed", reason: "offer-changed", lockHash: hash });
    // The newer attempt's record stands: the older refusal did not stamp over it, even
    // though the generation is unchanged (the newer attempt never claimed one).
    expect(readFailure(graphifyRoot())).toMatchObject({ reason: "offline", detail: "newer attempt failed" });
  });

  test("an offer-changed refusal does not overwrite a failure recorded by an intervening install, even with an identical timestamp", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const env = envFor(component, source);
    const hash = lockHash(component.target);
    // No install: the component is not installed, so the refusal is not skipped for that
    // reason — only the generation check can suppress the write. The counter is seeded by
    // hand to stand in for a prior install's claim.
    mkdirSync(graphifyRoot(), { recursive: true });
    writeFileSync(path.join(graphifyRoot(), "install-generation"), "1\n");
    // Freeze the clock so the seeded record's timestamp is exactly the one the refusal
    // will generate: if ordering still ran on timestamps, this refusal would overwrite it.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-20T00:00:00.000Z"));
    try {
      await writeFailure(graphifyRoot(), { lockHash: hash, reason: "network", detail: "newer attempt failed", at: new Date().toISOString() });
      // Start the refusal: its entry snapshot (generation 1) runs synchronously up to the
      // first await, so the intervening claim below lands between the snapshot and the write.
      const refusedPromise = install(env, { expectedLockHash: "0".repeat(64) });
      // The intervening attempt's pre-activation claim, written exactly as
      // claimInstallGeneration writes it: the generation is now 2, so the refusal's recheck
      // must suppress the write even though the timestamps are identical.
      writeFileSync(path.join(graphifyRoot(), "install-generation"), "2\n");
      const refused = await refusedPromise;
      expect(refused).toMatchObject({ state: "failed", reason: "offer-changed", lockHash: hash });
      expect(readFailure(graphifyRoot())).toMatchObject({ reason: "network", detail: "newer attempt failed" });
    } finally {
      vi.useRealTimers();
    }
  });

  test("an older refusal does not overwrite an identical failure record rewritten after its snapshot", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const env = envFor(component, source);
    const hash = lockHash(component.target);
    mkdirSync(graphifyRoot(), { recursive: true });
    // Freeze the clock so the seeded record's timestamp is exactly the one the refusal
    // will generate: lock, reason, detail and timestamp are all identical, and only the
    // revision distinguishes the rewrite.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-20T00:00:00.000Z"));
    try {
      // Seed the record the refusal will snapshot: its revision is stamped by writeFailure.
      await writeFailure(graphifyRoot(), { lockHash: hash, reason: "network", detail: "newer attempt failed", at: new Date().toISOString() });
      const before = readFailure(graphifyRoot())!;
      // Start the older refusal: its entry snapshot runs synchronously up to the first await.
      const refusedPromise = install(env, { expectedLockHash: "0".repeat(64) });
      // A newer attempt rewrites the identical record in the meantime — same lock, reason,
      // detail and timestamp, but a fresh revision. The synchronous write stands in for
      // the newer attempt's record.
      writeFileSync(path.join(graphifyRoot(), "last-failure.json"), `${JSON.stringify({ lockHash: hash, reason: "network", detail: "newer attempt failed", at: new Date().toISOString(), revision: "0000000000000001" }, null, 2)}\n`);
      const refused = await refusedPromise;
      expect(refused).toMatchObject({ state: "failed", reason: "offer-changed", lockHash: hash });
      const after = readFailure(graphifyRoot())!;
      expect(after.revision).toBe("0000000000000001");
      expect(after.revision).not.toBe(before.revision);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a repair that cannot record its generation aborts before activation", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const env = envFor(component, source);
    expect(await install(env)).toMatchObject({ state: "installed" });
    const hash = lockHash(component.target);
    // Seed a failure record with a failed repair attempt.
    const failing = await install(env, {
      force: true,
      hooks: {
        selfCheck: async () => {
          throw new Error("injected self-check failure");
        },
      },
    });
    expect(failing).toMatchObject({ state: "failed", reason: "self-check" });
    expect(readFailure(graphifyRoot())).toMatchObject({ reason: "self-check" });
    // Sabotage the generation record: a directory at its path makes the claim fail.
    rmSync(path.join(graphifyRoot(), "install-generation"));
    mkdirSync(path.join(graphifyRoot(), "install-generation"));
    const aborted = await install(env, { force: true });
    expect(aborted).toMatchObject({ state: "failed", reason: "self-check" });
    // Nothing was committed: the pointer and the installed tree are untouched, and the
    // attempt's failure — not a silent success — is what the store reports.
    expect(readPointer(graphifyRoot()).active).toBe(hash);
    expect(await componentStatus(env)).toMatchObject({ state: "installed", lastFailure: { reason: "self-check" } });
  });

  test("a lock-release failure after a committed install still reports the install and frees the lock", async () => {
    const component = fakeComponent(execLog);
    const source = await serve(component);
    const env = envFor(component, source);
    const status = await install(env, {
      hooks: {
        removeLockFile: async () => {
          throw new Error("injected: could not remove the lock");
        },
      },
    });
    expect(status).toMatchObject({ state: "installed" });
    // The un-removable claim was tombstoned into a record no acquirer reads as a live owner,
    // so the next install takes it over instead of waiting on a lock nobody holds.
    expect(readFileSync(path.join(graphifyRoot(), ".install.lock"), "utf8")).toContain("released");
    // The follow-up install is forced, so it really acquires the lock: it takes the tombstone
    // over, installs, and its own release removes the lock file.
    expect(await install(env, { force: true })).toMatchObject({ state: "installed" });
    expect(existsSync(path.join(graphifyRoot(), ".install.lock"))).toBe(false);
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

  test("a takeover whose judged owner changed does not move the live record aside", async () => {
    mkdirSync(graphifyRoot(), { recursive: true });
    const file = path.join(graphifyRoot(), ".install.lock");
    // The record changed hands after the judgment: a live installer claimed it.
    writeFileSync(file, `${process.pid}:live`);
    let renames = 0;
    const moved = await takeOverStaleLock(
      file,
      { content: String(2 ** 22 + 123_456), ino: 0, mtimeMs: 0 },
      async (from, to) => {
        renames += 1;
        await rename(from, to);
      },
    );
    expect(moved).toBeNull();
    expect(renames).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(`${process.pid}:live`);
    expect(readdirSync(graphifyRoot())).toHaveLength(1);
  });

  test("a lock that cannot be read is treated as a live owner, not a free store", () => {
    const dir = graphifyRoot();
    mkdirSync(dir, { recursive: true });
    // The lock path is a directory: reading it fails with EISDIR, not ENOENT.
    mkdirSync(path.join(dir, ".install.lock"), { recursive: true });
    const backup = path.join(dir, `${"c".repeat(64)}.replaced-abcdef`);
    mkdirSync(backup, { recursive: true });
    writeFileSync(path.join(backup, "marker"), "kept\n");
    expect(installLockHeldByLiveOwner(dir)).toBe(true);
    // Recovery must not move the backup while the lock's state is inconclusive.
    recoverReplacementsSync(dir);
    expect(existsSync(path.join(dir, "c".repeat(64)))).toBe(false);
    expect(existsSync(path.join(backup, "marker"))).toBe(true);
  });

  test("recovery does not move a backup a live installer claimed after the listing", () => {
    const dir = graphifyRoot();
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, ".install.lock"), "released\n");
    const backup = path.join(dir, `${"c".repeat(64)}.replaced-abcdef`);
    mkdirSync(backup, { recursive: true });
    writeFileSync(path.join(backup, "marker"), "kept\n");
    recoverReplacementsSync(dir, {
      beforeMove: () => {
        // An installer takes over the tombstone and claims the lock while recovery lists.
        writeFileSync(path.join(dir, ".install.lock"), `${process.pid}:installer`);
      },
    });
    expect(existsSync(path.join(dir, "c".repeat(64)))).toBe(false);
    expect(existsSync(path.join(backup, "marker"))).toBe(true);
  });

  test("recovery under the install lock blocks a waiting installer from acquiring it", async () => {
    const dir = graphifyRoot();
    mkdirSync(dir, { recursive: true });
    const backup = path.join(dir, `${"c".repeat(64)}.replaced-abcdef`);
    mkdirSync(backup, { recursive: true });
    writeFileSync(path.join(backup, "marker"), "kept\n");
    // Claim the lock as the installer would, then run recovery with that token: the
    // recovery holds the lock while it moves the backup.
    const { token, release } = await acquireInstallLock(dir);
    try {
      let held = false;
      recoverReplacementsSync(dir, {
        ownToken: token,
        beforeMove: () => {
          // A waiting installer tries to claim the lock while recovery holds it: the
          // atomic link must fail because the path is occupied.
          const probe = `${path.join(dir, ".install.lock")}.probe-${process.pid}`;
          writeFileSync(probe, "probe");
          try {
            linkSync(probe, path.join(dir, ".install.lock"));
          } catch (error) {
            held = (error as NodeJS.ErrnoException).code === "EEXIST";
          } finally {
            rmSync(probe, { force: true });
          }
        },
      });
      expect(held).toBe(true);
      expect(existsSync(path.join(dir, "c".repeat(64)))).toBe(true);
      expect(readFileSync(path.join(dir, "c".repeat(64), "marker"), "utf8")).toBe("kept\n");
    } finally {
      await release();
    }
  });

  test("a read-path recovery claims the install lock while it moves a backup", () => {
    const dir = graphifyRoot();
    mkdirSync(dir, { recursive: true });
    const backup = path.join(dir, `${"c".repeat(64)}.replaced-abcdef`);
    mkdirSync(backup, { recursive: true });
    writeFileSync(path.join(backup, "marker"), "kept\n");
    // The read path has no token of its own: it claims the lock synchronously before moving
    // the backup, so an installer that tries to claim it in the meantime is refused and its
    // recovery never runs — the backup stays in place until the read path restores it. The
    // read path is synchronous, so no async installer can interleave during the move; the
    // exclusion is proved with a synchronous claim attempt inside the move's seam, which is
    // the same link-based protocol the async acquire uses.
    let claimDuringMove: { release: () => void; token: string } | null | "unset" = "unset";
    recoverReplacementsSync(dir, {
      beforeMove: () => {
        claimDuringMove = acquireInstallLockSync(dir);
      },
    });
    expect(claimDuringMove).toBeNull();
    expect(existsSync(path.join(dir, "c".repeat(64)))).toBe(true);
    expect(readFileSync(path.join(dir, "c".repeat(64), "marker"), "utf8")).toBe("kept\n");
    // After the recovery releases, the lock is free again.
    const claim = acquireInstallLockSync(dir);
    expect(claim).not.toBeNull();
    claim!.release();
  });

  test("a recovery whose lock is displaced after its final check undoes its restore move", () => {
    const dir = mkdtempSync(path.join(root, "recover-"));
    const backupName = `${"d".repeat(64)}.replaced-abc123`;
    mkdirSync(path.join(dir, backupName), { recursive: true });
    writeFileSync(path.join(dir, backupName, "marker"), "backup\n");
    // Recovery claims the vacant lock and passes its final check; then its lock is
    // displaced the way a delayed takeover's rename displaces it — the lock file is
    // moved aside after the check — and a third installer claims the vacant path
    // before the restore move runs.
    let third: { release: () => void; token: string } | null = null;
    recoverReplacementsSync(dir, {
      afterCheck: () => {
        renameSync(path.join(dir, ".install.lock"), path.join(dir, ".install.lock.displaced"));
        third = acquireInstallLockSync(dir);
      },
    });
    // The restore landed after the displacement, so recovery undid it: the version
    // directory is vacant again and the backup is back under its recovery name, while
    // the third installer's claim stands (its own activation is what may restore or
    // replace the backup now).
    expect(third).not.toBeNull();
    expect(existsSync(path.join(dir, "d".repeat(64)))).toBe(false);
    expect(readFileSync(path.join(dir, backupName, "marker"), "utf8")).toBe("backup\n");
    expect(readInstallLockToken(dir)).toBe(third!.token);
    third!.release();
  });

  test("a live successor activating while recovery restores the backup does not fail on the occupied destination", async () => {
    const hash = "f".repeat(64);
    const dir = mkdtempSync(path.join(root, "recover-"));
    const backupName = `${hash}.replaced-abc123`;
    mkdirSync(path.join(dir, backupName), { recursive: true });
    writeFileSync(path.join(dir, backupName, "marker"), "backup\n");
    await writePointer(dir, { active: hash, previous: null });
    const staging = path.join(dir, "staging");
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, "marker"), "new\n");
    // The successor's activation starts while the destination is missing and pauses
    // at its placement move. Its lock is live only once it claims it; until then its
    // ownership check is the lenient entry one, and after the claim it reads the
    // lock file.
    const atPlacement = deferred();
    const releasePlacement = deferred();
    const renameHook = async (from: string, to: string) => {
      if (from === staging && to === path.join(dir, hash)) {
        atPlacement.resolve();
        await releasePlacement.promise;
      }
    };
    let successorToken: string | null = null;
    const verifyLockHeld = async () => {
      if (successorToken && readInstallLockToken(dir) !== successorToken) throw new Error("lock lost");
    };
    const outcome = activate(dir, hash, staging, { verifyLockHeld, rename: renameHook }).catch((error: unknown) => error);
    await atPlacement.promise;
    // Recovery runs in a child process and pauses after its restore move. While it is
    // paused, its lock is displaced the way a delayed takeover's rename displaces it,
    // and the successor claims the vacant path.
    const controlDir = path.join(root, "recovery-control");
    mkdirSync(controlDir, { recursive: true });
    const resultFile = path.join(root, "recovery-result.json");
    const jobFile = path.join(root, "recovery-job.json");
    writeFileSync(jobFile, JSON.stringify({ root: dir, controlDir, resultFile }));
    const worker = fileURLToPath(new URL("../fixtures/component-recovery-worker.mjs", import.meta.url));
    const cliDir = fileURLToPath(new URL("../..", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx", worker, jobFile], { cwd: cliDir, stdio: ["ignore", "pipe", "pipe"] });
    let childErr = "";
    child.stderr!.on("data", (d) => (childErr += d));
    const childDone = new Promise<number | null>((resolve) => child.on("exit", resolve));
    const waitForFile = async (file: string) => {
      const end = Date.now() + 15_000;
      while (!existsSync(file)) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${file}; child stderr: ${childErr}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    let third: { release: () => void; token: string } | null = null;
    let released = false;
    const releaseChild = () => {
      if (!released) {
        released = true;
        writeFileSync(path.join(controlDir, "release"), "");
      }
    };
    try {
      await waitForFile(path.join(controlDir, "restored"));
      expect(readFileSync(path.join(dir, hash, "marker"), "utf8")).toBe("backup\n");
      renameSync(path.join(dir, ".install.lock"), path.join(dir, ".install.lock.displaced"));
      third = acquireInstallLockSync(dir);
      successorToken = third!.token;
      // The placement resumes: the destination is now occupied by the restored backup,
      // so the move fails and the activation re-reads it. The restored tree is the
      // referenced version's backup, so it is moved aside and the staging is placed.
      releasePlacement.resolve();
      expect(await outcome).toBe("replaced-referenced");
      expect(readFileSync(path.join(dir, hash, "marker"), "utf8")).toBe("new\n");
      expect(readPointer(dir).active).toBe(hash);
      expect(readInstallLockToken(dir)).toBe(third!.token);
      releaseChild();
      await waitForFile(resultFile);
      expect(await childDone).toBe(0);
      // The child's post-move check ran after the activation committed: its token is
      // gone, but the destination no longer holds the backup tree (the activation's
      // staging is there instead), so the undo is correctly skipped and the successor's
      // tree stands.
      expect(readFileSync(path.join(dir, hash, "marker"), "utf8")).toBe("new\n");
      expect(readInstallLockToken(dir)).toBe(third!.token);
    } finally {
      releaseChild();
      child.kill();
      third?.release();
    }
  });

  test("a live successor reusing the restored tree is not undone by recovery", async () => {
    const hash = "c".repeat(64);
    const dir = mkdtempSync(path.join(root, "recover-"));
    const backupName = `${hash}.replaced-abc123`;
    mkdirSync(path.join(dir, backupName), { recursive: true });
    writeFileSync(path.join(dir, backupName, "marker"), "backup\n");
    await writePointer(dir, { active: hash, previous: null });
    const staging = path.join(dir, "staging");
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, "marker"), "backup\n");
    // The successor's activation starts while the destination is missing and pauses
    // at its placement move. Its staging is byte-identical to the backup, so it
    // will reuse the restored tree instead of replacing it.
    const atPlacement = deferred();
    const releasePlacement = deferred();
    const renameHook = async (from: string, to: string) => {
      if (from === staging && to === path.join(dir, hash)) {
        atPlacement.resolve();
        await releasePlacement.promise;
      }
    };
    let successorToken: string | null = null;
    const verifyLockHeld = async () => {
      if (successorToken && readInstallLockToken(dir) !== successorToken) throw new Error("lock lost");
    };
    const outcome = activate(dir, hash, staging, { verifyLockHeld, rename: renameHook }).catch((error: unknown) => error);
    await atPlacement.promise;
    // Recovery runs in a child process and pauses after its restore move. While it is
    // paused, its lock is displaced the way a delayed takeover's rename displaces it,
    // and the successor claims the vacant path.
    const controlDir = path.join(root, "reuse-control");
    mkdirSync(controlDir, { recursive: true });
    const resultFile = path.join(root, "reuse-result.json");
    const jobFile = path.join(root, "reuse-job.json");
    writeFileSync(jobFile, JSON.stringify({ root: dir, controlDir, resultFile }));
    const worker = fileURLToPath(new URL("../fixtures/component-recovery-worker.mjs", import.meta.url));
    const cliDir = fileURLToPath(new URL("../..", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx", worker, jobFile], { cwd: cliDir, stdio: ["ignore", "pipe", "pipe"] });
    let childErr = "";
    child.stderr!.on("data", (d) => (childErr += d));
    const childDone = new Promise<number | null>((resolve) => child.on("exit", resolve));
    const waitForFile = async (file: string) => {
      const end = Date.now() + 15_000;
      while (!existsSync(file)) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${file}; child stderr: ${childErr}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    let third: { release: () => void; token: string } | null = null;
    let released = false;
    const releaseChild = () => {
      if (!released) {
        released = true;
        writeFileSync(path.join(controlDir, "release"), "");
      }
    };
    try {
      await waitForFile(path.join(controlDir, "restored"));
      expect(readFileSync(path.join(dir, hash, "marker"), "utf8")).toBe("backup\n");
      renameSync(path.join(dir, ".install.lock"), path.join(dir, ".install.lock.displaced"));
      third = acquireInstallLockSync(dir);
      successorToken = third!.token;
      // The placement resumes: the destination is now occupied by the restored backup,
      // so the move fails and the activation re-reads it. The restored tree matches
      // the staging, so the activation reuses it and publishes the pointer.
      releasePlacement.resolve();
      expect(await outcome).toBe("reused");
      expect(readFileSync(path.join(dir, hash, "marker"), "utf8")).toBe("backup\n");
      expect(readPointer(dir).active).toBe(hash);
      expect(readInstallLockToken(dir)).toBe(third!.token);
      releaseChild();
      await waitForFile(resultFile);
      expect(await childDone).toBe(0);
      // The child's post-move check ran after the activation published: its token is
      // gone, but the pointer was rewritten after the restore, so the undo is skipped
      // and the published tree stands.
      expect(readFileSync(path.join(dir, hash, "marker"), "utf8")).toBe("backup\n");
      expect(readPointer(dir).active).toBe(hash);
      expect(readInstallLockToken(dir)).toBe(third!.token);
      expect(readdirSync(dir).filter((name) => name.includes(".replaced-"))).toEqual([]);
    } finally {
      releaseChild();
      child.kill();
      third?.release();
    }
  });

  test("recovery waits for an in-progress reuse instead of undoing it", async () => {
    const hash = "e".repeat(64);
    const dir = mkdtempSync(path.join(root, "recover-"));
    const backupName = `${hash}.replaced-abc123`;
    mkdirSync(path.join(dir, backupName), { recursive: true });
    writeFileSync(path.join(dir, backupName, "marker"), "backup\n");
    await writePointer(dir, { active: hash, previous: null });
    const staging = path.join(dir, "staging");
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, "marker"), "backup\n");
    // The successor's activation starts while the destination is missing and pauses
    // at its placement move. Its staging is byte-identical to the backup, so it
    // will reuse the restored tree instead of replacing it.
    const atPlacement = deferred();
    const releasePlacement = deferred();
    const renameHook = async (from: string, to: string) => {
      if (from === staging && to === path.join(dir, hash)) {
        atPlacement.resolve();
        await releasePlacement.promise;
      }
    };
    let successorToken: string | null = null;
    let calls = 0;
    const atPointerWrite = deferred();
    const releasePointerWrite = deferred();
    const verifyLockHeld = async () => {
      calls += 1;
      // The second verification is the checkedPoint's: pause there, after the
      // sameTree check and the staging removal, but before the pointer write — the
      // successor is mid-reuse and holds the tree mutex.
      if (calls === 2) {
        atPointerWrite.resolve();
        await releasePointerWrite.promise;
      }
      if (successorToken && readInstallLockToken(dir) !== successorToken) throw new Error("lock lost");
    };
    const outcome = activate(dir, hash, staging, { verifyLockHeld, rename: renameHook }).catch((error: unknown) => error);
    await atPlacement.promise;
    // Recovery runs in a child process and pauses after its restore move. While it is
    // paused, its lock is displaced the way a delayed takeover's rename displaces it,
    // and the successor claims the vacant path.
    const controlDir = path.join(root, "inflight-control");
    mkdirSync(controlDir, { recursive: true });
    const resultFile = path.join(root, "inflight-result.json");
    const jobFile = path.join(root, "inflight-job.json");
    writeFileSync(jobFile, JSON.stringify({ root: dir, controlDir, resultFile }));
    const worker = fileURLToPath(new URL("../fixtures/component-recovery-worker.mjs", import.meta.url));
    const cliDir = fileURLToPath(new URL("../..", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx", worker, jobFile], { cwd: cliDir, stdio: ["ignore", "pipe", "pipe"] });
    let childErr = "";
    child.stderr!.on("data", (d) => (childErr += d));
    const childDone = new Promise<number | null>((resolve) => child.on("exit", resolve));
    const waitForFile = async (file: string) => {
      const end = Date.now() + 15_000;
      while (!existsSync(file)) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${file}; child stderr: ${childErr}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    let third: { release: () => void; token: string } | null = null;
    let released = false;
    const releaseChild = () => {
      if (!released) {
        released = true;
        writeFileSync(path.join(controlDir, "release"), "");
      }
    };
    try {
      await waitForFile(path.join(controlDir, "restored"));
      expect(readFileSync(path.join(dir, hash, "marker"), "utf8")).toBe("backup\n");
      renameSync(path.join(dir, ".install.lock"), path.join(dir, ".install.lock.displaced"));
      third = acquireInstallLockSync(dir);
      successorToken = third!.token;
      // The placement resumes: the destination is now occupied by the restored backup,
      // so the move fails and the activation re-reads it. The restored tree matches
      // the staging, so the activation reuses it — and pauses before its pointer write.
      releasePlacement.resolve();
      await atPointerWrite.promise;
      // The recovery is released while the successor is mid-reuse: its post-move check
      // must wait for the tree mutex instead of undoing the restore out from under
      // the install that is about to commit the tree. Give it time to reach the
      // check, then confirm the restored tree is still in place.
      releaseChild();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(readFileSync(path.join(dir, hash, "marker"), "utf8")).toBe("backup\n");
      expect(existsSync(resultFile)).toBe(false);
      // The successor writes the pointer and returns "reused"; the recovery's
      // post-move check then acquires the mutex, sees the pointer was rewritten
      // after the restore, and skips the undo.
      releasePointerWrite.resolve();
      expect(await outcome).toBe("reused");
      expect(readFileSync(path.join(dir, hash, "marker"), "utf8")).toBe("backup\n");
      expect(readPointer(dir).active).toBe(hash);
      expect(readInstallLockToken(dir)).toBe(third!.token);
      await waitForFile(resultFile);
      expect(await childDone).toBe(0);
      expect(readFileSync(path.join(dir, hash, "marker"), "utf8")).toBe("backup\n");
      expect(readPointer(dir).active).toBe(hash);
      expect(readInstallLockToken(dir)).toBe(third!.token);
      expect(readdirSync(dir).filter((name) => name.includes(".replaced-"))).toEqual([]);
    } finally {
      releaseChild();
      releasePointerWrite.resolve();
      child.kill();
      third?.release();
    }
  });

  test("a delayed tree-lock takeover does not destroy a live successor's claim", async () => {
    const hash = "e".repeat(64);
    const dir = mkdtempSync(path.join(root, "recover-"));
    const backupName = `${hash}.replaced-abc123`;
    mkdirSync(path.join(dir, backupName), { recursive: true });
    writeFileSync(path.join(dir, backupName, "marker"), "backup\n");
    await writePointer(dir, { active: hash, previous: null });
    const staging = path.join(dir, "staging");
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, "marker"), "backup\n");
    // A stale tree-lock record: the contender below reads it, judges it stale, and
    // pauses before its rename — while a live successor claims the path in the gap.
    writeFileSync(path.join(dir, ".tree.lock"), "released\n");
    // The successor's activation starts while the destination is missing and pauses
    // at its placement move. Its staging is byte-identical to the backup, so it
    // will reuse the restored tree instead of replacing it.
    const atPlacement = deferred();
    const releasePlacement = deferred();
    const renameHook = async (from: string, to: string) => {
      if (from === staging && to === path.join(dir, hash)) {
        atPlacement.resolve();
        await releasePlacement.promise;
      }
    };
    let successorToken: string | null = null;
    let calls = 0;
    const atPointerWrite = deferred();
    const releasePointerWrite = deferred();
    const verifyLockHeld = async () => {
      calls += 1;
      // The second verification is the checkedPoint's: pause there, after the
      // sameTree check and the staging removal, but before the pointer write — the
      // successor is mid-reuse and holds the tree mutex.
      if (calls === 2) {
        atPointerWrite.resolve();
        await releasePointerWrite.promise;
      }
      if (successorToken && readInstallLockToken(dir) !== successorToken) throw new Error("lock lost");
    };
    const outcome = activate(dir, hash, staging, { verifyLockHeld, rename: renameHook }).catch((error: unknown) => error);
    await atPlacement.promise;
    // The contender runs in a child process and pauses after reading the stale
    // record, before its rename. The recovery runs in a second child process and
    // pauses after its restore move.
    const cliDir = fileURLToPath(new URL("../..", import.meta.url));
    const takeoverControl = path.join(root, "takeover-control");
    mkdirSync(takeoverControl, { recursive: true });
    const takeoverResult = path.join(root, "takeover-result.json");
    const takeoverJob = path.join(root, "takeover-job.json");
    writeFileSync(takeoverJob, JSON.stringify({ root: dir, controlDir: takeoverControl, resultFile: takeoverResult }));
    const takeoverWorker = fileURLToPath(new URL("../fixtures/component-tree-takeover-worker.mjs", import.meta.url));
    const contender = spawn(process.execPath, ["--import", "tsx", takeoverWorker, takeoverJob], { cwd: cliDir, stdio: ["ignore", "pipe", "pipe"] });
    let contenderErr = "";
    contender.stderr!.on("data", (d) => (contenderErr += d));
    const contenderDone = new Promise<number | null>((resolve) => contender.on("exit", resolve));
    const controlDir = path.join(root, "gap-control");
    mkdirSync(controlDir, { recursive: true });
    const resultFile = path.join(root, "gap-result.json");
    const jobFile = path.join(root, "gap-job.json");
    writeFileSync(jobFile, JSON.stringify({ root: dir, controlDir, resultFile, afterUndo: "undone" }));
    const worker = fileURLToPath(new URL("../fixtures/component-recovery-worker.mjs", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx", worker, jobFile], { cwd: cliDir, stdio: ["ignore", "pipe", "pipe"] });
    let childErr = "";
    child.stderr!.on("data", (d) => (childErr += d));
    const childDone = new Promise<number | null>((resolve) => child.on("exit", resolve));
    const waitForFile = async (file: string, err = "") => {
      const end = Date.now() + 15_000;
      while (!existsSync(file)) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${file}; child stderr: ${err}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    let third: { release: () => void; token: string } | null = null;
    let released = false;
    const releaseChild = () => {
      if (!released) {
        released = true;
        writeFileSync(path.join(controlDir, "release"), "");
      }
    };
    let undoReleased = false;
    const releaseUndo = () => {
      if (!undoReleased) {
        undoReleased = true;
        writeFileSync(path.join(controlDir, "release-undo"), "");
      }
    };
    let takeoverRenameReleased = false;
    const releaseTakeoverRename = () => {
      if (!takeoverRenameReleased) {
        takeoverRenameReleased = true;
        writeFileSync(path.join(takeoverControl, "release-rename"), "");
      }
    };
    let takeoverRestoreReleased = false;
    const releaseTakeoverRestore = () => {
      if (!takeoverRestoreReleased) {
        takeoverRestoreReleased = true;
        writeFileSync(path.join(takeoverControl, "release-restore"), "");
      }
    };
    try {
      await waitForFile(path.join(takeoverControl, "judged"), contenderErr);
      await waitForFile(path.join(controlDir, "restored"), childErr);
      expect(readFileSync(path.join(dir, hash, "marker"), "utf8")).toBe("backup\n");
      renameSync(path.join(dir, ".install.lock"), path.join(dir, ".install.lock.displaced"));
      third = acquireInstallLockSync(dir);
      successorToken = third!.token;
      // The placement resumes: the destination is now occupied by the restored backup,
      // so the move fails and the activation re-reads it. The restored tree matches
      // the staging, so the activation reuses it — claiming the tree lock by taking
      // over the stale record the contender already judged, and pausing before its
      // pointer write.
      releasePlacement.resolve();
      await atPointerWrite.promise;
      // The contender resumes: its delayed rename moves the successor's live tree
      // lock aside. It pauses before restoring it, and the recovery claims the
      // vacant path in the gap — then undoes the restore while still holding the
      // tree mutex, so the contender's restore must fail against its live claim.
      releaseTakeoverRename();
      await waitForFile(path.join(takeoverControl, "renamed"), contenderErr);
      releaseChild();
      await waitForFile(path.join(controlDir, "undone"), childErr);
      expect(readFileSync(path.join(dir, backupName, "marker"), "utf8")).toBe("backup\n");
      expect(existsSync(path.join(dir, hash))).toBe(false);
      // The contender resumes: its restore fails (the recovery's claim is at the
      // path), so it must NOT delete the successor's live claim — the aside file
      // survives, carrying the successor's token.
      releaseTakeoverRestore();
      await waitForFile(takeoverResult, contenderErr);
      expect(await contenderDone).toBe(0);
      const takeover = JSON.parse(readFileSync(takeoverResult, "utf8"));
      expect(takeover.won).toBe(false);
      const aside = readdirSync(dir).filter((name) => name.startsWith(".tree.lock.stale-"));
      expect(aside).toHaveLength(1);
      expect(readFileSync(path.join(dir, aside[0]!), "utf8")).toMatch(new RegExp(`^${process.pid}:`));
      // The recovery finishes, and the successor's pointer write is refused: its
      // tree-lock claim was displaced, so it aborts instead of publishing a pointer
      // to the missing tree.
      releaseUndo();
      await waitForFile(resultFile, childErr);
      expect(await childDone).toBe(0);
      releasePointerWrite.resolve();
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("tree lock");
      expect(readPointer(dir).active).toBe(hash);
      expect(existsSync(path.join(dir, hash))).toBe(false);
      expect(readFileSync(path.join(dir, backupName, "marker"), "utf8")).toBe("backup\n");
    } finally {
      releaseChild();
      releaseUndo();
      releaseTakeoverRename();
      releaseTakeoverRestore();
      releasePointerWrite.resolve();
      child.kill();
      contender.kill();
      third?.release();
    }
  });

  test("a displacement during the pointer write is refused instead of returning reused", async () => {
    const hash = "e".repeat(64);
    const dir = mkdtempSync(path.join(root, "recover-"));
    const backupName = `${hash}.replaced-abc123`;
    mkdirSync(path.join(dir, backupName), { recursive: true });
    writeFileSync(path.join(dir, backupName, "marker"), "backup\n");
    await writePointer(dir, { active: hash, previous: null });
    const staging = path.join(dir, "staging");
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, "marker"), "backup\n");
    // A stale tree-lock record: the contender below reads it, judges it stale, and
    // pauses before its rename — while a live successor claims the path in the gap.
    writeFileSync(path.join(dir, ".tree.lock"), "released\n");
    // The successor's activation starts while the destination is missing and pauses
    // at its placement move. Its staging is byte-identical to the backup, so it
    // will reuse the restored tree instead of replacing it.
    const atPlacement = deferred();
    const releasePlacement = deferred();
    const renameHook = async (from: string, to: string) => {
      if (from === staging && to === path.join(dir, hash)) {
        atPlacement.resolve();
        await releasePlacement.promise;
      }
    };
    let successorToken: string | null = null;
    const verifyLockHeld = async () => {
      if (successorToken && readInstallLockToken(dir) !== successorToken) throw new Error("lock lost");
    };
    // The successor pauses inside its pointer write — after the token check, while
    // the write is in progress — so the displacement below lands in that interval.
    let writePaused = false;
    const atWriting = deferred();
    const releaseWriting = deferred();
    const writePointerHook = async (r: string, p: { active: string | null; previous: string | null }) => {
      if (!writePaused) {
        writePaused = true;
        atWriting.resolve();
        await releaseWriting.promise;
      }
    };
    // The pointer file's inode, captured before the successor runs: the successor's
    // write must never land, so the file the setup wrote stays byte- and
    // inode-identical (writeFileAtomic would replace it with a new inode).
    const pointerIno = statSync(path.join(dir, "current.json")).ino;
    const outcome = activate(dir, hash, staging, { verifyLockHeld, rename: renameHook, writePointer: writePointerHook }).catch((error: unknown) => error);
    await atPlacement.promise;
    // The contender runs in a child process and pauses after reading the stale
    // record, before its rename. The recovery runs in a second child process and
    // pauses after its restore move.
    const cliDir = fileURLToPath(new URL("../..", import.meta.url));
    const takeoverControl = path.join(root, "takeover-control");
    mkdirSync(takeoverControl, { recursive: true });
    const takeoverResult = path.join(root, "takeover-result.json");
    const takeoverJob = path.join(root, "takeover-job.json");
    writeFileSync(takeoverJob, JSON.stringify({ root: dir, controlDir: takeoverControl, resultFile: takeoverResult }));
    const takeoverWorker = fileURLToPath(new URL("../fixtures/component-tree-takeover-worker.mjs", import.meta.url));
    const contender = spawn(process.execPath, ["--import", "tsx", takeoverWorker, takeoverJob], { cwd: cliDir, stdio: ["ignore", "pipe", "pipe"] });
    let contenderErr = "";
    contender.stderr!.on("data", (d) => (contenderErr += d));
    const contenderDone = new Promise<number | null>((resolve) => contender.on("exit", resolve));
    const controlDir = path.join(root, "gap-control");
    mkdirSync(controlDir, { recursive: true });
    const resultFile = path.join(root, "gap-result.json");
    const jobFile = path.join(root, "gap-job.json");
    writeFileSync(jobFile, JSON.stringify({ root: dir, controlDir, resultFile, afterUndo: "undone" }));
    const worker = fileURLToPath(new URL("../fixtures/component-recovery-worker.mjs", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx", worker, jobFile], { cwd: cliDir, stdio: ["ignore", "pipe", "pipe"] });
    let childErr = "";
    child.stderr!.on("data", (d) => (childErr += d));
    const childDone = new Promise<number | null>((resolve) => child.on("exit", resolve));
    const waitForFile = async (file: string, err = "") => {
      const end = Date.now() + 15_000;
      while (!existsSync(file)) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${file}; child stderr: ${err}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    let third: { release: () => void; token: string } | null = null;
    let released = false;
    const releaseChild = () => {
      if (!released) {
        released = true;
        writeFileSync(path.join(controlDir, "release"), "");
      }
    };
    let undoReleased = false;
    const releaseUndo = () => {
      if (!undoReleased) {
        undoReleased = true;
        writeFileSync(path.join(controlDir, "release-undo"), "");
      }
    };
    let takeoverRenameReleased = false;
    const releaseTakeoverRename = () => {
      if (!takeoverRenameReleased) {
        takeoverRenameReleased = true;
        writeFileSync(path.join(takeoverControl, "release-rename"), "");
      }
    };
    let takeoverRestoreReleased = false;
    const releaseTakeoverRestore = () => {
      if (!takeoverRestoreReleased) {
        takeoverRestoreReleased = true;
        writeFileSync(path.join(takeoverControl, "release-restore"), "");
      }
    };
    let writingReleased = false;
    const releaseWritingOnce = () => {
      if (!writingReleased) {
        writingReleased = true;
        releaseWriting.resolve();
      }
    };
    try {
      await waitForFile(path.join(takeoverControl, "judged"), contenderErr);
      await waitForFile(path.join(controlDir, "restored"), childErr);
      expect(readFileSync(path.join(dir, hash, "marker"), "utf8")).toBe("backup\n");
      renameSync(path.join(dir, ".install.lock"), path.join(dir, ".install.lock.displaced"));
      third = acquireInstallLockSync(dir);
      successorToken = third!.token;
      // The placement resumes: the destination is now occupied by the restored backup,
      // so the move fails and the activation re-reads it. The restored tree matches
      // the staging, so the activation reuses it — claiming the tree lock by taking
      // over the stale record the contender already judged, passing its token check,
      // and pausing inside its pointer write.
      releasePlacement.resolve();
      await atWriting.promise;
      // The contender resumes: its delayed rename moves the successor's live tree
      // lock aside. It pauses before restoring it, and the recovery claims the
      // vacant path in the gap — then undoes the restore while still holding the
      // tree mutex, so the contender's restore must fail against its live claim.
      releaseTakeoverRename();
      await waitForFile(path.join(takeoverControl, "renamed"), contenderErr);
      releaseChild();
      await waitForFile(path.join(controlDir, "undone"), childErr);
      expect(readFileSync(path.join(dir, backupName, "marker"), "utf8")).toBe("backup\n");
      expect(existsSync(path.join(dir, hash))).toBe(false);
      // The contender resumes: its restore fails (the recovery's claim is at the
      // path), so it must NOT delete the successor's live claim — the aside file
      // survives, carrying the successor's token.
      releaseTakeoverRestore();
      await waitForFile(takeoverResult, contenderErr);
      expect(await contenderDone).toBe(0);
      const takeover = JSON.parse(readFileSync(takeoverResult, "utf8"));
      expect(takeover.won).toBe(false);
      const aside = readdirSync(dir).filter((name) => name.startsWith(".tree.lock.stale-"));
      expect(aside).toHaveLength(1);
      expect(readFileSync(path.join(dir, aside[0]!), "utf8")).toMatch(new RegExp(`^${process.pid}:`));
      // The recovery finishes. The successor's pointer write now resumes — but the
      // guard right before the rename refuses it: its tree-lock claim was displaced
      // while the write was paused, so it aborts instead of returning "reused" with
      // the pointer naming a missing directory. The write never lands: the pointer
      // file keeps the inode the setup wrote (the pointer still names the hash
      // because the setup wrote it, not because the successor published it).
      releaseUndo();
      await waitForFile(resultFile, childErr);
      expect(await childDone).toBe(0);
      releaseWritingOnce();
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("tree lock");
      expect(readPointer(dir).active).toBe(hash);
      expect(statSync(path.join(dir, "current.json")).ino).toBe(pointerIno);
      expect(existsSync(path.join(dir, hash))).toBe(false);
      expect(readFileSync(path.join(dir, backupName, "marker"), "utf8")).toBe("backup\n");
    } finally {
      releaseChild();
      releaseUndo();
      releaseTakeoverRename();
      releaseTakeoverRestore();
      releaseWritingOnce();
      child.kill();
      contender.kill();
      third?.release();
    }
  });

  test("a successor that commits before a delayed pointer write does not lose its pointer", async () => {
    // Two different versions in the same component root: A publishes hash A, B
    // publishes hash B. A pauses in its pointer-write seam after passing its token
    // check; B then displaces both of A's locks, claims them, and commits. When A
    // resumes, the lock re-check after the seam finds them lost and refuses the
    // write before it starts — A must not overwrite B's pointer.
    const componentA = fakeComponent(execLog, "a");
    const componentB = fakeComponent(execLog, "b");
    const hashA = lockHash(componentA.target);
    const hashB = lockHash(componentB.target);
    expect(hashA).not.toBe(hashB);
    const dir = graphifyRoot();
    mkdirSync(dir, { recursive: true });
    const stagingA = path.join(dir, "staging-a");
    mkdirSync(stagingA, { recursive: true });
    writeFileSync(path.join(stagingA, "marker"), "a\n");
    const stagingB = path.join(dir, "staging-b");
    mkdirSync(stagingB, { recursive: true });
    writeFileSync(path.join(stagingB, "marker"), "b\n");
    const holder = await acquireInstallLock(dir);
    const verifyA = async () => {
      if (readInstallLockToken(dir) !== holder.token) throw new Error("lock lost");
    };
    let writePaused = false;
    const atWriting = deferred();
    const releaseWriting = deferred();
    const outcome = activate(dir, hashA, stagingA, {
      verifyLockHeld: verifyA,
      writePointer: async () => {
        if (!writePaused) {
          writePaused = true;
          atWriting.resolve();
          await releaseWriting.promise;
        }
      },
    }).catch((error: unknown) => error);
    await atWriting.promise;
    // A is paused in its pointer-write seam, after its token check. Displace both of
    // its locks the way a delayed takeover's rename does, and let B claim them and
    // commit a different version.
    renameSync(path.join(dir, ".install.lock"), path.join(dir, ".install.lock.displaced"));
    renameSync(path.join(dir, ".tree.lock"), path.join(dir, ".tree.lock.displaced"));
    const successor = acquireInstallLockSync(dir);
    const successorOutcome = await activate(dir, hashB, stagingB, {
      verifyLockHeld: async () => {
        if (readInstallLockToken(dir) !== successor!.token) throw new Error("lock lost");
      },
    });
    expect(successorOutcome).toBe("renamed");
    expect(readPointer(dir).active).toBe(hashB);
    const pointerIno = statSync(path.join(dir, "current.json")).ino;
    // A resumes: the lock re-check after the seam finds them lost and refuses the
    // write before it starts — so B's pointer stands while B still holds the
    // install lock, and the pointer file keeps the inode B's write created.
    releaseWriting.resolve();
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect(readPointer(dir).active).toBe(hashB);
    expect(statSync(path.join(dir, "current.json")).ino).toBe(pointerIno);
    expect(readInstallLockToken(dir)).toBe(successor!.token);
    await holder.release();
    expect(readInstallLockToken(dir)).toBe(successor!.token);
    await successor!.release();
  });

  test("a successor that publishes while the pointer write re-checks its lock keeps its pointer", async () => {
    // Two different versions in the same component root: A publishes hash A, B
    // publishes hash B. A passes its token check and reaches the lock re-check that
    // runs after the write seam and before the write; it pauses there. B then
    // displaces both of A's locks, claims them, and commits. When A resumes, the
    // re-check finds its install lock lost and aborts before the write starts — so
    // B's pointer stands while B still holds the install lock. This is the last
    // asynchronous seam before the write: after this re-check, the synchronous guard
    // and the rename run in the same block, so no interleaving can be orchestrated
    // between them.
    const componentA = fakeComponent(execLog, "a");
    const componentB = fakeComponent(execLog, "b");
    const hashA = lockHash(componentA.target);
    const hashB = lockHash(componentB.target);
    expect(hashA).not.toBe(hashB);
    const dir = graphifyRoot();
    mkdirSync(dir, { recursive: true });
    const stagingA = path.join(dir, "staging-a");
    mkdirSync(stagingA, { recursive: true });
    writeFileSync(path.join(stagingA, "marker"), "a\n");
    const stagingB = path.join(dir, "staging-b");
    mkdirSync(stagingB, { recursive: true });
    writeFileSync(path.join(stagingB, "marker"), "b\n");
    const holder = await acquireInstallLock(dir);
    let calls = 0;
    const atRecheck = deferred();
    const releaseRecheck = deferred();
    const verifyA = async () => {
      calls += 1;
      // The third verification is the re-check in the pointer write, after the seam
      // and before the write: the first is the activation entry, the second the
      // checked-point check.
      if (calls === 3) {
        atRecheck.resolve();
        await releaseRecheck.promise;
      }
      if (readInstallLockToken(dir) !== holder.token) throw new Error("lock lost");
    };
    const outcome = activate(dir, hashA, stagingA, { verifyLockHeld: verifyA }).catch((error: unknown) => error);
    await atRecheck.promise;
    // A is paused in the pointer write's lock re-check, after its token check and
    // before the write. Displace both of its locks the way a delayed takeover's
    // rename does, and let B claim them and commit a different version.
    renameSync(path.join(dir, ".install.lock"), path.join(dir, ".install.lock.displaced"));
    renameSync(path.join(dir, ".tree.lock"), path.join(dir, ".tree.lock.displaced"));
    const successor = acquireInstallLockSync(dir);
    const successorOutcome = await activate(dir, hashB, stagingB, {
      verifyLockHeld: async () => {
        if (readInstallLockToken(dir) !== successor!.token) throw new Error("lock lost");
      },
    });
    expect(successorOutcome).toBe("renamed");
    expect(readPointer(dir).active).toBe(hashB);
    const pointerIno = statSync(path.join(dir, "current.json")).ino;
    releaseRecheck.resolve();
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect(readPointer(dir).active).toBe(hashB);
    expect(statSync(path.join(dir, "current.json")).ino).toBe(pointerIno);
    expect(readInstallLockToken(dir)).toBe(successor!.token);
    await holder.release();
    expect(readInstallLockToken(dir)).toBe(successor!.token);
    await successor!.release();
  });

  test("a successor that publishes while the pointer rename is delayed keeps its pointer", async () => {
    // Two different versions in the same component root: A publishes hash A, B
    // publishes hash B. A passes its guard and pauses at the rename seam, after
    // the guard and before the real rename. B then displaces both of A's locks,
    // claims them, and commits. When A resumes, the guard's second run after the
    // seam finds its tree lock lost and refuses the write — the delayed rename
    // never runs, so B's pointer stands while B still holds the install lock, and
    // the pointer file keeps the inode B's write created.
    const componentA = fakeComponent(execLog, "a");
    const componentB = fakeComponent(execLog, "b");
    const hashA = lockHash(componentA.target);
    const hashB = lockHash(componentB.target);
    expect(hashA).not.toBe(hashB);
    const dir = graphifyRoot();
    mkdirSync(dir, { recursive: true });
    const stagingA = path.join(dir, "staging-a");
    mkdirSync(stagingA, { recursive: true });
    writeFileSync(path.join(stagingA, "marker"), "a\n");
    const stagingB = path.join(dir, "staging-b");
    mkdirSync(stagingB, { recursive: true });
    writeFileSync(path.join(stagingB, "marker"), "b\n");
    const holder = await acquireInstallLock(dir);
    const verifyA = async () => {
      if (readInstallLockToken(dir) !== holder.token) throw new Error("lock lost");
    };
    let renamePaused = false;
    const atRename = deferred();
    const releaseRename = deferred();
    const outcome = activate(dir, hashA, stagingA, {
      verifyLockHeld: verifyA,
      renamePointer: async () => {
        if (!renamePaused) {
          renamePaused = true;
          atRename.resolve();
          await releaseRename.promise;
        }
      },
    }).catch((error: unknown) => error);
    await atRename.promise;
    // A is paused at its pointer rename, after its guard passed. Displace both of
    // its locks the way a delayed takeover's rename does, and let B claim them and
    // commit a different version.
    renameSync(path.join(dir, ".install.lock"), path.join(dir, ".install.lock.displaced"));
    renameSync(path.join(dir, ".tree.lock"), path.join(dir, ".tree.lock.displaced"));
    const successor = acquireInstallLockSync(dir);
    const successorOutcome = await activate(dir, hashB, stagingB, {
      verifyLockHeld: async () => {
        if (readInstallLockToken(dir) !== successor!.token) throw new Error("lock lost");
      },
    });
    expect(successorOutcome).toBe("renamed");
    expect(readPointer(dir).active).toBe(hashB);
    const pointerIno = statSync(path.join(dir, "current.json")).ino;
    releaseRename.resolve();
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("tree lock");
    expect(readPointer(dir).active).toBe(hashB);
    expect(statSync(path.join(dir, "current.json")).ino).toBe(pointerIno);
    expect(readInstallLockToken(dir)).toBe(successor!.token);
    await holder.release();
    expect(readInstallLockToken(dir)).toBe(successor!.token);
    await successor!.release();
  });

  test("a successor that publishes while the pointer's final rename is delayed keeps its pointer", async () => {
    // Two different versions in the same component root: A publishes hash A, B
    // publishes hash B. A passes its guard and its first rename seam and pauses at
    // the final rename seam, after the final guard and before the real rename. B
    // then displaces both of A's locks, claims them, and commits. When A resumes,
    // the final check after the seam — the guard and the pointer-identity
    // compare-and-swap — finds its tree lock lost and the pointer republished, and
    // refuses the write: the delayed rename never runs, so B's pointer stands while
    // B still holds the install lock, and the pointer file keeps the inode B's write
    // created. This is the interval after the final guard, with the rename itself
    // delayed: no further check runs after the final one before the rename.
    const componentA = fakeComponent(execLog, "a");
    const componentB = fakeComponent(execLog, "b");
    const hashA = lockHash(componentA.target);
    const hashB = lockHash(componentB.target);
    expect(hashA).not.toBe(hashB);
    const dir = graphifyRoot();
    mkdirSync(dir, { recursive: true });
    const stagingA = path.join(dir, "staging-a");
    mkdirSync(stagingA, { recursive: true });
    writeFileSync(path.join(stagingA, "marker"), "a\n");
    const stagingB = path.join(dir, "staging-b");
    mkdirSync(stagingB, { recursive: true });
    writeFileSync(path.join(stagingB, "marker"), "b\n");
    const holder = await acquireInstallLock(dir);
    const verifyA = async () => {
      if (readInstallLockToken(dir) !== holder.token) throw new Error("lock lost");
    };
    let renamePaused = false;
    const atRename = deferred();
    const releaseRename = deferred();
    const outcome = activate(dir, hashA, stagingA, {
      verifyLockHeld: verifyA,
      renamePointerFinal: async () => {
        if (!renamePaused) {
          renamePaused = true;
          atRename.resolve();
          await releaseRename.promise;
        }
      },
    }).catch((error: unknown) => error);
    await atRename.promise;
    // A is paused at its final pointer rename, after its final guard passed.
    // Displace both of its locks the way a delayed takeover's rename does, and let
    // B claim them and commit a different version.
    renameSync(path.join(dir, ".install.lock"), path.join(dir, ".install.lock.displaced"));
    renameSync(path.join(dir, ".tree.lock"), path.join(dir, ".tree.lock.displaced"));
    const successor = acquireInstallLockSync(dir);
    const successorOutcome = await activate(dir, hashB, stagingB, {
      verifyLockHeld: async () => {
        if (readInstallLockToken(dir) !== successor!.token) throw new Error("lock lost");
      },
    });
    expect(successorOutcome).toBe("renamed");
    expect(readPointer(dir).active).toBe(hashB);
    const pointerIno = statSync(path.join(dir, "current.json")).ino;
    releaseRename.resolve();
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("tree lock");
    expect(readPointer(dir).active).toBe(hashB);
    expect(statSync(path.join(dir, "current.json")).ino).toBe(pointerIno);
    expect(readInstallLockToken(dir)).toBe(successor!.token);
    await holder.release();
    expect(readInstallLockToken(dir)).toBe(successor!.token);
    await successor!.release();
  });

  test("a successor that publishes while the pointer rename is fenced keeps its pointer", async () => {
    // Two different versions in the same component root: A publishes hash A, B
    // publishes hash B. A passes its final guard and identity check, acquires the
    // pointer-write fence, and pauses at the fence seam, after the last check and
    // before the real rename. B then displaces both of A's locks, claims them, and
    // tries to publish — but its pointer write blocks on the fence, so its pointer
    // cannot land while A's rename is fenced. When A resumes, its rename runs (its
    // pointer lands first), then A releases the fence and its post-write check finds
    // its locks lost, so A aborts; B's pointer write then acquires the fence and
    // overwrites A's pointer, so B's pointer stands while B holds the install lock,
    // and the pointer file keeps the inode B's write created. This is the interval
    // after the last check, with the rename itself delayed and fenced: no further
    // check runs after the last one before the rename, and the fence is what keeps
    // the successor's pointer out of that interval.
    const componentA = fakeComponent(execLog, "a");
    const componentB = fakeComponent(execLog, "b");
    const hashA = lockHash(componentA.target);
    const hashB = lockHash(componentB.target);
    expect(hashA).not.toBe(hashB);
    const dir = graphifyRoot();
    mkdirSync(dir, { recursive: true });
    const stagingA = path.join(dir, "staging-a");
    mkdirSync(stagingA, { recursive: true });
    writeFileSync(path.join(stagingA, "marker"), "a\n");
    const stagingB = path.join(dir, "staging-b");
    mkdirSync(stagingB, { recursive: true });
    writeFileSync(path.join(stagingB, "marker"), "b\n");
    const holder = await acquireInstallLock(dir);
    const verifyA = async () => {
      if (readInstallLockToken(dir) !== holder.token) throw new Error("lock lost");
    };
    let renamePaused = false;
    const atRename = deferred();
    const releaseRename = deferred();
    const outcome = activate(dir, hashA, stagingA, {
      verifyLockHeld: verifyA,
      renamePointerFence: async () => {
        if (!renamePaused) {
          renamePaused = true;
          atRename.resolve();
          await releaseRename.promise;
        }
      },
    }).catch((error: unknown) => error);
    await atRename.promise;
    // A is paused at its fenced pointer rename, after its last check, holding the
    // fence. Displace both of its locks the way a delayed takeover's rename does,
    // and let B claim them and try to publish a different version.
    renameSync(path.join(dir, ".install.lock"), path.join(dir, ".install.lock.displaced"));
    renameSync(path.join(dir, ".tree.lock"), path.join(dir, ".tree.lock.displaced"));
    const successor = acquireInstallLockSync(dir);
    const successorOutcome = activate(dir, hashB, stagingB, {
      verifyLockHeld: async () => {
        if (readInstallLockToken(dir) !== successor!.token) throw new Error("lock lost");
      },
    });
    // B claimed the install lock and is trying to publish; its pointer write blocks
    // on the fence A holds. Release A's rename: A's pointer lands first, then A
    // releases the fence and aborts (its post-write check finds its locks lost), and
    // B's pointer write acquires the fence and overwrites A's pointer.
    const end = Date.now() + 15_000;
    while (readInstallLockToken(dir) !== successor!.token) {
      if (Date.now() > end) throw new Error("timed out waiting for the successor to claim the install lock");
      await new Promise((r) => setTimeout(r, 25));
    }
    releaseRename.resolve();
    expect(await successorOutcome).toBe("renamed");
    expect(readPointer(dir).active).toBe(hashB);
    const pointerIno = statSync(path.join(dir, "current.json")).ino;
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect(readPointer(dir).active).toBe(hashB);
    expect(statSync(path.join(dir, "current.json")).ino).toBe(pointerIno);
    expect(readInstallLockToken(dir)).toBe(successor!.token);
    await holder.release();
    expect(readInstallLockToken(dir)).toBe(successor!.token);
    await successor!.release();
  });

  test("a successor that publishes while the pointer's fence is being acquired keeps its pointer", async () => {
    // Two different versions in the same component root: A publishes hash A, B
    // publishes hash B. A passes its final guard and identity check and pauses at
    // the before-fence seam, after the last check and before acquiring the
    // pointer-write fence. B then displaces both of A's locks, claims them, acquires
    // the fence, publishes its pointer, and releases the fence. When A resumes, it
    // acquires the fence and the re-check after the fence acquisition — the guard and
    // the pointer-identity compare-and-swap — finds its tree lock lost and the
    // pointer republished, and refuses the write: the rename never runs, so B's
    // pointer stands while B holds the install lock, and the pointer file keeps the
    // inode B's write created. This is the interval between the last check and the
    // fence acquisition: no check runs there in the old code, and the re-check after
    // the fence is acquired is what closes it.
    const componentA = fakeComponent(execLog, "a");
    const componentB = fakeComponent(execLog, "b");
    const hashA = lockHash(componentA.target);
    const hashB = lockHash(componentB.target);
    expect(hashA).not.toBe(hashB);
    const dir = graphifyRoot();
    mkdirSync(dir, { recursive: true });
    const stagingA = path.join(dir, "staging-a");
    mkdirSync(stagingA, { recursive: true });
    writeFileSync(path.join(stagingA, "marker"), "a\n");
    const stagingB = path.join(dir, "staging-b");
    mkdirSync(stagingB, { recursive: true });
    writeFileSync(path.join(stagingB, "marker"), "b\n");
    const holder = await acquireInstallLock(dir);
    const verifyA = async () => {
      if (readInstallLockToken(dir) !== holder.token) throw new Error("lock lost");
    };
    let renamePaused = false;
    const atRename = deferred();
    const releaseRename = deferred();
    const outcome = activate(dir, hashA, stagingA, {
      verifyLockHeld: verifyA,
      renameBeforeFence: async () => {
        if (!renamePaused) {
          renamePaused = true;
          atRename.resolve();
          await releaseRename.promise;
        }
      },
    }).catch((error: unknown) => error);
    await atRename.promise;
    // A is paused at its before-fence seam, after its last check and before
    // acquiring the fence. Displace both of its locks the way a delayed takeover's
    // rename does, and let B claim them, acquire the fence, and publish a different
    // version before A resumes.
    renameSync(path.join(dir, ".install.lock"), path.join(dir, ".install.lock.displaced"));
    renameSync(path.join(dir, ".tree.lock"), path.join(dir, ".tree.lock.displaced"));
    const successor = acquireInstallLockSync(dir);
    const successorOutcome = await activate(dir, hashB, stagingB, {
      verifyLockHeld: async () => {
        if (readInstallLockToken(dir) !== successor!.token) throw new Error("lock lost");
      },
    });
    expect(successorOutcome).toBe("renamed");
    expect(readPointer(dir).active).toBe(hashB);
    const pointerIno = statSync(path.join(dir, "current.json")).ino;
    releaseRename.resolve();
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("tree lock");
    expect(readPointer(dir).active).toBe(hashB);
    expect(statSync(path.join(dir, "current.json")).ino).toBe(pointerIno);
    expect(readInstallLockToken(dir)).toBe(successor!.token);
    await holder.release();
    expect(readInstallLockToken(dir)).toBe(successor!.token);
    await successor!.release();
  });

  test("a rollback does not restore over a successor's live tree", async () => {
    const component = fakeComponent(execLog);
    const hash = lockHash(component.target);
    const dir = graphifyRoot();
    mkdirSync(dir, { recursive: true });
    const final = path.join(dir, hash);
    const successorTree = path.join(dir, "successor-tree");
    mkdirSync(successorTree, { recursive: true });
    writeFileSync(path.join(successorTree, "marker"), "successor\n");
    writeFileSync(path.join(successorTree, "graphify"), "#!/bin/sh\necho graphify\n");
    const successorStaging = path.join(dir, "staging-successor");
    mkdirSync(successorStaging, { recursive: true });
    writeFileSync(path.join(successorStaging, "marker"), "successor-new\n");
    writeFileSync(path.join(successorStaging, "graphify"), "#!/bin/sh\necho graphify\n");
    const rollbackStaging = path.join(dir, "staging");
    mkdirSync(rollbackStaging, { recursive: true });
    writeFileSync(path.join(rollbackStaging, "marker"), "rollback\n");
    writeFileSync(path.join(rollbackStaging, "graphify"), "#!/bin/sh\necho graphify\n");
    const lockPath = writeLock(path.join(root, "lock.json"), component);
    const env = { runtimeRoot, lockPath, platform: { platform: process.platform, arch: process.arch, musl: false } };
    // The rollback attempt holds a real lock. The successor's tree is published at
    // final first (placed and pointed to directly, the test setup), so the
    // rollback's referenced branch moves it aside and pauses at the re-validation
    // before placing its own staging.
    const holder = await acquireInstallLock(dir);
    let calls = 0;
    const atRevalidate = deferred();
    const releaseRevalidate = deferred();
    const verifyLockHeld = async () => {
      calls += 1;
      if (calls === 2) {
        atRevalidate.resolve();
        await releaseRevalidate.promise;
      }
      if (readInstallLockToken(dir) !== holder.token) throw new Error("lock lost");
    };
    renameSync(successorTree, final);
    await writePointer(dir, { active: hash, previous: null });
    expect(componentBin("graphify", env)).toBe(path.join(final, "graphify"));
    const outcome = activate(dir, hash, rollbackStaging, {
      verifyLockHeld,
      writePointer: async () => {
        throw new Error("pointer write failed");
      },
    }).catch((error: unknown) => error);
    await atRevalidate.promise;
    // The successor displaces the rollback's install lock the way a delayed takeover's
    // rename does, claims the vacant path, and re-publishes its new tree at final
    // (which the rollback's move vacated). While its install lock is live, the
    // launcher must resolve to the successor's tree — the rollback must not restore
    // over it.
    renameSync(path.join(dir, ".install.lock"), path.join(dir, ".install.lock.displaced"));
    const successor = await acquireInstallLock(dir);
    renameSync(successorStaging, final);
    await writePointer(dir, { active: hash, previous: null });
    expect(readInstallLockToken(dir)).toBe(successor.token);
    expect(componentBin("graphify", env)).toBe(path.join(final, "graphify"));
    expect(readFileSync(path.join(final, "marker"), "utf8")).toBe("successor-new\n");
    releaseRevalidate.resolve();
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    // The rollback's restore was skipped (its install lock is lost): the successor's
    // new tree stands, the launcher still resolves to it, and the original tree
    // stays aside as the backup for recovery.
    expect(readFileSync(path.join(final, "marker"), "utf8")).toBe("successor-new\n");
    expect(componentBin("graphify", env)).toBe(path.join(final, "graphify"));
    const backups = readdirSync(dir).filter((name) => name.includes(".replaced-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(dir, backups[0]!, "marker"), "utf8")).toBe("successor\n");
    expect(readInstallLockToken(dir)).toBe(successor.token);
    await holder.release();
    expect(readInstallLockToken(dir)).toBe(successor.token);
    await successor.release();
  });

  test("a successor publishing after the rollback's last token read leaves the tree in place", async () => {
    const component = fakeComponent(execLog);
    const hash = lockHash(component.target);
    const dir = graphifyRoot();
    mkdirSync(dir, { recursive: true });
    const final = path.join(dir, hash);
    const staging = path.join(dir, "staging");
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, "marker"), "new\n");
    writeFileSync(path.join(staging, "graphify"), "#!/bin/sh\necho graphify\n");
    const successorStaging = path.join(dir, "staging-successor");
    mkdirSync(successorStaging, { recursive: true });
    writeFileSync(path.join(successorStaging, "marker"), "new\n");
    writeFileSync(path.join(successorStaging, "graphify"), "#!/bin/sh\necho graphify\n");
    const lockPath = writeLock(path.join(root, "lock.json"), component);
    const env = { runtimeRoot, lockPath, platform: { platform: process.platform, arch: process.arch, musl: false } };
    // The rollback attempt holds a real lock. Its removal pauses at the rename-aside
    // seam — after its last token read — while holding the tree mutex. A successor then
    // displaces both locks the way a delayed takeover's rename does (the lock files
    // are renamed aside directly, as the install-lock tests do) and publishes the
    // same tree by reusing it, before the rollback's rename runs.
    const holder = await acquireInstallLock(dir);
    const verifyLockHeld = async () => {
      if (readInstallLockToken(dir) !== holder.token) throw new Error("lock lost");
    };
    let renames = 0;
    const atAside = deferred();
    const releaseAside = deferred();
    const renameHook = async (from: string, to: string) => {
      renames += 1;
      if (renames === 2) {
        atAside.resolve();
        await releaseAside.promise;
      }
    };
    const outcome = activate(dir, hash, staging, {
      verifyLockHeld,
      writePointer: async () => {
        throw new Error("pointer write failed");
      },
      rename: renameHook,
    }).catch((error: unknown) => error);
    await atAside.promise;
    // The rollback's tree is still at final and unpublished. Displace both locks, let
    // the successor claim them, and publish by reusing the rollback's placed tree.
    renameSync(path.join(dir, ".install.lock"), path.join(dir, ".install.lock.displaced"));
    renameSync(path.join(dir, ".tree.lock"), path.join(dir, ".tree.lock.displaced"));
    const successor = acquireInstallLockSync(dir);
    const successorOutcome = await activate(dir, hash, successorStaging, {
      verifyLockHeld: async () => {
        if (readInstallLockToken(dir) !== successor!.token) throw new Error("lock lost");
      },
    });
    expect(successorOutcome).toBe("reused");
    expect(readPointer(dir).active).toBe(hash);
    expect(componentBin("graphify", env)).toBe(path.join(final, "graphify"));
    const publishedIno = statSync(final).ino;
    // The rollback resumes: its re-check after the seam finds both locks lost, so
    // the rename-aside is skipped and the successor's published tree stays in place
    // — the launcher is never unavailable. The seam ran (two hook calls: the
    // placement and the aside), but the aside's real rename never ran, so no backup
    // is left aside.
    releaseAside.resolve();
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect(renames).toBe(2);
    expect(statSync(final).ino).toBe(publishedIno);
    expect(readFileSync(path.join(final, "marker"), "utf8")).toBe("new\n");
    expect(readPointer(dir).active).toBe(hash);
    expect(componentBin("graphify", env)).toBe(path.join(final, "graphify"));
    expect(readdirSync(dir).filter((name) => name.includes(".replaced-"))).toEqual([]);
    expect(readInstallLockToken(dir)).toBe(successor!.token);
    await holder.release();
    expect(readInstallLockToken(dir)).toBe(successor!.token);
    await successor!.release();
  });

  test("a successor that publishes during the rollback's final re-check leaves the tree in place", async () => {
    const component = fakeComponent(execLog);
    const hash = lockHash(component.target);
    const dir = graphifyRoot();
    mkdirSync(dir, { recursive: true });
    const final = path.join(dir, hash);
    const staging = path.join(dir, "staging");
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, "marker"), "new\n");
    writeFileSync(path.join(staging, "graphify"), "#!/bin/sh\necho graphify\n");
    const successorStaging = path.join(dir, "staging-successor");
    mkdirSync(successorStaging, { recursive: true });
    writeFileSync(path.join(successorStaging, "marker"), "new\n");
    writeFileSync(path.join(successorStaging, "graphify"), "#!/bin/sh\necho graphify\n");
    const lockPath = writeLock(path.join(root, "lock.json"), component);
    const env = { runtimeRoot, lockPath, platform: { platform: process.platform, arch: process.arch, musl: false } };
    // The rollback attempt holds a real lock. Its removal pauses at the rename-aside
    // seam, then proceeds to the re-check after the seam — and pauses inside that
    // re-check's lock verification. A successor publishes during that pause, after
    // the seam and before the token check: it displaces both locks the way a delayed
    // takeover's rename does, claims them, and publishes the same tree by reusing
    // it. When the re-check resumes, the token check after it finds both locks lost
    // and the rename-aside is skipped — the published tree stays in place. This is
    // the last asynchronous seam before the token check: after it, the token check
    // and the rename run in the same block, so no interleaving can be orchestrated
    // between them.
    const holder = await acquireInstallLock(dir);
    let calls = 0;
    const atRecheck = deferred();
    const releaseRecheck = deferred();
    const verifyLockHeld = async () => {
      calls += 1;
      // The sixth verification is the re-check after the rename-aside seam: the first
      // is the activation entry, the second the checked-point check, the third the
      // rollback's ownership read, the fourth its re-verification, the fifth the
      // removal's pre-check.
      if (calls === 6) {
        atRecheck.resolve();
        await releaseRecheck.promise;
      }
      if (readInstallLockToken(dir) !== holder.token) throw new Error("lock lost");
    };
    let renames = 0;
    const atAside = deferred();
    const releaseAside = deferred();
    const renameHook = async (from: string, to: string) => {
      renames += 1;
      if (renames === 2) {
        atAside.resolve();
        await releaseAside.promise;
      }
    };
    const outcome = activate(dir, hash, staging, {
      verifyLockHeld,
      writePointer: async () => {
        throw new Error("pointer write failed");
      },
      rename: renameHook,
    }).catch((error: unknown) => error);
    await atAside.promise;
    // The rollback's tree is still at final and unpublished. Let the removal proceed
    // to its re-check after the seam, and pause inside that re-check's verification.
    releaseAside.resolve();
    await atRecheck.promise;
    // The successor publishes during the re-check: it displaces both locks, claims
    // them, and publishes the same tree by reusing the rollback's placed tree.
    renameSync(path.join(dir, ".install.lock"), path.join(dir, ".install.lock.displaced"));
    renameSync(path.join(dir, ".tree.lock"), path.join(dir, ".tree.lock.displaced"));
    const successor = acquireInstallLockSync(dir);
    const successorOutcome = await activate(dir, hash, successorStaging, {
      verifyLockHeld: async () => {
        if (readInstallLockToken(dir) !== successor!.token) throw new Error("lock lost");
      },
    });
    expect(successorOutcome).toBe("reused");
    expect(readPointer(dir).active).toBe(hash);
    expect(componentBin("graphify", env)).toBe(path.join(final, "graphify"));
    const publishedIno = statSync(final).ino;
    // The re-check resumes: its token check finds both locks lost, so the
    // rename-aside is skipped and the successor's published tree stays in place —
    // the launcher is never unavailable, checked while the successor's install lock
    // is live. The seam ran (two hook calls: the placement and the aside), but the
    // aside's real rename never ran, so no backup is left aside.
    releaseRecheck.resolve();
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect(renames).toBe(2);
    expect(statSync(final).ino).toBe(publishedIno);
    expect(readFileSync(path.join(final, "marker"), "utf8")).toBe("new\n");
    expect(readPointer(dir).active).toBe(hash);
    expect(componentBin("graphify", env)).toBe(path.join(final, "graphify"));
    expect(readdirSync(dir).filter((name) => name.includes(".replaced-"))).toEqual([]);
    expect(readInstallLockToken(dir)).toBe(successor!.token);
    await holder.release();
    expect(readInstallLockToken(dir)).toBe(successor!.token);
    await successor!.release();
  });

  test("a successor in another process that publishes while the rollback's rename is delayed leaves the tree in place", async () => {
    const component = fakeComponent(execLog);
    const hash = lockHash(component.target);
    const dir = graphifyRoot();
    mkdirSync(dir, { recursive: true });
    const final = path.join(dir, hash);
    const staging = path.join(dir, "staging");
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, "marker"), "new\n");
    writeFileSync(path.join(staging, "graphify"), "#!/bin/sh\necho graphify\n");
    const successorStaging = path.join(dir, "staging-successor");
    mkdirSync(successorStaging, { recursive: true });
    writeFileSync(path.join(successorStaging, "marker"), "new\n");
    writeFileSync(path.join(successorStaging, "graphify"), "#!/bin/sh\necho graphify\n");
    const lockPath = writeLock(path.join(root, "lock.json"), component);
    const env = { runtimeRoot, lockPath, platform: { platform: process.platform, arch: process.arch, musl: false } };
    // The rollback attempt holds a real lock. Its removal passes its ownership
    // re-check, then pauses at the rename seam after that check. A successor in
    // another process then displaces both locks the way a delayed takeover's rename
    // does, claims them, and publishes the same tree by reusing it. When the
    // rollback resumes, the ownership re-check after the seam finds both locks lost
    // and the rename-aside is skipped — the published tree stays in place, and the
    // launcher is never unavailable, checked while the successor's install lock is
    // live in its own process.
    const holder = await acquireInstallLock(dir);
    const verifyLockHeld = async () => {
      if (readInstallLockToken(dir) !== holder.token) throw new Error("lock lost");
    };
    let renames = 0;
    const atAside = deferred();
    const releaseAside = deferred();
    const renameHook = async (from: string, to: string) => {
      renames += 1;
      if (renames === 2) {
        atAside.resolve();
        await releaseAside.promise;
      }
    };
    const atPlaced = deferred();
    const releasePlaced = deferred();
    const outcome = activate(dir, hash, staging, {
      verifyLockHeld,
      writePointer: async () => {
        throw new Error("pointer write failed");
      },
      rename: renameHook,
      renamePlaced: async () => {
        atPlaced.resolve();
        await releasePlaced.promise;
      },
    }).catch((error: unknown) => error);
    await atAside.promise;
    // The rollback's tree is still at final and unpublished. Let the removal pass
    // its ownership re-check and pause at the rename seam after that check.
    releaseAside.resolve();
    await atPlaced.promise;
    // The successor runs in a child process: it displaces both locks, claims them,
    // and publishes the same tree by reusing the rollback's placed tree, then waits
    // (holding its install lock) until the parent releases it.
    const cliDir = fileURLToPath(new URL("../..", import.meta.url));
    const controlDir = path.join(root, "rollback-successor-control");
    mkdirSync(controlDir, { recursive: true });
    const resultFile = path.join(root, "rollback-successor-result.json");
    const jobFile = path.join(root, "rollback-successor-job.json");
    writeFileSync(jobFile, JSON.stringify({ root: dir, hash, staging: successorStaging, controlDir, resultFile }));
    const worker = fileURLToPath(new URL("../fixtures/component-rollback-successor-worker.mjs", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx", worker, jobFile], { cwd: cliDir, stdio: ["ignore", "pipe", "pipe"] });
    let childErr = "";
    child.stderr!.on("data", (d) => (childErr += d));
    const childDone = new Promise<number | null>((resolve) => child.on("exit", resolve));
    const waitForFile = async (file: string) => {
      const end = Date.now() + 15_000;
      while (!existsSync(file)) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${file}; child stderr: ${childErr}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    try {
      await waitForFile(path.join(controlDir, "published"));
      // The successor published in its own process and still holds its install lock:
      // the launcher is available (its tree stands at final) while that lock is live.
      const successorToken = readInstallLockToken(dir);
      expect(successorToken).not.toBe(holder.token);
      expect(successorToken).not.toBeNull();
      expect(readPointer(dir).active).toBe(hash);
      expect(componentBin("graphify", env)).toBe(path.join(final, "graphify"));
      const publishedIno = statSync(final).ino;
      // The rollback resumes: its ownership re-check after the seam finds both locks
      // lost, so the rename-aside is skipped and the successor's published tree stays
      // in place. The aside seam ran (two hook calls: the placement and the aside),
      // but the aside's real rename never ran, so no backup is left aside.
      releasePlaced.resolve();
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect(renames).toBe(2);
      expect(statSync(final).ino).toBe(publishedIno);
      expect(readFileSync(path.join(final, "marker"), "utf8")).toBe("new\n");
      expect(readPointer(dir).active).toBe(hash);
      expect(componentBin("graphify", env)).toBe(path.join(final, "graphify"));
      expect(readdirSync(dir).filter((name) => name.includes(".replaced-"))).toEqual([]);
      expect(readInstallLockToken(dir)).toBe(successorToken);
      await holder.release();
      expect(readInstallLockToken(dir)).toBe(successorToken);
    } finally {
      releaseAside.resolve();
      releasePlaced.resolve();
      writeFileSync(path.join(controlDir, "release"), "release\n");
      await childDone;
      expect(JSON.parse(readFileSync(resultFile, "utf8"))).toMatchObject({ outcome: "reused" });
      child.kill();
    }
  });

  test("a successor in another process that publishes while the rollback's final rename is delayed leaves the tree in place", async () => {
    const component = fakeComponent(execLog);
    const hash = lockHash(component.target);
    const dir = graphifyRoot();
    mkdirSync(dir, { recursive: true });
    const final = path.join(dir, hash);
    const staging = path.join(dir, "staging");
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, "marker"), "new\n");
    writeFileSync(path.join(staging, "graphify"), "#!/bin/sh\necho graphify\n");
    const successorStaging = path.join(dir, "staging-successor");
    mkdirSync(successorStaging, { recursive: true });
    writeFileSync(path.join(successorStaging, "marker"), "new\n");
    writeFileSync(path.join(successorStaging, "graphify"), "#!/bin/sh\necho graphify\n");
    const lockPath = writeLock(path.join(root, "lock.json"), component);
    const env = { runtimeRoot, lockPath, platform: { platform: process.platform, arch: process.arch, musl: false } };
    // The rollback attempt holds a real lock. Its removal passes its ownership
    // re-checks, then pauses at the final rename seam, after the final re-check and
    // before the real rename. A successor in another process then displaces both
    // locks the way a delayed takeover's rename does, claims them, and publishes
    // the same tree by reusing it. When the rollback resumes, the ownership and
    // identity re-check after the seam — the locks and the pointer/tree
    // compare-and-swap — finds both locks lost and the pointer republished, and the
    // rename-aside is skipped: the published tree stays in place, and the launcher
    // is never unavailable, checked while the successor's install lock is live in
    // its own process. This is the interval after the final check, with the rename
    // itself delayed: no further check runs after the final one before the rename.
    const holder = await acquireInstallLock(dir);
    const verifyLockHeld = async () => {
      if (readInstallLockToken(dir) !== holder.token) throw new Error("lock lost");
    };
    let renames = 0;
    const atAside = deferred();
    const releaseAside = deferred();
    const renameHook = async (from: string, to: string) => {
      renames += 1;
      if (renames === 2) {
        atAside.resolve();
        await releaseAside.promise;
      }
    };
    const atPlacedFinal = deferred();
    const releasePlacedFinal = deferred();
    const outcome = activate(dir, hash, staging, {
      verifyLockHeld,
      writePointer: async () => {
        throw new Error("pointer write failed");
      },
      rename: renameHook,
      renamePlacedFinal: async () => {
        atPlacedFinal.resolve();
        await releasePlacedFinal.promise;
      },
    }).catch((error: unknown) => error);
    await atAside.promise;
    // The rollback's tree is still at final and unpublished. Let the removal pass
    // its ownership re-checks and pause at the final rename seam, after the final
    // re-check and before the real rename.
    releaseAside.resolve();
    await atPlacedFinal.promise;
    // The successor runs in a child process: it displaces both locks, claims them,
    // and publishes the same tree by reusing the rollback's placed tree, then waits
    // (holding its install lock) until the parent releases it.
    const cliDir = fileURLToPath(new URL("../..", import.meta.url));
    const controlDir = path.join(root, "rollback-final-control");
    mkdirSync(controlDir, { recursive: true });
    const resultFile = path.join(root, "rollback-final-result.json");
    const jobFile = path.join(root, "rollback-final-job.json");
    writeFileSync(jobFile, JSON.stringify({ root: dir, hash, staging: successorStaging, controlDir, resultFile }));
    const worker = fileURLToPath(new URL("../fixtures/component-rollback-successor-worker.mjs", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx", worker, jobFile], { cwd: cliDir, stdio: ["ignore", "pipe", "pipe"] });
    let childErr = "";
    child.stderr!.on("data", (d) => (childErr += d));
    const childDone = new Promise<number | null>((resolve) => child.on("exit", resolve));
    const waitForFile = async (file: string) => {
      const end = Date.now() + 15_000;
      while (!existsSync(file)) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${file}; child stderr: ${childErr}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    try {
      await waitForFile(path.join(controlDir, "published"));
      // The successor published in its own process and still holds its install lock:
      // the launcher is available (its tree stands at final) while that lock is live.
      const successorToken = readInstallLockToken(dir);
      expect(successorToken).not.toBe(holder.token);
      expect(successorToken).not.toBeNull();
      expect(readPointer(dir).active).toBe(hash);
      expect(componentBin("graphify", env)).toBe(path.join(final, "graphify"));
      const publishedIno = statSync(final).ino;
      // The rollback resumes: its ownership and identity re-check after the seam
      // finds both locks lost and the pointer republished, so the rename-aside is
      // skipped and the successor's published tree stays in place. The aside seam
      // ran (two hook calls: the placement and the aside), but the aside's real
      // rename never ran, so no backup is left aside.
      releasePlacedFinal.resolve();
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect(renames).toBe(2);
      expect(statSync(final).ino).toBe(publishedIno);
      expect(readFileSync(path.join(final, "marker"), "utf8")).toBe("new\n");
      expect(readPointer(dir).active).toBe(hash);
      expect(componentBin("graphify", env)).toBe(path.join(final, "graphify"));
      expect(readdirSync(dir).filter((name) => name.includes(".replaced-"))).toEqual([]);
      expect(readInstallLockToken(dir)).toBe(successorToken);
      await holder.release();
      expect(readInstallLockToken(dir)).toBe(successorToken);
    } finally {
      releaseAside.resolve();
      releasePlacedFinal.resolve();
      writeFileSync(path.join(controlDir, "release"), "release\n");
      await childDone;
      expect(JSON.parse(readFileSync(resultFile, "utf8"))).toMatchObject({ outcome: "reused" });
      child.kill();
    }
  });

  test("a successor in another process that publishes while the rollback's rename is fenced leaves the tree in place", async () => {
    const component = fakeComponent(execLog);
    const hash = lockHash(component.target);
    const dir = graphifyRoot();
    mkdirSync(dir, { recursive: true });
    const final = path.join(dir, hash);
    const staging = path.join(dir, "staging");
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, "marker"), "new\n");
    writeFileSync(path.join(staging, "graphify"), "#!/bin/sh\necho graphify\n");
    const successorStaging = path.join(dir, "staging-successor");
    mkdirSync(successorStaging, { recursive: true });
    writeFileSync(path.join(successorStaging, "marker"), "new\n");
    writeFileSync(path.join(successorStaging, "graphify"), "#!/bin/sh\necho graphify\n");
    const lockPath = writeLock(path.join(root, "lock.json"), component);
    const env = { runtimeRoot, lockPath, platform: { platform: process.platform, arch: process.arch, musl: false } };
    // The rollback attempt holds a real lock. Its removal passes its ownership
    // re-checks, acquires the pointer-write fence, and pauses at the fence seam,
    // after the last check and before the real rename-aside, holding the fence. A
    // successor in another process then displaces both locks, claims them, and tries
    // to publish the same tree by reusing it — but its pointer write blocks on the
    // fence, so its pointer cannot land while the rollback's rename is fenced. When
    // the rollback resumes, its rename-aside runs, then the post-rename
    // re-verification finds its locks lost and restores the tree; the rollback then
    // releases the fence, the successor's pointer write acquires it and publishes,
    // and the launcher is available (its tree stands at final) while the successor's
    // install lock is live in its own process. This is the interval after the last
    // check, with the rename itself delayed and fenced: no further check runs after
    // the last one before the rename, and the fence is what keeps the successor's
    // pointer out of that interval.
    const holder = await acquireInstallLock(dir);
    const verifyLockHeld = async () => {
      if (readInstallLockToken(dir) !== holder.token) throw new Error("lock lost");
    };
    let renames = 0;
    const atAside = deferred();
    const releaseAside = deferred();
    const renameHook = async (from: string, to: string) => {
      renames += 1;
      if (renames === 2) {
        atAside.resolve();
        await releaseAside.promise;
      }
    };
    const atFence = deferred();
    const releaseFence = deferred();
    const outcome = activate(dir, hash, staging, {
      verifyLockHeld,
      writePointer: async () => {
        throw new Error("pointer write failed");
      },
      rename: renameHook,
      renameFence: async () => {
        atFence.resolve();
        await releaseFence.promise;
      },
    }).catch((error: unknown) => error);
    await atAside.promise;
    // The rollback's tree is still at final and unpublished. Let the removal pass
    // its ownership re-checks, acquire the fence, and pause at the fence seam,
    // after the last check and before the real rename-aside, holding the fence.
    releaseAside.resolve();
    await atFence.promise;
    // The successor runs in a child process: it displaces both locks, claims them,
    // and tries to publish the same tree by reusing the rollback's placed tree —
    // but its pointer write blocks on the fence the rollback holds — then waits
    // (holding its install lock) until the parent releases it.
    const cliDir = fileURLToPath(new URL("../..", import.meta.url));
    const controlDir = path.join(root, "rollback-fence-control");
    mkdirSync(controlDir, { recursive: true });
    const resultFile = path.join(root, "rollback-fence-result.json");
    const jobFile = path.join(root, "rollback-fence-job.json");
    writeFileSync(jobFile, JSON.stringify({ root: dir, hash, staging: successorStaging, controlDir, resultFile }));
    const worker = fileURLToPath(new URL("../fixtures/component-rollback-successor-worker.mjs", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx", worker, jobFile], { cwd: cliDir, stdio: ["ignore", "pipe", "pipe"] });
    let childErr = "";
    child.stderr!.on("data", (d) => (childErr += d));
    const childDone = new Promise<number | null>((resolve) => child.on("exit", resolve));
    const waitForFile = async (file: string) => {
      const end = Date.now() + 15_000;
      while (!existsSync(file)) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${file}; child stderr: ${childErr}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    try {
      // The successor claimed the install lock in its own process; it is trying to
      // publish, but its pointer write blocks on the fence the rollback holds.
      await waitForFile(path.join(controlDir, "claimed"));
      const successorToken = readInstallLockToken(dir);
      expect(successorToken).not.toBe(holder.token);
      expect(successorToken).not.toBeNull();
      // The rollback resumes: its rename-aside runs, then the post-rename
      // re-verification finds its locks lost and restores the tree, and it releases
      // the fence. The successor's pointer write then acquires the fence and
      // publishes. The rename hook ran three times: the placement, the aside seam,
      // and the rename-back that restored the tree after the re-verification failed.
      releaseFence.resolve();
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect(renames).toBe(3);
      await waitForFile(path.join(controlDir, "published"));
      // The successor published in its own process and still holds its install lock:
      // the launcher is available (its tree stands at final) while that lock is live.
      expect(readInstallLockToken(dir)).toBe(successorToken);
      expect(readPointer(dir).active).toBe(hash);
      expect(componentBin("graphify", env)).toBe(path.join(final, "graphify"));
      expect(readFileSync(path.join(final, "marker"), "utf8")).toBe("new\n");
      expect(readdirSync(dir).filter((name) => name.includes(".replaced-"))).toEqual([]);
      await holder.release();
      expect(readInstallLockToken(dir)).toBe(successorToken);
    } finally {
      releaseAside.resolve();
      releaseFence.resolve();
      writeFileSync(path.join(controlDir, "release"), "release\n");
      await childDone;
      expect(JSON.parse(readFileSync(resultFile, "utf8"))).toMatchObject({ outcome: "reused" });
      child.kill();
    }
  });

  test("a successor in another process that displaces the rollback's fence leaves the tree in place", async () => {
    const component = fakeComponent(execLog);
    const hash = lockHash(component.target);
    const dir = graphifyRoot();
    mkdirSync(dir, { recursive: true });
    const final = path.join(dir, hash);
    const staging = path.join(dir, "staging");
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, "marker"), "new\n");
    writeFileSync(path.join(staging, "graphify"), "#!/bin/sh\necho graphify\n");
    const successorStaging = path.join(dir, "staging-successor");
    mkdirSync(successorStaging, { recursive: true });
    writeFileSync(path.join(successorStaging, "marker"), "new\n");
    writeFileSync(path.join(successorStaging, "graphify"), "#!/bin/sh\necho graphify\n");
    const lockPath = writeLock(path.join(root, "lock.json"), component);
    const env = { runtimeRoot, lockPath, platform: { platform: process.platform, arch: process.arch, musl: false } };
    // The rollback attempt holds a real lock. Its removal passes its ownership
    // re-checks, acquires the pointer-write fence, and pauses at the fence seam,
    // after the last check and before the real rename-aside, holding the fence. A
    // successor in another process then displaces both locks AND the fence the way a
    // delayed stale-lock takeover's rename does (it judged the fence stale before the
    // rollback claimed it, and its rename lands later), claims them, and publishes
    // the same tree by reusing it. When the rollback resumes, the fence-token
    // re-check before the rename-aside finds its fence lost — the fence file now
    // carries the successor's token — so the rename-aside is skipped and the tree
    // stays in place. The launcher is never unavailable, checked while the
    // successor's install lock is live in its own process. This is the delayed
    // fence takeover: a protocol-compliant takeover can move a live fence aside,
    // and only the fence-token re-check before the rename catches it.
    const holder = await acquireInstallLock(dir);
    const verifyLockHeld = async () => {
      if (readInstallLockToken(dir) !== holder.token) throw new Error("lock lost");
    };
    let renames = 0;
    const atAside = deferred();
    const releaseAside = deferred();
    const renameHook = async (from: string, to: string) => {
      renames += 1;
      if (renames === 2) {
        atAside.resolve();
        await releaseAside.promise;
      }
    };
    const atFence = deferred();
    const releaseFence = deferred();
    const outcome = activate(dir, hash, staging, {
      verifyLockHeld,
      writePointer: async () => {
        throw new Error("pointer write failed");
      },
      rename: renameHook,
      renameFence: async () => {
        atFence.resolve();
        await releaseFence.promise;
      },
    }).catch((error: unknown) => error);
    await atAside.promise;
    // The rollback's tree is still at final and unpublished. Let the removal pass
    // its ownership re-checks, acquire the fence, and pause at the fence seam,
    // after the last check and before the real rename-aside, holding the fence.
    releaseAside.resolve();
    await atFence.promise;
    // The successor runs in a child process: it displaces both locks and the fence,
    // claims them, and publishes the same tree by reusing the rollback's placed
    // tree, then waits (holding its install lock) until the parent releases it.
    const cliDir = fileURLToPath(new URL("../..", import.meta.url));
    const controlDir = path.join(root, "rollback-fence-takeover-control");
    mkdirSync(controlDir, { recursive: true });
    const resultFile = path.join(root, "rollback-fence-takeover-result.json");
    const jobFile = path.join(root, "rollback-fence-takeover-job.json");
    writeFileSync(jobFile, JSON.stringify({ root: dir, hash, staging: successorStaging, controlDir, resultFile, displaceFence: true }));
    const worker = fileURLToPath(new URL("../fixtures/component-rollback-successor-worker.mjs", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx", worker, jobFile], { cwd: cliDir, stdio: ["ignore", "pipe", "pipe"] });
    let childErr = "";
    child.stderr!.on("data", (d) => (childErr += d));
    const childDone = new Promise<number | null>((resolve) => child.on("exit", resolve));
    const waitForFile = async (file: string) => {
      const end = Date.now() + 15_000;
      while (!existsSync(file)) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${file}; child stderr: ${childErr}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    try {
      // The successor claimed the install lock in its own process and displaced the
      // rollback's fence; it is publishing the same tree by reusing it.
      await waitForFile(path.join(controlDir, "claimed"));
      const successorToken = readInstallLockToken(dir);
      expect(successorToken).not.toBe(holder.token);
      expect(successorToken).not.toBeNull();
      // The rollback resumes: its fence-token re-check before the rename-aside finds
      // its fence lost, so the rename-aside is skipped and the successor's published
      // tree stays in place. The aside seam ran (two hook calls: the placement and
      // the aside), but the aside's real rename never ran, so no backup is left
      // aside and no rename-back is needed.
      releaseFence.resolve();
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect(renames).toBe(2);
      await waitForFile(path.join(controlDir, "published"));
      // The successor published in its own process and still holds its install lock:
      // the launcher is available (its tree stands at final) while that lock is live.
      expect(readInstallLockToken(dir)).toBe(successorToken);
      expect(readPointer(dir).active).toBe(hash);
      expect(componentBin("graphify", env)).toBe(path.join(final, "graphify"));
      expect(readFileSync(path.join(final, "marker"), "utf8")).toBe("new\n");
      expect(readdirSync(dir).filter((name) => name.includes(".replaced-"))).toEqual([]);
      await holder.release();
      expect(readInstallLockToken(dir)).toBe(successorToken);
    } finally {
      releaseAside.resolve();
      releaseFence.resolve();
      writeFileSync(path.join(controlDir, "release"), "release\n");
      await childDone;
      expect(JSON.parse(readFileSync(resultFile, "utf8"))).toMatchObject({ outcome: "reused" });
      child.kill();
    }
  });

  test("recovery restores a backup when the lock file is only a release tombstone", async () => {
    const hash = "b".repeat(64);
    const root = graphifyRoot();
    mkdirSync(root, { recursive: true });
    await writePointer(root, { active: hash, previous: null });
    const backup = path.join(root, `${hash}.replaced-abcdef`);
    mkdirSync(backup, { recursive: true });
    writeFileSync(path.join(backup, "marker"), "old\n");
    writeFileSync(path.join(root, ".install.lock"), "released\n");
    // The lock file holds no live owner — only the tombstone a release left when it could
    // not remove its claim — so recovery must run instead of stalling behind it.
    recoverReplacementsSync(root);
    expect(existsSync(path.join(root, hash, "marker"))).toBe(true);
    expect(existsSync(backup)).toBe(false);
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
