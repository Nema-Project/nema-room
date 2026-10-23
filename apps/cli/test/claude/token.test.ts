import { expectPrivate, makePublic } from "../nativePermissions.js";
import {
  chmodSync,
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
import { authClaude, claudeTokenPath, readClaudeToken, saveClaudeToken } from "../../src/claude/token.js";

function capture() {
  const lines: string[] = [];
  return { out: { log: (s: string) => lines.push(s), error: (s: string) => lines.push(s) }, text: () => lines.join("\n") };
}

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nema-claude-token-test-"));
  home = join(root, "nema");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("Claude Code token file", () => {
  test("round-trips one line with mode 0600", () => {
    saveClaudeToken(home, "sekret-token");

    expect(claudeTokenPath(home)).toBe(join(home, "claude-code-token"));
    expect(readClaudeToken(home)).toBe("sekret-token");
    expectPrivate(join(home, "claude-code-token"), 0o600);
  });

  test.each(["", "first\nsecond"])("rejects invalid token %j without changing the existing file", (token) => {
    mkdirSync(home, { recursive: true });
    const file = join(home, "claude-code-token");
    writeFileSync(file, "original", { mode: 0o600 });

    expect(() => saveClaudeToken(home, token)).toThrow("token 必须是一行非空文本");
    expect(readFileSync(file, "utf8")).toBe("original");
  });

  test("rejects a symlink without changing its target", () => {
    mkdirSync(home, { recursive: true });
    const target = join(root, "target");
    writeFileSync(target, "original");
    symlinkSync(target, join(home, "claude-code-token"));

    expect(() => saveClaudeToken(home, "sekret-token")).toThrow("Claude Code token 文件是符号链接，已拒绝。");
    expect(readFileSync(target, "utf8")).toBe("original");
  });

  test("requires an existing mode-0600 token file", () => {
    expect(() => readClaudeToken(home)).toThrow(
      "没有 Claude Code token。请运行 claude setup-token，再把令牌从标准输入交给 nema auth claude。",
    );
    mkdirSync(home, { recursive: true });
    const file = join(home, "claude-code-token");
    writeFileSync(file, "sekret-token", { mode: 0o600 });
    makePublic(file);
    expect(() => readClaudeToken(home)).toThrow("Claude Code token 文件权限必须是 0600");
  });
});

test("authClaude reads stdin and never prints the token", async () => {
  const c = capture();

  expect(await authClaude({ nemaHome: home, out: c.out, stdin: Readable.from(["  sekret-token  \n"]) })).toBe(0);
  expect(readClaudeToken(home)).toBe("sekret-token");
  expect(c.text()).toContain("已保存 Claude Code token");
  expect(c.text()).not.toContain("sekret-token");
});
