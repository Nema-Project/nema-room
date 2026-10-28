"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { AppReleaseAbout } from "@/components/AppRelease";
import { ModelSettings } from "@/components/ModelSettings";
import { PluginsPage } from "@/components/PluginsPage";
import { useT } from "@/lib/i18n";

const TABS = ["model", "plugins", "general", "about"] as const;
type SettingsTab = (typeof TABS)[number];

type LoginItemBridge = {
  get: () => Promise<{ openAtLogin: boolean }>;
  set: (openAtLogin: boolean) => Promise<{ openAtLogin: boolean }>;
};

declare global {
  interface Window {
    nemaLoginItem?: LoginItemBridge;
  }
}

function readLoginItemBridge(): LoginItemBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = window.nemaLoginItem;
  if (!bridge || typeof bridge.get !== "function" || typeof bridge.set !== "function") return null;
  return bridge;
}

function openAtLoginValue(value: unknown): boolean | null {
  if (!value || typeof value !== "object" || typeof (value as { openAtLogin?: unknown }).openAtLogin !== "boolean") return null;
  return (value as { openAtLogin: boolean }).openAtLogin;
}

type LoginProbe = { bridge: LoginItemBridge | null; ready: boolean };
const LOGIN_PROBE_PENDING: LoginProbe = { bridge: null, ready: false };
let loginProbe: LoginProbe = LOGIN_PROBE_PENDING;
const loginListeners = new Set<() => void>();

function subscribeLoginItem(listener: () => void) {
  loginListeners.add(listener);
  const bridge = readLoginItemBridge();
  if (!loginProbe.ready || loginProbe.bridge !== bridge) loginProbe = { bridge, ready: true };
  return () => {
    loginListeners.delete(listener);
    if (loginListeners.size === 0) loginProbe = LOGIN_PROBE_PENDING;
  };
}

function getLoginProbe() {
  return loginProbe;
}

function getServerLoginProbe() {
  return LOGIN_PROBE_PENDING;
}

function LoginItemSetting() {
  const t = useT();
  const helpId = useId();
  const probe = useSyncExternalStore(subscribeLoginItem, getLoginProbe, getServerLoginProbe);
  const [saved, setSaved] = useState<{ openAtLogin: boolean; error: boolean } | null>(null);

  useEffect(() => {
    if (!probe.ready || !probe.bridge) return;
    const bridge = probe.bridge;
    let live = true;
    void bridge.get().then((value) => {
      if (!live) return;
      const openAtLogin = openAtLoginValue(value);
      setSaved(openAtLogin === null ? { openAtLogin: false, error: true } : { openAtLogin, error: false });
    }).catch(() => {
      if (live) setSaved({ openAtLogin: false, error: true });
    });
    return () => { live = false; };
  }, [probe]);

  async function change(next: boolean) {
    const bridge = readLoginItemBridge();
    if (!bridge || !probe.ready || !probe.bridge || !saved) return;
    const previous = saved.openAtLogin;
    setSaved({ openAtLogin: next, error: false });
    try {
      const openAtLogin = openAtLoginValue(await bridge.set(next));
      if (openAtLogin === null) throw new Error("invalid login item result");
      setSaved({ openAtLogin, error: false });
    } catch {
      setSaved({ openAtLogin: previous, error: true });
    }
  }

  const unavailable = probe.ready && !probe.bridge;
  const pending = !probe.ready || (!unavailable && !saved);
  const checked = saved?.openAtLogin ?? false;
  const help = pending ? "common.loading" : unavailable ? "appSettings.loginItemUnavailable" : "appSettings.loginItemHelp";

  return (
    <section className="app-settings-section" aria-labelledby="app-settings-login-title">
      <h2 id="app-settings-login-title" className="label">{t("appSettings.loginItem")}</h2>
      <label className="check">
        <input
          type="checkbox"
          checked={checked}
          disabled={pending || unavailable}
          aria-describedby={helpId}
          onChange={(event) => { void change(event.target.checked); }}
        />
        {t("appSettings.loginItem")}
      </label>
      <p id={helpId} className="help">{t(help)}</p>
      {saved?.error && <p className="error" role="alert">{t("appSettings.loginItemError")}</p>}
    </section>
  );
}

export function AppSettings({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [tab, setTab] = useState<SettingsTab>("model");
  const tabNow = useRef<SettingsTab>("model");
  const rootRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    tabRefs.current[0]?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (!rootRef.current?.contains(event.target as Node)) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function selectTab(next: number) {
    const id = TABS[next];
    if (!id) return;
    tabNow.current = id;
    setTab(id);
    tabRefs.current[next]?.focus();
  }

  function onTabsKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = TABS.indexOf(tabNow.current);
    if (event.key === "ArrowDown" || event.key === "ArrowRight") selectTab((index + 1) % TABS.length);
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") selectTab((index - 1 + TABS.length) % TABS.length);
    else if (event.key === "Home") selectTab(0);
    else if (event.key === "End") selectTab(TABS.length - 1);
    else return;
    event.preventDefault();
  }

  const labels: Record<SettingsTab, string> = {
    model: t("appSettings.tab.model"),
    plugins: t("appSettings.tab.plugins"),
    general: t("appSettings.tab.general"),
    about: t("appSettings.tab.about"),
  };

  return (
    <div className="app-settings" ref={rootRef}>
      <div className="bar">
        <h1 id="app-settings-title">{t("appSettings.title")}</h1>
        <button type="button" className="sp settings-action" onClick={onClose}>{t("appSettings.back")}</button>
      </div>
      <div className="app-settings-body">
        <div role="tablist" aria-orientation="vertical" aria-label={t("appSettings.tabs")} className="app-settings-tabs" onKeyDown={onTabsKeyDown}>
          {TABS.map((id, index) => {
            const selected = id === tab;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                id={`app-settings-tab-${id}`}
                aria-selected={selected}
                aria-controls={`app-settings-panel-${id}`}
                tabIndex={selected ? 0 : -1}
                ref={(element) => { tabRefs.current[index] = element; }}
                onClick={() => selectTab(index)}
              >
                {labels[id]}
              </button>
            );
          })}
        </div>
        {TABS.map((id) => {
          const selected = id === tab;
          return (
            <div
              key={id}
              role="tabpanel"
              id={`app-settings-panel-${id}`}
              aria-labelledby={`app-settings-tab-${id}`}
              tabIndex={selected ? 0 : -1}
              hidden={!selected}
              className="app-settings-panel"
            >
              {id === "model" && <ModelSettings embedded />}
              {id === "plugins" && <PluginsPage embedded />}
              {id === "general" && <LoginItemSetting />}
              {id === "about" && (
                <section className="app-settings-section">
                  <AppReleaseAbout />
                </section>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
