import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ReleaseLockBusyError, releaseLockPath, withReleaseLock } from './release-lock.mjs';

async function root(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'nema-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function exists(file) {
  try {
    await readFile(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

test('a lock is created for the duration of the call and removed afterwards', async (t) => {
  const dir = await root(t);
  const lock = releaseLockPath(dir);
  let seen;
  const result = await withReleaseLock(dir, 'release:cut', async () => {
    seen = JSON.parse(await readFile(lock, 'utf8'));
    return 'done';
  });
  assert.equal(result, 'done');
  assert.equal(seen.command, 'release:cut');
  assert.equal(seen.pid, process.pid);
  assert.equal(typeof seen.token, 'string');
  assert.equal(await exists(lock), false);
});

test('the lock is released when the call throws and the original error wins', async (t) => {
  const dir = await root(t);
  const lock = releaseLockPath(dir);
  await assert.rejects(
    withReleaseLock(dir, 'release:cut', async () => {
      throw new Error('inner failure');
    }),
    /inner failure/,
  );
  assert.equal(await exists(lock), false);
});

test('a second call waits for the first and then runs', async (t) => {
  const dir = await root(t);
  const order = [];
  let entered;
  const inside = new Promise((resolve) => { entered = resolve; });
  const first = withReleaseLock(dir, 'release:cut', async () => {
    order.push('first in');
    entered();
    await new Promise((resolve) => setTimeout(resolve, 120));
    order.push('first out');
  });
  // Start the second call only once the first holds the lock; both opens reach the thread pool,
  // so starting them in the same tick would not decide which one wins `wx`.
  await inside;
  const second = withReleaseLock(dir, 'release:stamp', async () => {
    order.push('second in');
  }, { lockWaitMs: 5_000, lockPollMs: 10 });
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first in', 'first out', 'second in']);
});

test('a held lock fails the second caller with the path, the holder, and the wait budget', async (t) => {
  const dir = await root(t);
  const lock = releaseLockPath(dir);
  const record = { schemaVersion: 1, command: 'release:cut', pid: 4242, token: 'held', startedAt: '2026-10-31T00:00:00.000Z' };
  await writeFile(lock, `${JSON.stringify(record)}\n`);
  await assert.rejects(
    withReleaseLock(dir, 'release:stamp', async () => assert.fail('must not run'), { lockWaitMs: 40, lockPollMs: 5 }),
    (error) => {
      assert.ok(error instanceof ReleaseLockBusyError);
      assert.match(error.message, /^release:stamp is blocked: another release command is already running/);
      assert.match(error.message, /pid 4242/);
      assert.match(error.message, /2026-10-31T00:00:00\.000Z/);
      assert.ok(error.message.includes(lock));
      assert.match(error.message, /delete/);
      return true;
    },
  );
  assert.equal(await exists(lock), true, 'a held lock is never stolen');
});

test('a leftover lock from a dead process is refused rather than taken over', async (t) => {
  const dir = await root(t);
  const lock = releaseLockPath(dir);
  await writeFile(lock, `${JSON.stringify({ schemaVersion: 1, command: 'release:cut', pid: 999_999, token: 'gone', startedAt: '2020-01-01T00:00:00.000Z' })}\n`);
  await assert.rejects(withReleaseLock(dir, 'release:cut', async () => {}, { lockWaitMs: 20, lockPollMs: 5 }), /pid 999999/);
  assert.equal(await exists(lock), true);
});

test('an unreadable lock is still a lock and is reported without a holder', async (t) => {
  const dir = await root(t);
  const lock = releaseLockPath(dir);
  await writeFile(lock, '');
  await assert.rejects(withReleaseLock(dir, 'release:cut', async () => {}, { lockWaitMs: 20, lockPollMs: 5 }), /unreadable/);
});

test('a lock replaced by another holder is not deleted by the previous caller', async (t) => {
  const dir = await root(t);
  const lock = releaseLockPath(dir);
  await withReleaseLock(dir, 'release:cut', async () => {
    await rm(lock);
    await writeFile(lock, `${JSON.stringify({ schemaVersion: 1, command: 'release:stamp', pid: 77, token: 'someone-else', startedAt: '2026-10-31T00:00:00.000Z' })}\n`);
  });
  assert.equal(await exists(lock), true, "another holder's lock survives our release");
  assert.equal(JSON.parse(await readFile(lock, 'utf8')).token, 'someone-else');
});

test('a lock whose record never landed is still removed by the caller that opened it', async (t) => {
  const dir = await root(t);
  const lock = releaseLockPath(dir);
  const real = await import('node:fs/promises');
  // The file really exists and stays empty: the record write fails after the exclusive open,
  // so no token is on disk to compare against.
  const broken = {
    async writeFile() {
      throw new Error('disk full while writing the record');
    },
    async close() {},
  };
  const release = await import('./release-lock.mjs');
  await assert.rejects(
    release.withReleaseLock(dir, 'release:cut', async () => assert.fail('must not run'), {
      open: async (target, flag) => {
        const handle = await real.open(target, flag);
        await handle.close();
        return broken;
      },
    }),
    /disk full while writing the record/,
  );
  assert.equal(await exists(lock), false, 'an unreadable lock from our own failed write must not leak');
});

/** Remove the lock between releaseOwn's token read and its unlink, the window a user can hit. */
function vanishBeforeDelete(lock) {
  return async (target) => {
    await rm(target);
    await unlink(target);
    throw Object.assign(new Error(`unlink ${target}`), { code: 'ENOENT' });
  };
}

test('a lock deleted by the user during a run does not fail that run', async (t) => {
  const dir = await root(t);
  const lock = releaseLockPath(dir);
  const result = await withReleaseLock(dir, 'release:cut', async () => 'cut finished', {
    unlink: vanishBeforeDelete(lock),
  });
  assert.equal(result, 'cut finished', 'the missing lock must not replace the result');
});

test('a lock deleted by the user during a failing run keeps the original error', async (t) => {
  const dir = await root(t);
  const lock = releaseLockPath(dir);
  await assert.rejects(
    withReleaseLock(dir, 'release:cut', async () => {
      throw new Error('the real failure');
    }, { unlink: vanishBeforeDelete(lock) }),
    /the real failure/,
  );
});

test('a cleanup that cannot remove an unreadable lock does not hide the write error', async (t) => {
  const dir = await root(t);
  const real = await import('node:fs/promises');
  const broken = {
    async writeFile() {
      throw new Error('disk full while writing the record');
    },
    async close() {},
  };
  await assert.rejects(
    withReleaseLock(dir, 'release:cut', async () => assert.fail('must not run'), {
      open: async (target, flag) => {
        const handle = await real.open(target, flag);
        await handle.close();
        return broken;
      },
      unlink: async () => {
        throw Object.assign(new Error('locked by another program'), { code: 'EPERM' });
      },
    }),
    /disk full while writing the record/,
  );
});
