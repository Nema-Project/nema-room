import type { OwnedHelperProcess, OwnedHelperScope, OwnedHelperSpawnOptions, OwnedHelperSpawner } from "@nema/shared/ownedHelper";
import { spawnOwned } from "@nema/cli/ownedProcess";

/**
 * Owns the helper leases for one local core. Starts are registered before awaiting guardian readiness,
 * and shutdown aborts pending starts and active targets before waiting for every actual pipe close.
 */
export function createOwnedHelperScope(guardianPath: string, start?: OwnedHelperSpawner): OwnedHelperScope {
  const abort = new AbortController();
  const starting = new Set<Promise<OwnedHelperProcess>>();
  const closing = new Set<Promise<unknown>>();
  const startOwned = start ?? ((command, args, options) => spawnOwned(guardianPath, command, args, options));
  let accepting = true;
  let drainPromise: Promise<void> | undefined;

  return {
    spawn(command: string, args: string[], options: OwnedHelperSpawnOptions = {}): Promise<OwnedHelperProcess> {
      if (!accepting) return Promise.reject(new Error("Managed helper scope is shutting down"));
      const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
      const pending = Promise.resolve().then(() => startOwned(command, args, { ...options, signal }));
      starting.add(pending);
      void pending.then((child) => {
        starting.delete(pending);
        const closed = child.closed.finally(() => closing.delete(closed));
        closing.add(closed);
      }, () => starting.delete(pending));
      return pending;
    },
    stopAccepting(): void {
      if (!accepting) return;
      accepting = false;
      abort.abort();
    },
    drain(): Promise<void> {
      if (drainPromise) return drainPromise;
      accepting = false;
      abort.abort();
      drainPromise = (async () => {
        while (starting.size > 0 || closing.size > 0) {
          await Promise.allSettled([...starting]);
          await Promise.all([...closing]);
        }
      })();
      return drainPromise;
    },
  };
}
