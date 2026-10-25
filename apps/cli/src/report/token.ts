// The local report token (~/.nema/report-token): 0600, 32 random bytes as hex. Never printed or logged.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { openPrivateFile, privateModeMatches, protectPrivatePath } from "../secrets/permissions.js";

const TOKEN_RE = /^[0-9a-f]{64}$/;
const SYMLINK = "上报令牌文件是符号链接，已拒绝";
const BAD_MODE = "上报令牌文件权限必须是 0600";
const BAD_TOKEN = "上报令牌文件内容无效";

export const reportTokenPath = (nemaHome: string): string => path.join(nemaHome, "report-token");

/** Reads the token, or returns null when the file does not exist. Refuses a symlink or a mode other than 0600. */
function readReportToken(nemaHome: string): string | null {
  let fd: number;
  try {
    fd = openPrivateFile(reportTokenPath(nemaHome));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") throw new Error(SYMLINK);
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || !privateModeMatches(st)) throw new Error(BAD_MODE);
    const token = readFileSync(fd, "utf8").trim();
    if (!TOKEN_RE.test(token)) throw new Error(BAD_TOKEN);
    return token;
  } finally {
    closeSync(fd);
  }
}

/** Creates the token if missing (0600, atomic, never overwriting a concurrent writer's), else reads and checks it. */
export function ensureReportToken(nemaHome: string): string {
  const existing = readReportToken(nemaHome);
  if (existing !== null) return existing;
  const file = reportTokenPath(nemaHome);
  try {
    if (lstatSync(file).isSymbolicLink()) throw new Error(SYMLINK);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  mkdirSync(nemaHome, { recursive: true, mode: 0o700 });
  protectPrivatePath(nemaHome, 0o700);
  const token = randomBytes(32).toString("hex");
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    try {
      writeSync(fd, token);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      // link (not rename) fails with EEXIST instead of replacing a token another process just created.
      linkSync(tmp, file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const raced = readReportToken(nemaHome);
      if (raced === null) throw e;
      return raced;
    }
    return token;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

/** sha256 hex of the token, or null when the token file does not exist. */
export function reportTokenHash(nemaHome: string): string | null {
  const token = readReportToken(nemaHome);
  return token === null ? null : createHash("sha256").update(token).digest("hex");
}
