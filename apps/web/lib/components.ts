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

function publish(next: ComponentsSnapshot): void {
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
 * nothing newer arrived since the save was sent (an install or cancel that landed in between
 * owns the lifecycle state) and no install is running now.
 */
function acceptSettings(view: ComponentView, sentEpoch: number): void {
  const arrivedEpoch = mutationEpoch;
  mutationEpoch += 1;
  const current = snapshot.graphify;
  if (!current) {
    publish({ graphify: view, error: null, loaded: true });
    return;
  }
  const status = current.status.state === "installing" || arrivedEpoch !== sentEpoch ? current.status : view.status;
  publish({ graphify: { ...current, settings: view.settings, offer: view.offer, offerError: view.offerError, status }, error: null, loaded: true });
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
  mutationEpoch += 1;
  const task = settingsQueue.then(async () => {
    // The epoch is captured when the save is actually sent, not when it was queued: the
    // answer's status is current only if nothing newer arrived after this point.
    const sentEpoch = mutationEpoch;
    acceptSettings(await updateComponentSettings("graphify", patch), sentEpoch);
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
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}
