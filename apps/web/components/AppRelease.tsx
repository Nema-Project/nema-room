"use client";

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";

type Offer = { version: string; url: string };
type ReleaseView = { version?: string; commit?: string; enabled: boolean; offer?: Offer; upToDate: boolean };

const RELEASE_PAGE = /^https:\/\/github\.com\/Nema-Project\/nema-room\/releases\/tag\/v?\d+\.\d+\.\d+$/;
const VERSION_TEXT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const COMMIT_TEXT = /^[0-9a-f]{7}$/;

const listeners = new Set<() => void>();
let view: ReleaseView | null = null;
let checking = false;
let started = false;
let timer: number | undefined;
let onFocus: (() => void) | undefined;

function publish() {
  for (const listener of listeners) listener();
}

function offerFrom(value: unknown): Offer | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { version?: unknown; url?: unknown };
  if (typeof record.version !== "string" || !/^\d+\.\d+\.\d+$/.test(record.version)) return undefined;
  if (typeof record.url !== "string" || !RELEASE_PAGE.test(record.url)) return undefined;
  const tag = record.url.slice(record.url.lastIndexOf("/") + 1);
  if (tag !== record.version && tag !== `v${record.version}`) return undefined;
  return { version: record.version, url: record.url };
}

async function refresh(): Promise<boolean> {
  try {
    const [versionResponse, updateResponse] = await Promise.all([
      fetch("/_nema/version", { credentials: "same-origin", cache: "no-store" }),
      fetch("/_nema/update", { credentials: "same-origin", cache: "no-store" }),
    ]);
    if (!versionResponse.ok) return false;
    const versionBody = await versionResponse.json() as { version?: unknown; commit?: unknown };
    const version = typeof versionBody.version === "string" && VERSION_TEXT.test(versionBody.version) ? versionBody.version : undefined;
    if (!version) return false;
    const updateBody = updateResponse.ok ? await updateResponse.json() as { enabled?: unknown; offer?: unknown } : {};
    const commit = typeof versionBody.commit === "string" && COMMIT_TEXT.test(versionBody.commit) ? versionBody.commit : undefined;
    const offer = offerFrom(updateBody.offer);
    view = {
      version,
      ...(commit ? { commit } : {}),
      enabled: updateBody.enabled !== false,
      ...(offer ? { offer } : {}),
      upToDate: view?.upToDate === true && !offer,
    };
    return true;
  } catch {
    // The desktop endpoint is absent in Web / Compose, and a failed check stays quiet.
    return false;
  } finally {
    publish();
  }
}

async function setEnabled(enabled: boolean) {
  if (!view) return;
  const previous = view.enabled;
  view = { ...view, enabled };
  publish();
  try {
    const response = await fetch("/_nema/update", {
      method: "PATCH",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (!response.ok) throw new Error("update preference rejected");
  } catch {
    if (view) view = { ...view, enabled: previous };
    publish();
  }
}

async function check() {
  if (checking) return;
  checking = true;
  publish();
  try {
    const response = await fetch("/_nema/update/check", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!response.ok || !view) return;
    const body = await response.json() as { enabled?: unknown; state?: unknown; offer?: unknown };
    const offer = offerFrom(body.offer);
    view = {
      ...view,
      enabled: body.enabled !== false,
      ...(offer ? { offer } : { offer: undefined }),
      upToDate: body.state === "current" && !offer,
    };
  } catch {
    // Offline and rate limits stay quiet.
  } finally {
    checking = false;
    publish();
  }
}

function ensureStarted() {
  if (started || typeof window === "undefined") return;
  started = true;
  void refresh().then((found) => {
    if (!found || !started || timer !== undefined) return;
    timer = window.setInterval(() => { void refresh(); }, 60_000);
    onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
  });
}

/** Test isolation. The page keeps one in-memory snapshot for the banner and the footer. */
export function resetAppReleaseForTests() {
  if (timer !== undefined) window.clearInterval(timer);
  if (onFocus) window.removeEventListener("focus", onFocus);
  timer = undefined;
  onFocus = undefined;
  started = false;
  view = null;
  checking = false;
  listeners.clear();
}

function useAppRelease() {
  const [, setTick] = useState(0);
  useEffect(() => {
    ensureStarted();
    const listener = () => setTick((value) => value + 1);
    listeners.add(listener);
    listener();
    return () => { listeners.delete(listener); };
  }, []);
  return { view, checking, setEnabled, check };
}

export function AppReleaseBanner() {
  const t = useT();
  const { view: current } = useAppRelease();
  if (!current?.offer) return null;
  return (
    <div className="release-banner" role="status">
      <a href={current.offer.url} target="_blank" rel="noreferrer">{t("appRelease.update", { version: current.offer.version })}</a>
    </div>
  );
}

export function AppReleaseFooter() {
  const t = useT();
  const { view: current, checking: busy, setEnabled: changeEnabled, check: runCheck } = useAppRelease();
  if (!current?.version) return null;
  return (
    <div className="foot-release">
      <div className="foot-version">{current.commit ? t("appRelease.versionCommit", { version: current.version, commit: current.commit }) : t("appRelease.version", { version: current.version })}</div>
      {current.upToDate && !current.offer && <div>{t("appRelease.upToDate")}</div>}
      <button type="button" className="release-check" onClick={() => { void runCheck(); }} disabled={busy}>
        {busy ? t("appRelease.checking") : t("appRelease.check")}
      </button>
      <label className="release-auto">
        <input type="checkbox" checked={current.enabled} onChange={(event) => { void changeEnabled(event.target.checked); }} />
        {t("appRelease.automatic")}
      </label>
    </div>
  );
}
