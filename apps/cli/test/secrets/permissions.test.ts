import { makePublic } from "../nativePermissions.js";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { readSecretLine, saveSecretLine } from "../../src/secrets/file.js";
import { openPrivateFile, privateModeMatches, protectPrivatePath, WINDOWS_ACL_SCRIPT } from "../../src/secrets/permissions.js";
import { AuthStore, type StoredAuth } from "../../src/direct/authStore.js";
import { ensureReportToken, reportTokenHash } from "../../src/report/token.js";
import { readClaudeToken, saveClaudeToken } from "../../src/claude/token.js";

let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "nema private-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("POSIX mode checks remain strict; Windows requires separate ACL validation", () => {
  expect(privateModeMatches({ mode: 0o644 }, "linux")).toBe(false);
  expect(privateModeMatches({ mode: 0o600 }, "darwin")).toBe(true);
  expect(privateModeMatches({ mode: 0o666 }, "win32")).toBe(true);
});

test("all credential types survive an actual write/read and atomic replacement", async () => {
  const home = path.join(root, "nema");
  const file = path.join(home, "key");
  saveSecretLine(file, "placeholder-key-1");
  saveSecretLine(file, "placeholder-key-2");
  expect(readSecretLine(file, "missing", "invalid")).toBe("placeholder-key-2");
  saveClaudeToken(home, "placeholder-claude");
  expect(readClaudeToken(home)).toBe("placeholder-claude");
  const token = ensureReportToken(home);
  expect(ensureReportToken(home)).toBe(token);
  expect(reportTokenHash(home)).toMatch(/^[0-9a-f]{64}$/);
  const auth: StoredAuth = { version: 1, mode: "siwc", clientId: "test", tokens: { access_token: "placeholder-access", refresh_token: "placeholder-refresh" }, lastRefresh: new Date().toISOString() };
  const store = new AuthStore(home, async () => { throw new Error("Not called"); });
  store.save(auth);
  expect(store.read()).toEqual(auth);
  store.save({ ...auth, accountId: "test-account" });
  expect(store.read()?.accountId).toBe("test-account");
});

test("a credential made readable to other users is rejected without echoing it", () => {
  const file = path.join(root, "key");
  saveSecretLine(file, "DO_NOT_ECHO");
  if (process.platform === "win32") {
    const result = spawnSync("icacls.exe", [file, "/grant", "*S-1-1-0:R"], { stdio: "ignore", windowsHide: true });
    expect(result.status).toBe(0);
  } else makePublic(file);
  let message = "";
  try { readSecretLine(file, "missing", "invalid"); } catch (error) { message = (error as Error).message; }
  expect(message).not.toBe("");
  expect(message).not.toContain("DO_NOT_ECHO");
  if (process.platform === "win32") protectPrivatePath(file);
  else chmodSync(file, 0o600);
  expect(readSecretLine(file, "missing", "invalid")).toBe("DO_NOT_ECHO");
});

test("opening a directory as a secret fails", () => {
  expect(() => openPrivateFile(root)).toThrow();
});

test("private files are regular files and retain their contents", () => {
  const file = path.join(root, "plain");
  writeFileSync(file, "placeholder", { mode: 0o600 });
  protectPrivatePath(file);
  const fd = openPrivateFile(file);
  closeSync(fd);
  expect(statSync(file).isFile()).toBe(true);
  expect(readFileSync(file, "utf8")).toBe("placeholder");
});

test("the Windows ACL script calls no cmdlets", () => {
  // Cmdlet autoload took ~22s per call under the managed core's filtered environment on a GitHub Windows runner.
  expect(WINDOWS_ACL_SCRIPT.match(/\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/g)).toBeNull();
});

test.runIf(process.platform === "win32")("Windows ACL protects a directory and refuses a missing path or a junction", () => {
  const dir = path.join(root, "private dir 東京");
  mkdirSync(dir);
  protectPrivatePath(dir, 0o700);
  expect(() => protectPrivatePath(path.join(root, "missing"))).toThrow(/cannot verify private Windows ACL/);
  const junction = path.join(root, "junction");
  symlinkSync(dir, junction, "junction");
  expect(() => protectPrivatePath(junction, 0o700)).toThrow(/cannot verify private Windows ACL/);
});
