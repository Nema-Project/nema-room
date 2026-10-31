import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import type { NemaConfig } from "../config.js";
import { parseStoredAuth, usableSiwcLogin } from "../direct/authStore.js";
import { openPrivateFile, privateModeMatches, privateOwnerMatches, protectPrivatePath } from "../secrets/permissions.js";
import { fsyncDirectory } from "../secrets/durable.js";
import { accountDir } from "./store.js";
import { hasSymlinkedComponent } from "./paths.js";
import type { Account } from "./schema.js";

/**
 * Primitives for moving the 0.2.0 single-key credential into an account directory (spec 2026-10-31 D-6).
 *
 * Everything here assumes the source file is **untrusted**: it is the one file an older Nema, a rollback,
 * or `authByok` may still write, and it may also have been planted (a symlink, a world-readable copy, a
 * file owned by someone else). So the read validates before anything is copied, the copy writes the bytes
 * this process validated rather than re-reading the path, and the delete is refused unless the source is
 * still the exact file that was copied.
 */

export type FileIdentity = { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint };

/** A validated read of the legacy file: the bytes, and the identity of the file they came from. */
export type LegacyCredential = { path: string; bytes: Buffer; identity: FileIdentity };

const CONTROL = /[\u0000-\u001f\u007f]/;

const identityOf = (st: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint }): FileIdentity => ({
  dev: st.dev,
  ino: st.ino,
  size: st.size,
  mtimeNs: st.mtimeNs,
});

const sameIdentity = (a: FileIdentity, b: FileIdentity): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;

/** The 0.2.0 credential file name for this account's kind, or null when the kind owns no file (compat). */
export function legacyFileName(account: Pick<Account, "adapter" | "authMode">): string | null {
  if (account.adapter === "claude-code") return "claude-code-token";
  if (account.authMode === "byok") return "byok-key";
  if (account.authMode === "siwc") return "auth.json";
  return null;
}

/** The legacy credential path for this config, or null when the combination owns no file. */
export function legacyCredentialPath(nemaHome: string, config: NemaConfig): string | null {
  // Derived from `legacyFileName`, so the path a migration reads and the path credential inspection
  // reports can never drift apart.
  const name = legacyFileName({ adapter: config.adapter, authMode: config.authMode });
  return name === null ? null : path.join(nemaHome, name);
}

/** The account-layout file name for a legacy file: `key`, `token`, or `auth.json`. */
export function accountFileName(legacy: string): string {
  switch (path.basename(legacy)) {
    case "auth.json":
      return "auth.json";
    case "byok-key":
      return "key";
    default:
      return "token";
  }
}

/** The credential file an account should own, or null for a kind that owns none (compat). */
export function credentialFileName(account: Pick<Account, "adapter" | "authMode">): string | null {
  const legacy = legacyFileName(account);
  return legacy === null ? null : accountFileName(legacy);
}

/**
 * The file must be a private, owned, regular file before anything is read from it.
 *
 * `openPrivateFile` already refuses a link and checks the Windows ACL, but the POSIX checks are made here
 * on the very stat of the opened descriptor, so a file swapped between the two stats is caught too.
 */
function validateLegacyShape(file: string, mode: number, uid: number): void {
  if (!privateModeMatches({ mode })) throw new Error(`${path.basename(file)} 权限不是 0600，已拒绝迁移；原文件未改动。`);
  if (!privateOwnerMatches({ uid })) throw new Error(`${path.basename(file)} 不属于当前用户，已拒绝迁移；原文件未改动。`);
}

/** True when every rule for a credential of this kind holds. Used for both the source and its copy. */
export function isUsableCredentialFile(file: string, mode: number, uid: number, bytes: Buffer): boolean {
  try {
    validateLegacyShape(file, mode, uid);
  } catch {
    return false;
  }
  return contentIsUsable(path.basename(file), bytes);
}

/**
 * The content rule, shared by the migration and by the account reader: a key or token is one non-empty
 * line (a credential with a control character would leak into an HTTP header), and `auth.json` must be a
 * login the SIWC store would actually use. A syntactically valid record of the wrong mode, or with no
 * refresh token, cannot authenticate, so copying it would only move a broken login.
 */
function contentIsUsable(fileName: string, bytes: Buffer): boolean {
  if (fileName === "auth.json") {
    const auth = parseStoredAuth(bytes.toString("utf8"));
    return auth !== null && usableSiwcLogin(auth);
  }
  const value = bytes.toString("utf8").replace(/\r?\n$/, "");
  return value !== "" && !CONTROL.test(value);
}

function validateLegacyContent(file: string, bytes: Buffer): void {
  if (!contentIsUsable(path.basename(file), bytes)) {
    throw new Error(`${file} 不是可用的凭据（需要单行密钥或可用的直连登录），已拒绝迁移；原文件未改动。`);
  }
}

/**
 * Reads and validates the legacy credential. Throws instead of returning a partial or untrusted value:
 * a migration that cannot vouch for its source must not run, and the legacy file is left alone.
 */
export function readLegacyCredential(nemaHome: string, file: string): LegacyCredential {
  // A link anywhere from the home directory down to the file (home included) would read a foreign file.
  if (hasSymlinkedComponent(nemaHome, file)) {
    throw new Error(`旧凭据 ${file} 的路径是符号链接，已拒绝迁移；原文件未改动。`);
  }
  const before = lstatSync(file, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`旧凭据 ${file} 不是普通文件，已拒绝迁移；原文件未改动。`);
  }
  validateLegacyShape(file, Number(before.mode), Number(before.uid));

  const fd = openPrivateFile(file);
  let bytes: Buffer;
  let identity: FileIdentity;
  try {
    const st = fstatSync(fd, { bigint: true });
    if (!st.isFile() || st.dev !== before.dev || st.ino !== before.ino) {
      throw new Error(`旧凭据 ${file} 在读取过程中被替换，已拒绝迁移；原文件未改动。`);
    }
    validateLegacyShape(file, Number(st.mode), Number(st.uid));
    // Size and timestamps are taken from the same fstat as the identity, before the read.
    identity = identityOf(st);
    bytes = readFileSync(fd);
  } finally {
    closeSync(fd);
  }
  // Content rules run on what was read from the opened file, so a swap between stat and read cannot
  // slip an unvalidated value through.
  validateLegacyContent(file, bytes);
  return { path: file, bytes, identity };
}

/** True while `source` is still the very file that was read: same inode, size and mtime, same bytes. */
export function legacyUnchanged(nemaHome: string, source: LegacyCredential): boolean {
  try {
    if (hasSymlinkedComponent(nemaHome, source.path)) return false;
    const now = lstatSync(source.path, { bigint: true });
    if (now.isSymbolicLink() || !now.isFile()) return false;
    if (!sameIdentity(identityOf(now), source.identity)) return false;
    const fd = openPrivateFile(source.path);
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (!sameIdentity(identityOf(opened), source.identity)) return false;
      // mtime alone is not proof: a rewrite can land in the same timestamp tick, and the point of the
      // check is to never delete a credential this process did not copy.
      return readFileSync(fd).equals(source.bytes);
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * Retires the legacy file, but only while it is still the exact file that was copied: the name is first
 * moved to a private claim name, the claim is then checked against the bytes that were read, and only then
 * deleted. A file that is not that one (a newer credential saved meanwhile) is moved back into place, so a
 * peer's write is never the thing that gets deleted.
 *
 * The move is what makes this conditional: `unlink` by path is not, and between a check and an unlink a
 * writer can replace the file. Renaming is atomic, so exactly one file ends up in the claim and its
 * contents decide what happens next. If the restore also fails, the claim file is left on disk rather than
 * deleted: the credential is still recoverable, and nothing has been lost.
 */
export function removeLegacyIfUnchanged(nemaHome: string, source: LegacyCredential): boolean {
  const claim = `${source.path}.retire-${process.pid}-${randomUUID()}`;
  try {
    renameSync(source.path, claim);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false; // already gone: not ours to retire
    throw e;
  }
  const moved = readFileBytes(claim);
  if (moved !== null && moved.equals(source.bytes)) {
    try {
      unlinkSync(claim);
    } catch {
      /* left under the claim name: recoverable, and never mistaken for the live credential */
    }
    return true;
  }
  // A newer credential was in place: put it back where its writer expects it.
  restoreClaim(claim, source.path);
  return false;
}

/** The bytes of a regular file, or null. Used on a claim name, which nothing else writes. */
function readFileBytes(file: string): Buffer | null {
  try {
    if (!lstatSync(file).isFile()) return null;
    return readFileSync(file);
  } catch {
    return null;
  }
}

/**
 * Puts a claimed file back at its original name. `link` never replaces an existing file, so a peer that
 * saved yet another credential in the meantime keeps theirs; an exclusive copy is the last resort on
 * filesystems without hard links.
 */
function restoreClaim(claim: string, target: string): void {
  try {
    linkSync(claim, target);
    unlinkSync(claim);
    return;
  } catch {
    /* no hard links here, or the name is taken again */
  }
  try {
    copyFileSync(claim, target, constants.COPYFILE_EXCL);
    unlinkSync(claim);
  } catch {
    /* the claimed credential stays under its claim name; nothing was deleted */
  }
}

/**
 * Writes the already-validated bytes into the account's directory and makes them durable before the
 * caller may remove the legacy file: the file is fsynced, then the rename, then the directory entry.
 * The copy is read back through the private-file opener, so a copy that landed with the wrong mode or
 * owner fails the migration instead of becoming an account credential.
 */
export function writeCredentialCopy(nemaHome: string, accountId: string, fileName: string, bytes: Buffer): string {
  const dir = accountDir(nemaHome, accountId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  protectPrivatePath(dir, 0o700);
  const target = path.join(dir, fileName);
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    try {
      writeSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    protectPrivatePath(tmp, 0o600);
    renameSync(tmp, target); // replaces a partial copy from an interrupted run, never follows a link
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
  fsyncDirectory(dir);
  // Read back through the private opener and re-check the mode and owner of the file that landed: a copy
  // that is world-readable or foreign-owned must fail the migration, not become an account credential.
  const check = openPrivateFile(target);
  try {
    const st = fstatSync(check);
    if (!privateModeMatches(st) || !privateOwnerMatches(st) || !readFileSync(check).equals(bytes)) {
      throw new Error("账户凭据写入后校验失败");
    }
  } finally {
    closeSync(check);
  }
  return target;
}
