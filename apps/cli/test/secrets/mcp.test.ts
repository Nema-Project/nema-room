import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openMcpSecretStore } from "../../src/secrets/mcp.js";
import { canSymlinkFiles, linkDir } from "../links.js";
import { expectPrivate } from "../nativePermissions.js";

const MARK = "nema-test-secret-7f3a";

let home: string;
let outside: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "nema-mcp-secret-"));
  outside = mkdtempSync(join(tmpdir(), "nema-mcp-outside-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function message(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

describe("McpSecretStore", () => {
  test("keeps each value in a private file under secrets/mcp/<id>", () => {
    const store = openMcpSecretStore(home);
    store.set("search", "API_TOKEN", MARK);
    const file = join(home, "secrets", "mcp", "search", "API_TOKEN");
    expectPrivate(file, 0o600);
    expectPrivate(join(home, "secrets", "mcp", "search"), 0o700);
    expect(store.resolve("search", "API_TOKEN")).toBe(MARK);
    expect(store.has("search", "API_TOKEN")).toBe(true);
    expect(store.has("search", "OTHER")).toBe(false);
    expect(store.names("search")).toEqual(["API_TOKEN"]);
    expect(store.ids()).toEqual(["search"]);
  });

  test("names and has do not read contents, and a missing id is empty", () => {
    const store = openMcpSecretStore(home);
    expect(store.names("search")).toEqual([]);
    expect(store.ids()).toEqual([]);
    store.set("search", "B_KEY", MARK);
    store.set("search", "A_KEY", MARK);
    // A temp file left by a crash is not a stored name.
    writeFileSync(join(home, "secrets", "mcp", "search", "A_KEY.1.x.tmp"), "junk");
    expect(store.names("search")).toEqual(["A_KEY", "B_KEY"]);
  });

  test("clear removes one value and removeAll removes the id directory", () => {
    const store = openMcpSecretStore(home);
    store.set("search", "A_KEY", MARK);
    store.set("search", "B_KEY", MARK);
    store.clear("search", "A_KEY");
    store.clear("search", "A_KEY");
    expect(store.names("search")).toEqual(["B_KEY"]);
    store.removeAll("search");
    store.removeAll("search");
    expect(existsSync(join(home, "secrets", "mcp", "search"))).toBe(false);
    expect(store.ids()).toEqual([]);
  });

  test("refuses ids and names that could leave the tree", () => {
    const store = openMcpSecretStore(home);
    for (const id of ["..", "../x", "A", "a/b", ""]) expect(message(() => store.set(id, "KEY", MARK))).toMatch(/invalid MCP id/);
    for (const name of ["..", "a/b", "1KEY", "KEY.tmp", ""]) expect(message(() => store.set("search", name, MARK))).toMatch(/invalid secret name/);
    expect(existsSync(join(home, "secrets"))).toBe(false);
  });

  test("refuses empty or multi-line values without echoing them", () => {
    const store = openMcpSecretStore(home);
    const text = message(() => store.set("search", "KEY", `${MARK}\nmore`));
    expect(text).not.toBe("");
    expect(text).not.toContain(MARK);
    expect(store.has("search", "KEY")).toBe(false);
  });

  test("a missing value names the slot, not a value", () => {
    const store = openMcpSecretStore(home);
    expect(message(() => store.resolve("search", "API_TOKEN"))).toMatch(/API_TOKEN/);
  });

  test.skipIf(!canSymlinkFiles)("resolve refuses a value file that is a symbolic link", () => {
    const store = openMcpSecretStore(home);
    store.set("search", "OTHER", "placeholder");
    writeFileSync(join(outside, "target"), MARK);
    symlinkSync(join(outside, "target"), join(home, "secrets", "mcp", "search", "API_TOKEN"));
    const text = message(() => store.resolve("search", "API_TOKEN"));
    expect(text).toMatch(/symbolic link|符号链接/);
    expect(text).not.toContain(MARK);
  });

  test("set refuses when secrets/mcp is a link to another directory", () => {
    mkdirSync(join(home, "secrets"), { recursive: true });
    linkDir(outside, join(home, "secrets", "mcp"));
    const store = openMcpSecretStore(home);
    const text = message(() => store.set("search", "API_TOKEN", MARK));
    expect(text).toMatch(/symbolic link/);
    expect(text).not.toContain(MARK);
    expect(readdirSync(outside)).toEqual([]);
  });

  test("set refuses when secrets itself is a link", () => {
    linkDir(outside, join(home, "secrets"));
    const store = openMcpSecretStore(home);
    expect(message(() => store.set("search", "API_TOKEN", MARK))).toMatch(/symbolic link/);
    expect(readdirSync(outside)).toEqual([]);
  });

  test("set, clear and removeAll refuse an id directory that is a link, and outside files stay", () => {
    mkdirSync(join(home, "secrets", "mcp"), { recursive: true });
    writeFileSync(join(outside, "keep"), "keep");
    linkDir(outside, join(home, "secrets", "mcp", "search"));
    const store = openMcpSecretStore(home);
    expect(message(() => store.set("search", "API_TOKEN", MARK))).toMatch(/symbolic link/);
    expect(message(() => store.clear("search", "keep"))).toMatch(/symbolic link|invalid secret name/);
    expect(message(() => store.removeAll("search"))).toMatch(/symbolic link/);
    expect(readdirSync(outside)).toEqual(["keep"]);
  });
});
