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
import { CodedError, TASK_ERROR } from "@nema/shared";
import { openPrivateFile, privateModeMatches, privateOwnerMatches, protectPrivatePath } from "./permissions.js";

export type SecretFileErrorKind = "invalid" | "symlink" | "mode";

/**
 * Errors from the secret-file helpers. Messages name the file, never its contents. A refused read has a code
 * (#299 batch 3a) naming the file, so a task that fails on it is shown in the user's language; a refused save
 * (`invalid`) is a terminal or settings-page message and has none.
 */
export class SecretFileError extends CodedError {
  constructor(
    readonly kind: SecretFileErrorKind,
    message: string,
    file?: string,
  ) {
    const code = kind === "symlink" ? TASK_ERROR.secretFileSymlink : kind === "mode" ? TASK_ERROR.secretFileMode : "";
    super(code, message, file !== undefined ? { file: path.basename(file) } : undefined);
    this.name = "SecretFileError";
  }
}

/** A sentence for a missing or invalid secret, with the code a task failure shows it by when it has one. */
export type SecretMessage = string | { code: string; message: string };

const secretError = (m: SecretMessage): Error => (typeof m === "string" ? new Error(m) : new CodedError(m.code, m.message));

const INVALID_VALUE = "必须是一行非空文本";

// Secrets go into HTTP headers and child environments. Control characters there leak into error text.
const isValidLine = (value: string): boolean => value !== "" && !/[\u0000-\u001f\u007f]/.test(value);

const symlinkError = (file: string) => new SecretFileError("symlink", `${path.basename(file)} 文件是符号链接，已拒绝。`, file);

/** Atomically writes one line to `file` with mode 0600. Refuses a symlink; on reject the existing file is untouched. */
export function saveSecretLine(file: string, value: string, dirMode = 0o700): void {
  if (!isValidLine(value)) throw new SecretFileError("invalid", INVALID_VALUE);
  try {
    if (lstatSync(file).isSymbolicLink()) throw symlinkError(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: dirMode });
  protectPrivatePath(dir, dirMode);
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    try {
      writeSync(fd, value);
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

/** Reads one line from a 0600 regular file without following symlinks. The value is never echoed in errors. */
export function readSecretLine(file: string, missingMessage: SecretMessage, invalidMessage: SecretMessage): string {
  let fd: number;
  try {
    fd = openPrivateFile(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw secretError(missingMessage);
    if ((e as NodeJS.ErrnoException).code === "ELOOP") throw symlinkError(file);
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || !privateModeMatches(st)) {
      throw new SecretFileError("mode", `${path.basename(file)} 文件权限必须是 0600`, file);
    }
    if (!privateOwnerMatches(st)) throw secretError(invalidMessage);
    // Hand-written files usually end in one newline. Anything else is never echoed back.
    const value = readFileSync(fd, "utf8").replace(/\r?\n$/, "");
    if (!isValidLine(value)) throw secretError(invalidMessage);
    return value;
  } finally {
    closeSync(fd);
  }
}

/** Reads the first line of stdin, trimmed. */
export async function readStdinLine(stdin: NodeJS.ReadableStream): Promise<string> {
  const lines = createInterface({ input: stdin });
  let value = "";
  for await (const line of lines) {
    value = line.trim();
    break;
  }
  lines.close();
  return value;
}
