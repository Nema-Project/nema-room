import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { authLogout } from "../../src/direct/authCommands.js";
import { AuthStore } from "../../src/direct/authStore.js";
import { authByok, ByokTokenSource, readByokKey, saveByokKey } from "../../src/direct/byok.js";
import { siwcRefresher } from "../../src/direct/siwc.js";

function capture() {
  const lines: string[] = [];
  return { out: { log: (s: string) => lines.push(s), error: (s: string) => lines.push(s) }, text: () => lines.join("\n") };
}

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nema-byok-test-"));
  home = join(root, "nema");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("BYOK key file", () => {
  test("round-trips one line with mode 0600", () => {
    saveByokKey(home, "sekret-key");

    expect(readByokKey(home)).toBe("sekret-key");
    expect(lstatSync(join(home, "byok-key")).mode & 0o777).toBe(0o600);
  });

  test.each(["", "first\nsecond", "tab\tkey", "nul\u0000key"])("rejects invalid key %j without changing the existing file", (key) => {
    mkdirSync(home, { recursive: true });
    const file = join(home, "byok-key");
    writeFileSync(file, "original", { mode: 0o600 });

    expect(() => saveByokKey(home, key)).toThrow("key 必须是一行非空文本");
    expect(readFileSync(file, "utf8")).toBe("original");
  });

  test("rejects a symlink without changing its target", () => {
    mkdirSync(home, { recursive: true });
    const target = join(root, "target");
    writeFileSync(target, "original");
    symlinkSync(target, join(home, "byok-key"));

    expect(() => saveByokKey(home, "sekret-key")).toThrow("BYOK key 文件是符号链接，已拒绝。");
    expect(readFileSync(target, "utf8")).toBe("original");
  });

  test("accepts a hand-written file ending in one newline", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "byok-key"), "sekret-key\n", { mode: 0o600 });

    expect(readByokKey(home)).toBe("sekret-key");
  });

  test.each(["", "\n", "sekret-a\nsekret-b", "sekret-a\r\n\r\n", "sekret\u0007key"])(
    "rejects hand-written file content %j without echoing it",
    (content) => {
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "byok-key"), content, { mode: 0o600 });

      let message = "";
      try {
        readByokKey(home);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toBe("BYOK key 文件内容无效。请重新把钥匙从标准输入交给 nema auth byok。");
      expect(message).not.toContain("sekret");
    },
  );

  test("requires an existing mode-0600 key file", () => {
    expect(() => readByokKey(home)).toThrow("没有 BYOK API key。请把钥匙从标准输入交给 nema auth byok。");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "byok-key"), "sekret-key", { mode: 0o644 });
    expect(() => readByokKey(home)).toThrow("BYOK key 文件权限必须是 0600");
  });
});

test("authByok reads stdin and never prints the key", async () => {
  const c = capture();

  expect(await authByok({ nemaHome: home, out: c.out, stdin: Readable.from(["  sekret-key  \n"]) })).toBe(0);
  expect(readByokKey(home)).toBe("sekret-key");
  expect(c.text()).toContain("已保存 BYOK API key");
  expect(c.text()).not.toContain("sekret-key");
});

test("ByokTokenSource rereads the key on forced access without writing auth.json", async () => {
  saveByokKey(home, "first-key");
  const source = new ByokTokenSource(home);
  saveByokKey(home, "second-key");

  const result = await source.getAccessToken({ force: true });

  expect(result.accessToken).toBe("second-key");
  expect(result.auth.mode).toBe("byok");
  expect(result.auth.tokens.refresh_token).toBe("");
  expect(existsSync(join(home, "auth.json"))).toBe(false);
});

test("auth.json still rejects a stored byok mode", () => {
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "auth.json"),
    JSON.stringify({
      version: 1,
      mode: "byok",
      clientId: "",
      tokens: { access_token: "sekret-key", refresh_token: "" },
      lastRefresh: "2026-10-23T00:00:00.000Z",
    }),
    { mode: 0o600 },
  );

  expect(new AuthStore(home, siwcRefresher).read()).toBeNull();
});

test("authLogout leaves the BYOK key bytes unchanged", async () => {
  saveByokKey(home, "sekret-key");
  writeFileSync(
    join(home, "auth.json"),
    JSON.stringify({
      version: 1,
      mode: "siwc",
      clientId: "client",
      tokens: { access_token: "access", refresh_token: "refresh" },
      lastRefresh: "2026-10-23T00:00:00.000Z",
    }),
    { mode: 0o600 },
  );
  const before = readFileSync(join(home, "byok-key"));

  expect(await authLogout({ nemaHome: home, out: capture().out })).toBe(0);
  expect(existsSync(join(home, "auth.json"))).toBe(false);
  expect(readFileSync(join(home, "byok-key"))).toEqual(before);
});
