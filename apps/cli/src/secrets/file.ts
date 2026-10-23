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

export type SecretFileErrorKind = "invalid" | "symlink" | "mode";

/** Errors from the secret-file helpers. Messages name the file, never its contents. */
export class SecretFileError extends Error {
  constructor(
    readonly kind: SecretFileErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "SecretFileError";
  }
}

const INVALID_VALUE = "必须是一行非空文本";

// Secrets go into HTTP headers and child environments. Control characters there leak into error text.
const isValidLine = (value: string): boolean => value !== "" && !/[\u0000-\u001f\u007f]/.test(value);

const symlinkError = (file: string) => new SecretFileError("symlink", `${path.basename(file)} 文件是符号链接，已拒绝。`);

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
  if (statSync(dir).mode & 0o777 & ~dirMode) chmodSync(dir, dirMode);
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    try {
      writeSync(fd, value);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
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
export function readSecretLine(file: string, missingMessage: string, invalidMessage: string): string {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(missingMessage);
    if ((e as NodeJS.ErrnoException).code === "ELOOP") throw symlinkError(file);
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || (st.mode & 0o777) !== 0o600) {
      throw new SecretFileError("mode", `${path.basename(file)} 文件权限必须是 0600`);
    }
    // Hand-written files usually end in one newline. Anything else is never echoed back.
    const value = readFileSync(fd, "utf8").replace(/\r?\n$/, "");
    if (!isValidLine(value)) throw new Error(invalidMessage);
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
