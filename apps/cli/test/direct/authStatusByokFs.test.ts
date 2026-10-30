import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// lstat of the BYOK key file fails with something other than ENOENT (e.g. EACCES on a parent directory).
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const lstatSync = ((file: Parameters<typeof real.lstatSync>[0], ...rest: unknown[]) => {
    if (String(file).endsWith("byok-key")) throw Object.assign(new Error("EACCES: permission denied, lstat"), { code: "EACCES" });
    return (real.lstatSync as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof real.lstatSync;
  return { ...real, default: { ...real, lstatSync }, lstatSync };
});

const { authStatus } = await import("../../src/direct/authCommands.js");
const { saveConfig } = await import("../../src/config.js");

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nema-authstatus-fs-"));
  home = join(root, "nema");
  mkdirSync(home, { recursive: true, mode: 0o700 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("a key file that cannot be inspected is reported as unusable, not as missing", () => {
  saveConfig(home, { authMode: "byok", model: "gpt-x" });
  const lines: string[] = [];
  const out = { log: (s: string) => lines.push(s), error: (s: string) => lines.push(s) };
  expect(authStatus({ nemaHome: home, out })).toBe(1);
  const t = lines.join("\n");
  expect(t).toContain("API key：不可用");
  expect(t).toContain("EACCES");
  expect(t).not.toContain("未保存");
});
