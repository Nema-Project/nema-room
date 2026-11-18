import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { canonicalJson, lockHash, parseLock, resolveTarget, shippedLockPath, totalBytes } from "../../src/components/lock.js";
import { POSIX_LAUNCHER } from "../../src/components/install.js";
import { fakeComponent, lockJson, sha256 } from "./fixtures.js";

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
      POSIX_GRAPHIFY_LAUNCHER: string;
    };
    const { target } = fakeComponent("/dev/null");
    expect(lockHash(target)).toBe(scripts.graphifyLockHash(target));
    expect(POSIX_LAUNCHER).toBe(scripts.POSIX_GRAPHIFY_LAUNCHER);
  });

  test("rejects values JSON cannot pin", () => {
    expect(() => canonicalJson({ size: Number.NaN })).toThrow(/lock-hash/);
    expect(() => canonicalJson({ size: undefined })).toThrow(/lock-hash/);
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
