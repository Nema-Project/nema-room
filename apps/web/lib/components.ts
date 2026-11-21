"use client";

// One shared view of the optional Graphify component for every place that shows it (settings, the code
// section's graph entry). It is fetched when such a place is shown, never at app start, and polled only while
// an install runs. A decline is remembered per lock-hash, so the same version is offered again only when the
// person presses install themselves.
import { useEffect, useSyncExternalStore } from "react";
import { cancelComponentInstall, getComponents, installComponent, updateComponentSettings } from "./hub";
import type { ComponentView } from "./types";

export type ComponentsSnapshot = {
  graphify: ComponentView | null;
  /** The hub or daemon could not answer; graph entries say so quietly and the rest of the app carries on. */
  error: string | null;
  loaded: boolean;
};

const EMPTY: ComponentsSnapshot = { graphify: null, error: null, loaded: false };
export const POLL_MS = 1000;
export const DECLINED_KEY = "nema.components.declined.graphify";

let snapshot: ComponentsSnapshot = EMPTY;
const listeners = new Set<() => void>();
let inflight: Promise<ComponentsSnapshot> | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
/** Bumped by every mutation (install/cancel/settings) so a GET started before it is discarded, not published. */
let mutationEpoch = 0;
/**
 * Bumped whenever a published view carries a fresh lifecycle observation — a new status
 * object, even when it carries the same state as the one it replaces. A settings answer's
 * status is current only if no lifecycle publication landed while the save was in flight: a
 * poll does not move mutationEpoch, so the mutation epoch alone cannot tell a settings
 * answer that a newer GET already published the install's outcome. A GET that republishes
 * `not-installed` after another client cancelled an install still proves the install is
 * over, and a settings answer carrying the stale `installing` it captured before that
 * cancellation must not restore it. A failed GET publishes the unchanged snapshot, so it
 * never moves this epoch.
 */
let statusEpoch = 0;

function publish(next: ComponentsSnapshot): void {
  if (next.graphify && next.graphify.status !== snapshot.graphify?.status) statusEpoch += 1;
  snapshot = next;
  for (const listener of listeners) listener();
  schedulePoll();
}

function schedulePoll(): void {
  if (pollTimer || listeners.size === 0 || snapshot.graphify?.status.state !== "installing") return;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void refreshComponents();
  }, POLL_MS);
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * A mutation's answer. The epoch moves here as well as when the request was sent: a GET that started
 * after the request but was answered by the daemon before the daemon registered the install would
 * otherwise publish its older `not-installed` over this `installing` state and stop the poll.
 */
function accept(view: ComponentView): void {
  mutationEpoch += 1;
  publish({ graphify: view, error: null, loaded: true });
}

/**
 * A settings save's answer. The view it carries was composed when the daemon processed the
 * request, so its lifecycle state can predate an install or cancel that landed while the save
 * was in flight: publishing it whole would hide the progress and the Cancel button, and stop
 * the poll. The answer is authoritative for the settings it changed and for the offer those
 * settings imply — a mirror change moves the download hosts, so a confirmation built from a
 * stale offer would show the old hosts while the download contacts the new ones. Merge those
 * into the current view, and take the answer's status too when it is still current: turning
 * offline mode off can move the status from a recorded offline failure to not-installed, and
 * keeping the old status would hide Install until a refresh. The status is current only when
 * nothing newer arrived since the save was sent (an install, cancel, or another save that
 * landed in between owns the lifecycle state), no lifecycle publication landed in between
 * (a poll does not move the mutation epoch), and no install is running now. The offer is
 * applied only while it is still the offer the person was shown: an install or cancel that
 * published a newer offer (a different lock) while the save was in flight must not be
 * overwritten with the older one this answer carries. When the answer's offer and the
 * published one disagree — different locks, or one side has no offer at all — neither is
 * provably current, so a fresh read decides instead of leaving a stale lock, mirror hosts,
 * or a discarded offer error in place. A lifecycle publication that landed in between is
 * reconciled the same way: it may be a delayed GET's older observation (a GET that captured
 * not-installed before an install started can publish after the PATCH's answer was composed),
 * and keeping it would miss the active install and stop the poll. The fresh read is issued
 * after the PATCH's answer arrived, so the daemon has registered the install by then. The
 * fresh read also decides the offer whenever its own offer disagrees with the answer's —
 * the lock may have changed again while the PATCH was in flight. When
 * the refresh itself cannot reach the daemon, the published offer stands — it came from a
 * real daemon response — but the refresh's error stays visible instead of being cleared:
 * the offer is unverified until a fresh read succeeds, and the dialog will not confirm it.
 */
async function acceptSettings(view: ComponentView, sentEpoch: number, sentStatusEpoch: number): Promise<void> {
  const arrivedEpoch = mutationEpoch;
  const arrivedStatusEpoch = statusEpoch;
  mutationEpoch += 1;
  const current = snapshot.graphify;
  if (!current) {
    publish({ graphify: view, error: null, loaded: true });
    return;
  }
  const statusStale = current.status.state !== "installing" && (arrivedEpoch !== sentEpoch || arrivedStatusEpoch !== sentStatusEpoch);
  const conflict =
    (current.offer && view.offer && current.offer.lockHash !== view.offer.lockHash) || (!current.offer && view.offer) || (current.offer && !view.offer);
  let refreshError: string | null = null;
  if (statusStale || conflict) {
    const fresh = await refreshComponents();
    if (!fresh.error && fresh.graphify) {
      // The fresh read decides the offer whenever its offer disagrees with the answer's:
      // the lock may have changed again while the PATCH was in flight (or the offer
      // vanished), and restoring the answer's older offer would leave a stale lock on the
      // page that the daemon then rejects at confirm time.
      const freshOfferDiffers =
        (fresh.graphify.offer && view.offer && fresh.graphify.offer.lockHash !== view.offer.lockHash) ||
        (!fresh.graphify.offer && view.offer) ||
        (fresh.graphify.offer && !view.offer);
      if (conflict || freshOfferDiffers) {
        publish({ graphify: { ...fresh.graphify, settings: view.settings }, error: null, loaded: true });
      } else {
        // Only the status needed reconciling: the answer's offer is authoritative while the
        // locks match, and the fresh read's offer would discard the mirror change it carries.
        publish({ graphify: { ...current, settings: view.settings, offer: view.offer, offerError: view.offerError, status: fresh.graphify.status }, error: null, loaded: true });
      }
      return;
    }
    refreshError = fresh.error;
  }
  const status = current.status.state === "installing" || arrivedEpoch !== sentEpoch || arrivedStatusEpoch !== sentStatusEpoch ? current.status : view.status;
  const offer = view.offer && (!current.offer || current.offer.lockHash === view.offer.lockHash) ? view.offer : current.offer;
  const offerError = offer === view.offer ? view.offerError : current.offerError;
  publish({ graphify: { ...current, settings: view.settings, offer, offerError, status }, error: refreshError, loaded: true });
}

/**
 * The one shared GET, joined by every caller. A response that predates a mutation (an install that started
 * after this GET) is discarded and fetched once more: publishing it would overwrite the newer `installing`
 * state with `not-installed` and stop the poll, losing progress and cancel access while the installer runs.
 */
export function refreshComponents(): Promise<ComponentsSnapshot> {
  if (inflight) return inflight;
  const seen = mutationEpoch;
  const task = (async (): Promise<ComponentsSnapshot> => {
    try {
      const body = await getComponents();
      const next = { graphify: body.components.find((row) => row.name === "graphify") ?? null, error: null, loaded: true };
      if (seen !== mutationEpoch) {
        inflight = null;
        return refreshComponents();
      }
      publish(next);
      return next;
    } catch (error: unknown) {
      const next = { ...snapshot, error: message(error), loaded: true };
      if (seen !== mutationEpoch) {
        inflight = null;
        return refreshComponents();
      }
      publish(next);
      return next;
    }
  })();
  inflight = task;
  void task.finally(() => {
    if (inflight === task) inflight = null;
  });
  return task;
}

/** Starts the download the person just confirmed: the lock-hash of the offer they saw, nothing else. */
export async function startGraphifyInstall(lockHash: string, opts: { force?: boolean } = {}): Promise<void> {
  // The epoch moves before the POST is sent: a GET already in flight must not publish its older answer
  // over the `installing` state this call is about to produce.
  mutationEpoch += 1;
  clearDeclined();
  // The third argument is passed only for a repair: existing callers assert the two-argument call.
  accept(await (opts.force === true ? installComponent("graphify", lockHash, true) : installComponent("graphify", lockHash)));
}

export async function cancelGraphifyInstall(): Promise<ComponentView> {
  mutationEpoch += 1;
  const view = await cancelComponentInstall("graphify");
  accept(view);
  return view;
}

/** Settings saves run one at a time: overlapping saves could otherwise publish out of order. */
let settingsQueue: Promise<void> = Promise.resolve();

export async function saveGraphifySettings(patch: { pythonMirror?: string | null; pypiBase?: string | null; offline?: boolean }): Promise<void> {
  const task = settingsQueue.then(async () => {
    // The invalidation happens when the save is actually sent, not when it is queued:
    // queueing a second save must not invalidate the first save's answer. The epochs are
    // captured here, at send time, so the answer's status is judged against what arrived
    // after this point.
    mutationEpoch += 1;
    const sentEpoch = mutationEpoch;
    const sentStatusEpoch = statusEpoch;
    await acceptSettings(await updateComponentSettings("graphify", patch), sentEpoch, sentStatusEpoch);
  });
  // The queue runs past a failed save; the failure itself still reaches this save's caller.
  settingsQueue = task.catch(() => {});
  return task;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  schedulePoll();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  };
}

const getSnapshot = () => snapshot;
const getServerSnapshot = () => EMPTY;

/** The shared component view; each component that shows it asks the daemon once when it mounts. */
export function useComponents(): ComponentsSnapshot {
  const current = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  useEffect(() => {
    void refreshComponents();
  }, []);
  return current;
}

export function declinedLockHash(): string | null {
  try {
    return localStorage.getItem(DECLINED_KEY);
  } catch {
    return null;
  }
}

export function rememberDeclined(lockHash: string): void {
  try {
    localStorage.setItem(DECLINED_KEY, lockHash);
  } catch {
    /* storage unavailable: the offer may come back on the next graph action, which is still the person's own */
  }
}

function clearDeclined(): void {
  try {
    localStorage.removeItem(DECLINED_KEY);
  } catch {
    /* storage unavailable */
  }
}

/**
 * Whether a graph action (binding a repository starts its graph build) may open the offer by itself: the
 * component is missing, outdated or failed for a reason a download can fix, and this lock was not declined.
 */
export function shouldOfferOnGraphAction(view: ComponentView | null): boolean {
  if (!view?.offer) return false;
  // Downloads are off: the confirmation could not start one. Import stays available in the row.
  if (view.settings.offline.value) return false;
  const status = view.status;
  if (status.state === "installed" || status.state === "installing") return false;
  if (status.state === "failed" && (status.reason === "offline" || status.reason === "unsupported-platform" || status.reason === "lock-unreadable")) return false;
  return declinedLockHash() !== view.offer.lockHash;
}

/** MiB with one decimal, the unit the desktop release notes use for payload sizes. */
export function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function resetComponentsForTests(): void {
  snapshot = EMPTY;
  inflight = null;
  mutationEpoch = 0;
  statusEpoch = 0;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}
