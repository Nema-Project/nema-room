import { randomUUID } from "node:crypto";
import { closeSync, constants, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";

export class LockTimeoutError extends Error {
  constructor(readonly lockPath: string, readonly timeoutMs: number) {
    super(`Timed out after ${timeoutMs} ms waiting for lock ${lockPath}`);
    this.name = "LockTimeoutError";
  }
}

export type LockOptions = { timeoutMs?: number; pollMs?: number; staleMs?: number };

type Holder = { pid: number; at: number; token?: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH"; // EPERM: exists, owned by someone else
  }
}

function readRaw(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

function parseHolder(raw: string): Holder | null {
  try {
    const v = JSON.parse(raw) as Partial<Holder>;
    if (Number.isInteger(v.pid) && (v.pid as number) > 0 && typeof v.at === "number") return v as Holder;
  } catch {
    /* empty or partially written */
  }
  return null;
}

function isStale(path: string, raw: string, staleMs: number): boolean {
  const h = parseHolder(raw);
  if (h) return !pidAlive(h.pid);
  // Unreadable content (e.g. a holder that died between create and write): judge by age.
  try {
    return Date.now() - statSync(path).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

// Move the stale lock aside, then confirm we moved the one we judged stale. If a peer replaced it in
// between, put the peer's lock back (link fails if yet another lock already exists) and retry.
function takeOver(path: string, staleRaw: string): void {
  const tomb = `${path}.stale-${process.pid}-${randomUUID()}`;
  try {
    renameSync(path, tomb);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  try {
    if (readRaw(tomb) !== staleRaw) {
      try {
        linkSync(tomb, path);
      } catch {
        /* a newer lock exists; the moved one is lost to its owner, who will notice on release */
      }
    }
  } finally {
    try {
      unlinkSync(tomb);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Cross-process mutual exclusion via an exclusively created lock file holding `{pid, at, token}`.
 * A lock whose holder pid is gone is taken over. `staleMs` controls the heartbeat interval and
 * age-based recovery of malformed partial lock records; it never overrides a live holder pid.
 */
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const pollMs = opts.pollMs ?? 50;
  const staleMs = opts.staleMs ?? 30_000;
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token }));
      } finally {
        closeSync(fd);
      }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const raw = readRaw(lockPath);
    if (raw === null) continue; // released between our attempt and the read
    if (isStale(lockPath, raw, staleMs)) {
      takeOver(lockPath, raw);
      continue;
    }
    if (Date.now() >= deadline) throw new LockTimeoutError(lockPath, timeoutMs);
    await sleep(pollMs);
  }

  // Heartbeat records activity for diagnostics; live holders never expire by age.
  const heartbeat = setInterval(() => {
    try {
      const raw = readRaw(lockPath);
      if (raw === null || parseHolder(raw)?.token !== token) return; // not ours any more
      const fd = openSync(lockPath, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW); // never recreates
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token }));
      } finally {
        closeSync(fd);
      }
    } catch {
      /* best effort */
    }
  }, Math.max(1, Math.floor(staleMs / 3)));
  heartbeat.unref();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    try {
      const raw = readRaw(lockPath);
      if (raw !== null && parseHolder(raw)?.token === token) unlinkSync(lockPath);
    } catch {
      /* best effort: a valid lock we cannot remove becomes stale once this process exits */
    }
  }
}
