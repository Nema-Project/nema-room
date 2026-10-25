import { expectPrivate, makePublic } from "../nativePermissions.js";
import { canSymlinkFiles } from "../links.js";
import { protectPrivatePath } from "../../src/secrets/permissions.js";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readSecretLine, saveSecretLine } from "../../src/secrets/file.js";

let root: string;
let dir: string;
let file: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nema-secret-file-test-"));
  dir = join(root, "nema");
  file = join(dir, "secret");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const read = () => readSecretLine(file, "MISSING", "INVALID");

describe("saveSecretLine / readSecretLine", () => {
  test("round-trip and reject empty, multi-line and control-character cases", () => {
    saveSecretLine(file, "sekret-value");
    expect(read()).toBe("sekret-value");
    expectPrivate(file, 0o600);
    expectPrivate(dir, 0o700);
    expect(readdirSync(dir)).toEqual(["secret"]);

    for (const bad of ["", "first\nsecond", "cr\rvalue", "tab\tvalue", "nul\u0000value", "del\u007fvalue"]) {
      let message = "";
      try {
        saveSecretLine(file, bad);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain("必须是一行非空文本");
      if (bad !== "") expect(message).not.toContain(bad);
      expect(readFileSync(file, "utf8")).toBe("sekret-value");
    }
  });

  // A file symlink needs privilege on Windows, so this runs only where one can be created.
  test.runIf(canSymlinkFiles)("rejects a symlink on save and read without touching its target", () => {
    saveSecretLine(file, "sekret-value");
    const target = join(root, "target");
    writeFileSync(target, "original", { mode: 0o600 });
    const link = join(dir, "link");
    symlinkSync(target, link);
    expect(() => saveSecretLine(link, "sekret-value")).toThrow("符号链接");
    expect(readFileSync(target, "utf8")).toBe("original");
    expect(() => readSecretLine(link, "MISSING", "INVALID")).toThrow("符号链接");
  });

  test("read: missing file, wrong mode, one trailing newline, invalid content never echoed", () => {
    expect(read).toThrow("MISSING");

    mkdirSync(dir, { recursive: true });
    // A hand-written file is private only once its DACL is (Windows ignores the mode argument).
    const put = (text: string) => { writeFileSync(file, text, { mode: 0o600 }); protectPrivatePath(file); };
    put("sekret-value\n");
    expect(read()).toBe("sekret-value");

    put("sekret-value\n\n");
    expect(read).toThrow("INVALID");

    put("first\nsecond");
    let message = "";
    try {
      read();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe("INVALID");

    rmSync(file);
    writeFileSync(file, "sekret-value", { mode: 0o644 });
    makePublic(file);
    let modeMessage = "";
    try {
      read();
    } catch (e) {
      modeMessage = (e as Error).message;
    }
    expect(modeMessage).toContain(process.platform === "win32" ? "ACL" : "0600");
    expect(modeMessage).not.toContain("sekret-value");
  });

  test("tightens a loose parent dir to dirMode", () => {
    mkdirSync(dir, { mode: 0o755 });
    saveSecretLine(file, "v");
    expectPrivate(dir, 0o700);
  });
});
