import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Out } from "../direct/authCommands.js";
import { openPrivateFile, privateModeMatches, protectPrivatePath } from "../secrets/permissions.js";
// One sentence for this, shared with the routing layer's account messages: two copies drift apart the moment
// one of them is edited.
import { MISSING_CLAUDE_TOKEN } from "../routing/messages.js";

const INVALID_TOKEN = "token 必须是一行非空文本";
const SYMLINK_TOKEN = "Claude Code token 文件是符号链接，已拒绝。";
export const MISSING_TOKEN = MISSING_CLAUDE_TOKEN;
const TOKEN_MODE = "Claude Code token 文件权限必须是 0600";

export const claudeTokenPath = (nemaHome: string): string => path.join(nemaHome, "claude-code-token");

export function saveClaudeToken(nemaHome: string, token: string): void {
  if (token === "" || token.includes("\n") || token.includes("\r")) throw new Error(INVALID_TOKEN);
  const file = claudeTokenPath(nemaHome);
  try {
    if (lstatSync(file).isSymbolicLink()) throw new Error(SYMLINK_TOKEN);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  mkdirSync(nemaHome, { recursive: true, mode: 0o700 });
  protectPrivatePath(nemaHome, 0o700);
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    try {
      writeSync(fd, token);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // A new Windows file can inherit an owner/DACL that differs from its private parent.
    // Protect the completed temporary secret before it becomes the active credential.
    protectPrivatePath(tmp, 0o600);
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

export function readClaudeToken(nemaHome: string): string {
  const file = claudeTokenPath(nemaHome);
  let fd: number;
  try {
    fd = openPrivateFile(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(MISSING_TOKEN);
    if ((e as NodeJS.ErrnoException).code === "ELOOP") throw new Error(SYMLINK_TOKEN);
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || !privateModeMatches(st)) throw new Error(TOKEN_MODE);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

export async function authClaude(o: { nemaHome: string; out: Out; stdin: NodeJS.ReadableStream }): Promise<number> {
  const lines = createInterface({ input: o.stdin });
  let token = "";
  for await (const line of lines) {
    token = line.trim();
    break;
  }
  lines.close();
  try {
    saveClaudeToken(o.nemaHome, token);
    o.out.log("已保存 Claude Code token");
    return 0;
  } catch (e) {
    o.out.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
