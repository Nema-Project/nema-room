import { randomUUID } from 'node:crypto';
import { open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';

/** Exclusive lock file at the repository root. `.git` is a file inside a worktree, so the lock cannot live there. */
const LOCK_NAME = '.nema-release.lock';
const DEFAULT_WAIT_MS = 5_000;
const DEFAULT_POLL_MS = 50;

/** Another release command holds the lock. Never resolved by taking the lock away from it. */
export class ReleaseLockBusyError extends Error {
  constructor(lockPath, holder, waitMs, command) {
    super(
      `${command} is blocked: another release command is already running — ${describe(holder)} holds ${lockPath}. ` +
        `Waited ${waitMs}ms. If that process is gone, delete the lock file and run ${command} again.`,
    );
    this.name = 'ReleaseLockBusyError';
    this.lockPath = lockPath;
    this.holder = holder;
    this.waitMs = waitMs;
  }
}

export function releaseLockPath(root) {
  return path.join(root, LOCK_NAME);
}

function describe(holder) {
  if (!holder) return 'an unreadable lock file';
  const command = typeof holder.command === 'string' ? holder.command : 'an unknown command';
  const pid = Number.isInteger(holder.pid) ? `pid ${holder.pid}` : 'an unknown pid';
  const startedAt = typeof holder.startedAt === 'string' ? holder.startedAt : 'an unknown time';
  return `${command} (${pid}, started ${startedAt})`;
}

async function readHolder(lockPath) {
  try {
    const parsed = JSON.parse(await readFile(lockPath, 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Delete the lock only when it still carries this call's token.
 * A lock another command created after ours disappeared is left alone.
 * `created` means this call opened the file with `wx` and has not released it, so the file is ours
 * even when the record inside it cannot be read (the write failed before the content landed).
 */
async function releaseOwn(lockPath, token, created) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(lockPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    if (error instanceof SyntaxError) {
      if (created) await unlink(lockPath).catch(() => {});
      return;
    }
    throw error;
  }
  if (parsed?.token !== token) return;
  await unlink(lockPath);
}

/**
 * Run `fn` while holding the release lock in `root`; the lock is released even when `fn` throws.
 * A held lock is never stolen: pid liveness and file age both misjudge (a reaped pid looks dead to
 * its parent, an unreaped one looks alive), and a wrong takeover puts two writers on one tree.
 * `options.lockWaitMs` and `options.lockPollMs` keep that wait injectable for tests.
 */
export async function withReleaseLock(root, command, fn, options = {}) {
  const lockPath = releaseLockPath(root);
  const waitMs = options.lockWaitMs ?? DEFAULT_WAIT_MS;
  const pollMs = options.lockPollMs ?? DEFAULT_POLL_MS;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const token = randomUUID();
  const openFile = options.open ?? open;
  const deadline = Date.now() + waitMs;
  let handle;
  for (;;) {
    try {
      handle = await openFile(lockPath, 'wx');
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new ReleaseLockBusyError(lockPath, await readHolder(lockPath), waitMs, command);
      await sleep(pollMs);
    }
  }
  let created = false;
  try {
    const record = { schemaVersion: 1, command, pid: process.pid, token, startedAt: new Date().toISOString() };
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    created = true;
  } catch (error) {
    await handle.close();
    // The record never landed, so no token can be compared; the file is still the one this call opened.
    await releaseOwn(lockPath, token, true);
    throw error;
  }
  await handle.close();
  try {
    return await fn();
  } finally {
    await releaseOwn(lockPath, token, created);
  }
}
