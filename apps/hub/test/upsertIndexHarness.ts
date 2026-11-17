import { expect, vi } from "vitest";
import { KnowledgeStore } from "@nema/knowledge";
import type { Entry } from "@nema/shared";
import type { Db } from "../src/db/db.js";

/** Pause the first write inside afterWrite so a second request queues behind its repo lock. */
export async function checkConcurrentUpsertIndex(db: Db, workspaceId: string, store: KnowledgeStore, write: (tags: string[]) => Response | Promise<Response>) {
  const original = KnowledgeStore.prototype.upsert;
  let entered!: () => void;
  const atFirstHook = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const snapshots: unknown[] = [];
  let writes = 0;
  const spy = vi.spyOn(KnowledgeStore.prototype, "upsert").mockImplementation(async function (this: KnowledgeStore, input, meta, guard, beforeWrite, afterWrite) {
    let written!: Entry;
    return original.call(this, input, meta, guard, async (entry, existing) => {
      written = entry;
      return beforeWrite?.(entry, existing);
    }, async commit => {
      await afterWrite?.(commit);
      snapshots.push(await db.query("select tags from entry_index where workspace_id=$1 and entry_id=$2", [workspaceId, written.id]));
      if (++writes === 1) {
        entered();
        await released;
      }
    });
  });
  const first = write(["first"]);
  let second: Response | Promise<Response> | undefined;
  try {
    await atFirstHook;
    second = write(["second"]);
    release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    // These snapshots happen before releasing the repository lock, not after the request returns.
    expect(snapshots).toEqual([[{ tags: ["first"] }], [{ tags: ["second"] }]]);
    expect((await store.get("R-1"))!.tags).toEqual(["second"]);
    expect(await db.query("select tags from entry_index where workspace_id=$1 and entry_id='R-1'", [workspaceId])).toEqual([{ tags: ["second"] }]);
  } finally {
    release();
    await Promise.allSettled([first, ...(second ? [second] : [])]);
    spy.mockRestore();
  }
}
