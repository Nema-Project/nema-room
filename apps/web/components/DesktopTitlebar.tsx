"use client";

import { useEffect, useSyncExternalStore } from "react";
import Image from "next/image";
import { useT } from "@/lib/i18n";

type WindowState = { maximized: boolean };
type WindowControls = {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  getState: () => Promise<WindowState>;
  onStateChanged: (callback: (state: WindowState) => void) => () => void;
};
type DesktopSnapshot = WindowState & { controls: WindowControls };

declare global {
  interface Window { nemaWindowControls?: WindowControls }
}

let snapshot: DesktopSnapshot | null = null;
let stateUnsubscribe: (() => void) | undefined;
const subscribers = new Set<() => void>();

function notify() {
  for (const subscriber of subscribers) subscriber();
}

function subscribe(callback: () => void) {
  subscribers.add(callback);
  if (subscribers.size === 1) {
    const controls = window.nemaWindowControls;
    if (controls) {
      snapshot = { controls, maximized: false };
      stateUnsubscribe = controls.onStateChanged((state) => {
        snapshot = { controls, maximized: state.maximized };
        notify();
      });
      void controls.getState().then((state) => {
        if (snapshot?.controls !== controls) return;
        snapshot = { controls, maximized: state.maximized };
        notify();
      }).catch(() => undefined);
    }
  }
  return () => {
    subscribers.delete(callback);
    if (subscribers.size === 0) {
      stateUnsubscribe?.();
      stateUnsubscribe = undefined;
      snapshot = null;
    }
  };
}

const getSnapshot = () => snapshot;
const getServerSnapshot = () => null;

export function DesktopTitlebar() {
  const t = useT();
  const current = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const controls = current?.controls ?? null;
  const maximized = current?.maximized ?? false;

  useEffect(() => {
    if (!controls) return;
    document.documentElement.classList.add("nema-desktop-window");
    return () => {
      document.documentElement.classList.remove("nema-desktop-window");
    };
  }, [controls]);

  if (!controls) return null;
  return (
    <header className="desktop-titlebar" aria-label={t("window.titlebar")} onDoubleClick={() => void controls.toggleMaximize()}>
      <span className="desktop-titlebar-brand"><Image src="/nema-room-mark.svg" width={20} height={20} alt="" unoptimized />Nema Room</span>
      <div className="desktop-titlebar-controls" onDoubleClick={(event) => event.stopPropagation()}>
        <button className="desktop-titlebar-button" type="button" aria-label={t("window.minimize")} title={t("window.minimize")} onClick={() => void controls.minimize().catch(() => undefined)}>
          <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 8.5h8" /></svg>
        </button>
        <button className="desktop-titlebar-button" type="button" aria-label={maximized ? t("window.restore") : t("window.maximize")} title={maximized ? t("window.restore") : t("window.maximize")} onClick={() => void controls.toggleMaximize().catch(() => undefined)}>
          {maximized ? <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2.5h5.5V8M8 4H2.5v5.5H8z" /></svg> : <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5h7v7h-7z" /></svg>}
        </button>
        <button className="desktop-titlebar-button desktop-titlebar-close" type="button" aria-label={t("window.close")} title={t("window.close")} onClick={() => void controls.close().catch(() => undefined)}>
          <svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 3 6 6m0-6L3 9" /></svg>
        </button>
      </div>
    </header>
  );
}
