import type { Message } from "./messages.js";
import type { UiTask } from "./tasks.js";
import type { Thread } from "@nema/shared";

export type HubEvent =
  | { type: "message.created"; message: Message }
  /** An existing message changed, for example a report once its check is stored. */
  | { type: "message.updated"; message: Message }
  /** `reasonOnly` marks a republish of the waiting reason only: the dispatch subscriber skips it. */
  | { type: "task.updated"; task: UiTask; reasonOnly?: true }
  | { type: "thread.updated"; thread: Thread }
  | { type: "task.progress"; taskId: string; threadId: string | null; text: string }
  | { type: "knowledge.changed"; entryId: string }
  | { type: "daemon.status"; connected: boolean }
  | { type: "workspace.deleted"; workspaceId: string }
  | { type: "repo.moved"; repoId: string; mainRef: string; from: string | null; to: string }
  /** Bind-time code index. `running` is the progress line; `done` and `failed` clear it. */
  | { type: "repo.index"; repoId: string; label: string; status: "running" | "done" | "failed" };

type Listener = (workspaceId: string, e: HubEvent) => void;

/** Global events (daemon status) are delivered with workspaceId "" to subscribeAll only. */
export class EventBus {
  private byWs = new Map<string, Set<(e: HubEvent) => void>>();
  private all = new Set<Listener>();

  emit(workspaceId: string, e: HubEvent): void {
    for (const fn of [...(this.byWs.get(workspaceId) ?? [])]) fn(e);
    for (const fn of [...this.all]) fn(workspaceId, e);
  }

  emitGlobal(e: HubEvent): void {
    for (const fn of [...this.all]) fn("", e);
  }

  subscribe(workspaceId: string, fn: (e: HubEvent) => void): () => void {
    let set = this.byWs.get(workspaceId);
    if (!set) this.byWs.set(workspaceId, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0 && this.byWs.get(workspaceId) === set) this.byWs.delete(workspaceId);
    };
  }

  subscribeAll(fn: Listener): () => void {
    this.all.add(fn);
    return () => void this.all.delete(fn);
  }

  /**
   * Access revocation, kept apart from HubEvent so it is never written to any stream. A workspace event
   * stream checks membership only when it opens, so it registers here and closes when its user leaves
   * the roster (#167 task 8).
   */
  private revokers = new Map<string, Set<() => void>>();

  onRevoke(workspaceId: string, userId: string, fn: () => void): () => void {
    const key = `${workspaceId}\0${userId}`;
    let set = this.revokers.get(key);
    if (!set) this.revokers.set(key, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0 && this.revokers.get(key) === set) this.revokers.delete(key);
    };
  }

  revoke(workspaceId: string, userId: string): void {
    for (const fn of [...(this.revokers.get(`${workspaceId}\0${userId}`) ?? [])]) fn();
  }
}
