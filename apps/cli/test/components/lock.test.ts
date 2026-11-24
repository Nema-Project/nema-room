import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { canonicalJson, lockHash, parseLock, pythonInterpreterName, readLock, resolveTarget, shippedLockPath, totalBytes } from "../../src/components/lock.js";
import { posixLauncher } from "../../src/components/install.js";
import { fakeComponent, lockJson, OLD_PYTHON_LINE, PYTHON_LINE, sha256 } from "./fixtures.js";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const vectorsDir = path.join(repo, "scripts", "desktop", "fixtures", "lock-hash");

describe("lock-hash", () => {
  test("matches the vectors shared with scripts/desktop/fetch-graphify.mjs", () => {
    const { vectors } = JSON.parse(readFileSync(path.join(vectorsDir, "vectors.json"), "utf8")) as {
      vectors: Array<{ name: string; canonical: string; sha256: string; target: { python: unknown; wheels: unknown } }>;
    };
    expect(vectors.length).toBeGreaterThanOrEqual(2);
    for (const vector of vectors) {
      const canonical = readFileSync(path.join(vectorsDir, vector.canonical), "utf8");
      expect(canonicalJson({ python: vector.target.python, wheels: vector.target.wheels }), vector.name).toBe(canonical);
      expect(sha256(canonical), vector.name).toBe(vector.sha256);
      expect(lockHash(vector.target), vector.name).toBe(vector.sha256);
    }
  });

  test("the scripts side computes the same hash for a real-shaped target", async () => {
    const scripts = (await import(pathToFileURL(path.join(repo, "scripts", "desktop", "fetch-graphify.mjs")).href)) as {
      graphifyLockHash: (pin: unknown) => string;
      pythonInterpreterName: (version: unknown) => string;
      posixGraphifyLauncher: (interpreter: string) => string;
      GRAPHIFY_PYTHON_INTERPRETER: string;
      POSIX_GRAPHIFY_LAUNCHER: string;
    };
    const { target } = fakeComponent("/dev/null");
    expect(lockHash(target)).toBe(scripts.graphifyLockHash(target));
    // Both sides derive the interpreter from the lock the same way, and write the same launcher for it.
    for (const version of ["3.14.10", "3.11.18", "3.13.0"]) expect(scripts.pythonInterpreterName(version)).toBe(pythonInterpreterName(version));
    for (const bad of ["3.14", "python3.14", "3.14.10a1", ""]) expect(() => scripts.pythonInterpreterName(bad)).toThrow(/malformed python version/);
    const shipped = pythonInterpreterName(readLock(shippedLockPath()).python);
    expect(scripts.GRAPHIFY_PYTHON_INTERPRETER).toBe(shipped);
    expect(posixLauncher(shipped)).toBe(scripts.POSIX_GRAPHIFY_LAUNCHER);
    expect(posixLauncher(PYTHON_LINE.interpreter)).toBe(scripts.posixGraphifyLauncher(PYTHON_LINE.interpreter));
  });

  test("rejects values JSON cannot pin", () => {
    expect(() => canonicalJson({ size: Number.NaN })).toThrow(/lock-hash/);
    expect(() => canonicalJson({ size: undefined })).toThrow(/lock-hash/);
  });
});

describe("interpreter name from the lock's python version", () => {
  test("maps <major>.<minor>.<patch> to python<major>.<minor>", () => {
    expect(pythonInterpreterName("3.14.10")).toBe("python3.14");
    expect(pythonInterpreterName("3.11.18")).toBe("python3.11");
    expect(pythonInterpreterName("3.13.0")).toBe("python3.13");
  });

  test("a malformed version throws instead of falling back to a fixed name", () => {
    for (const bad of ["", "3", "3.14", "3.14.", "3.14.10.1", "3.14.10a1", "3.14.10rc2", "python3.14", " 3.14.10", "3.14.10\n", "03.14.10", "3.014.10", "2.7.18", "4.0.0"]) {
      expect(() => pythonInterpreterName(bad), JSON.stringify(bad)).toThrow(/malformed python version/);
    }
    expect(() => pythonInterpreterName(undefined as unknown as string)).toThrow(/malformed python version/);
    expect(() => pythonInterpreterName(314 as unknown as string)).toThrow(/malformed python version/);
  });

  test("the shipped lock and the fixtures' lines derive their own interpreter names", () => {
    expect(pythonInterpreterName(readLock(shippedLockPath()).python)).toBe(PYTHON_LINE.interpreter);
    expect(pythonInterpreterName(PYTHON_LINE.version)).toBe(PYTHON_LINE.interpreter);
    expect(pythonInterpreterName(OLD_PYTHON_LINE.version)).toBe(OLD_PYTHON_LINE.interpreter);
  });

  test("the POSIX launcher runs the derived interpreter and names no other line", () => {
    const launcher = posixLauncher(pythonInterpreterName("3.14.10"));
    expect(launcher).toContain('exec "$root/python/bin/python3.14" -m graphify "$@"');
    expect(launcher).not.toMatch(/python3\.(?!14\b)\d+/);
  });
});

describe("target resolution", () => {
  const { target } = fakeComponent("/dev/null");
  const lock = parseLock(lockJson({ "linux-x64": target, "linux-arm64": target, "darwin-arm64": target, "win32-x64": target }));

  test("picks the platform-arch target and sums the pinned sizes", () => {
    const resolved = resolveTarget(lock, { platform: "linux", arch: "x64", musl: false });
    expect(resolved).toMatchObject({ ok: true, key: "linux-x64", lockHash: lockHash(target), totalBytes: totalBytes(target) });
    expect(totalBytes(target)).toBe(target.python.size + target.wheels.reduce((sum, wheel) => sum + wheel.size, 0));
  });

  test("musl Linux and an unknown platform are unsupported", () => {
    expect(resolveTarget(lock, { platform: "linux", arch: "x64", musl: true })).toMatchObject({ ok: false, detail: expect.stringMatching(/musl/) });
    expect(resolveTarget(lock, { platform: "freebsd", arch: "x64" })).toMatchObject({ ok: false, key: "freebsd-x64" });
    expect(resolveTarget(lock, { platform: "darwin", arch: "x64" })).toMatchObject({ ok: false, key: "darwin-x64" });
  });

  test("a target without sizes, with a repeated file or an unsafe name is refused", () => {
    const { size: _size, ...noSize } = target.python;
    expect(() => resolveTarget(parseLock(lockJson({ "linux-x64": { ...target, python: noSize } })), { platform: "linux", arch: "x64", musl: false })).toThrow(/no size/);
    expect(() => resolveTarget(parseLock(lockJson({ "linux-x64": { ...target, wheels: [target.wheels[0], target.wheels[0]] } })), { platform: "linux", arch: "x64", musl: false })).toThrow(/repeats/);
    expect(() => resolveTarget(parseLock(lockJson({ "linux-x64": { ...target, wheels: [{ ...target.wheels[0], file: "../x.whl" }] } })), { platform: "linux", arch: "x64", musl: false })).toThrow(/unsafe/);
  });

  test("source runs read the repository lock", () => {
    expect(shippedLockPath()).toBe(path.join(repo, "scripts", "desktop", "graphify-lock.json"));
  });
});
