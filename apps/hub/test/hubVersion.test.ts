import { expect, test } from "vitest";
import { MIN_DAEMON_VERSION, compareVersions, versionSkewMessage } from "../src/hubVersion.js";

test("compareVersions orders x.y.z numerically, not lexicographically", () => {
  expect(compareVersions("0.3.2", "0.3.2")).toBe(0);
  expect(compareVersions("0.3.10", "0.3.9")).toBeGreaterThan(0);
  expect(compareVersions("0.3.9", "0.3.10")).toBeLessThan(0);
  expect(compareVersions("1.2.3", "1.2.4")).toBeLessThan(0);
  expect(compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
  expect(compareVersions("0.3", "0.3.0")).toBe(0);
});

test("compareVersions treats a prerelease as older than its release", () => {
  expect(compareVersions("0.3.3-beta.1", "0.3.3")).toBeLessThan(0);
  expect(compareVersions("0.3.3", "0.3.3-beta.1")).toBeGreaterThan(0);
  expect(compareVersions("0.3.3-beta.1", "0.3.3-beta.2")).toBeLessThan(0);
  expect(compareVersions("0.3.3-beta.2", "0.3.3-beta.10")).toBeLessThan(0);
  expect(compareVersions("0.3.3-alpha", "0.3.3-beta")).toBeLessThan(0);
});

test("compareVersions ignores build metadata", () => {
  expect(compareVersions("0.3.2+build.1", "0.3.2")).toBe(0);
});

test("MIN_DAEMON_VERSION is a plain x.y.z floor", () => {
  expect(MIN_DAEMON_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  expect(compareVersions(MIN_DAEMON_VERSION, MIN_DAEMON_VERSION)).toBe(0);
});

test("versionSkewMessage names the floor and the install target", () => {
  const message = versionSkewMessage("1.2.3");
  expect(message).toContain("版本不一致");
  expect(message).toContain(`不低于 ${MIN_DAEMON_VERSION}`);
  expect(message).toContain("hub 1.2.3");
  expect(message).toContain("@nema-project/nema@1.2.3");
});
