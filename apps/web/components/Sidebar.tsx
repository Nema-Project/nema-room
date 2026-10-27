"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type MouseEvent as ReactMouseEvent } from "react";
import { flushSync } from "react-dom";
import { AppReleaseFooter } from "@/components/AppRelease";
import { PluginsPage } from "@/components/PluginsPage";
import { nextAttention } from "@/lib/hub";
import { LOCALES, useLocale, useT, type Locale } from "@/lib/i18n";
import type { WorkspaceView } from "@/lib/types";

const LOCALE_LABELS: Record<Locale, string> = { en: "EN", ja: "日本語", zh: "中文" };
const THEME_KEY = "nema.theme";
const themeListeners = new Set<() => void>();

function subscribeTheme(listener: () => void) {
  themeListeners.add(listener);
  return () => themeListeners.delete(listener);
}

function themeSnapshot() {
  return document.documentElement.dataset.theme === "dark";
}

function publishTheme() {
  for (const listener of themeListeners) listener();
}

/** Percentages for the VitePress circle. Radius is relative to the normalized viewport diagonal. */
export function themeSwitchOrigin(x: number, y: number, width: number, height: number) {
  const span = Math.hypot(width, height) / Math.SQRT2 || 1;
  const farthest = Math.hypot(Math.max(x, width - x), Math.max(y, height - y));
  return {
    x: `${(100 * x) / width}%`,
    y: `${(100 * y) / height}%`,
    r: `${(100 * farthest) / span}%`,
  };
}

export type SidebarProps = {
  workspaces: WorkspaceView[];
  selectedId: string | null;
  connected: boolean;
  onSelect: (id: string) => void;
  onCreate: (name: string) => void | Promise<void>;
  onArchive: (id: string, archived: boolean) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
  onOpenModelSettings?: () => void;
  onOpenThread?: (workspaceId: string, threadId: string) => void;
};

export function Sidebar({ workspaces, selectedId, connected, onSelect, onCreate, onArchive, onDelete, onOpenModelSettings, onOpenThread }: SidebarProps) {
  const t = useT();
  const [locale, setLocale] = useLocale();
  const dark = useSyncExternalStore(subscribeTheme, themeSnapshot, () => false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const rowEls = useRef(new Map<string, HTMLButtonElement>());
  const restoreId = useRef<string | null>(null);
  const createPending = useRef(false);
  const newWorkspaceRef = useRef<HTMLButtonElement>(null);
  const restoreCreateFocus = useRef(false);

  function cancelDraft() {
    if (createPending.current) return;
    setName("");
    setError(null);
    restoreCreateFocus.current = true;
    setAdding(false);
  }

  function toggleTheme(event: ReactMouseEvent<HTMLButtonElement>) {
    const next = dark ? "light" : "dark";
    const apply = () => {
      document.documentElement.dataset.theme = next;
      localStorage.setItem(THEME_KEY, next);
      flushSync(() => publishTheme());
    };
    const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || typeof document.startViewTransition !== "function") {
      apply();
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const origin = themeSwitchOrigin(rect.left + rect.width / 2, rect.top + rect.height / 2, window.innerWidth, window.innerHeight);
    const root = document.documentElement;
    root.style.setProperty("--switch-x", origin.x);
    root.style.setProperty("--switch-y", origin.y);
    root.style.setProperty("--switch-r", origin.r);
    try {
      document.startViewTransition(apply);
    } catch {
      apply();
    }
  }

  useEffect(() => {
    if (!adding && restoreCreateFocus.current) {
      restoreCreateFocus.current = false;
      newWorkspaceRef.current?.focus();
    }
  }, [adding]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || createPending.current) return;
    createPending.current = true;
    setCreating(true);
    setError(null);
    try {
      await onCreate(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err)); // keep the form and the typed name
      createPending.current = false;
      setCreating(false);
      return;
    }
    setName("");
    setAdding(false);
    createPending.current = false;
    setCreating(false);
  }

  useEffect(() => {
    if (!menu && !confirmId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenu(null);
      setConfirmId(null);
    };
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [menu, confirmId]);

  useEffect(() => {
    if (menu) menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [menu]);

  useEffect(() => {
    cancelRef.current?.focus();
  }, [confirmId]);

  useEffect(() => {
    if (menu || confirmId) return;
    const id = restoreId.current;
    if (!id) return;
    restoreId.current = null;
    rowEls.current.get(id)?.focus();
  }, [menu, confirmId]);

  const active = workspaces.filter((w) => !w.archived);
  const archived = workspaces.filter((w) => w.archived);
  const target = workspaces.find((w) => w.id === (confirmId ?? menu?.id));

  function openMenu(e: ReactMouseEvent, id: string) {
    e.preventDefault();
    restoreId.current = id;
    setMenu({ id, x: e.clientX, y: e.clientY });
  }

  function trapTab(e: React.KeyboardEvent) {
    if (e.key !== "Tab") return;
    const first = cancelRef.current;
    const last = deleteRef.current;
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function placeMenu(el: HTMLDivElement | null) {
    menuRef.current = el;
    if (!el || !menu) return;
    const rect = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(menu.x, window.innerWidth - rect.width - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(menu.y, window.innerHeight - rect.height - 4))}px`;
  }

  function row(w: WorkspaceView) {
    const selected = w.id === selectedId;
    return (
      <div className="ws-wrap" key={w.id}>
      <button
        type="button"
        className={`ws${selected ? " on" : ""}${w.archived ? " archived" : ""}`}
        aria-current={selected ? "page" : undefined}
        ref={(el) => {
          if (el) rowEls.current.set(w.id, el);
          else rowEls.current.delete(w.id);
        }}
        onClick={() => {
          if (!w.archived) {
            setPluginsOpen(false);
            onSelect(w.id);
          }
        }}
        onContextMenu={(e) => openMenu(e, w.id)}
      >
        {w.confidential && <span className="lock" data-testid="confidential-mark" role="img" aria-label={t("sidebar.confidential")} />}
        <span className="ws-name">{w.name}</span>
        {w.openQuestions > 0 && (
          <span className="badge" data-testid="open-questions" title={t("sidebar.openQuestions", { n: w.openQuestions })}>
            {w.openQuestions}
          </span>
        )}
      </button>
      {(w.attention ?? 0) > 0 && <button type="button" className="attention-badge" title={t("sidebar.attention")} aria-label={t("sidebar.attention")} onClick={async (e) => { e.stopPropagation(); const next = await nextAttention(w.id); if (next) onOpenThread?.(w.id, next.threadId); }}>{w.attention}</button>}
      </div>
    );
  }

  return (
    <aside className="side">
      <div className="brand">
        Nema Room
        <small>{t("brand.subtitle")}</small>
      </div>
      <h6>{t("sidebar.workspaces")}</h6>
      <nav className="ws-list">
        {active.map(row)}
        {archived.length > 0 && (
          <>
            <button type="button" className="ws add" aria-expanded={archivedOpen} onClick={() => setArchivedOpen((o) => !o)}>
              {t("sidebar.archived", { n: archived.length })}
            </button>
            {archivedOpen && archived.map(row)}
          </>
        )}
        {adding ? (
          <form className="ws add-form" onSubmit={submit} aria-busy={creating}>
            <input
              autoFocus
              aria-label={t("sidebar.newWorkspaceName")}
              placeholder={t("sidebar.newWorkspaceName")}
              value={name}
              disabled={creating}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && !creating) cancelDraft();
                if (e.key === "Enter" && (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)) e.preventDefault();
              }}
            />
            <div className="add-actions">
              <button type="submit" className="add-action confirm" aria-label={t("sidebar.createWorkspace")} title={t("sidebar.createWorkspace")} disabled={creating || !name.trim()}>
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 8.2 6.5 11.4 12.8 4.6" /></svg>
              </button>
              <button type="button" className="add-action cancel" aria-label={t("sidebar.cancel")} title={t("sidebar.cancel")} disabled={creating} onClick={cancelDraft}>
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8" /></svg>
              </button>
            </div>
            {creating && <span className="creating" role="status">{t("sidebar.creatingWorkspace")}</span>}
            {error && <span className="error" role="alert">{error}</span>}
          </form>
        ) : (
          <button type="button" className="ws add" ref={newWorkspaceRef} onClick={() => { setName(""); setError(null); setAdding(true); }}>
            {t("sidebar.newWorkspace")}
          </button>
        )}
      </nav>
      <div className="foot">
        <button type="button" className="nav-model" onClick={() => { setPluginsOpen(false); onOpenModelSettings?.(); }}>
          {t("sidebar.modelSettings")}
        </button>
        <button type="button" className="nav-plugins" aria-expanded={pluginsOpen} onClick={() => setPluginsOpen((open) => !open)}>
          {t("plugins.nav")}
        </button>
        <div>
          <span className={`dot${connected ? "" : " off"}`} />
          {connected ? t("sidebar.agentOnline") : t("sidebar.agentOffline")}
        </div>
        <AppReleaseFooter />
        <div className="foot-switch">
          <button type="button" className="theme-toggle" aria-pressed={dark} aria-label={t("sidebar.theme")} title={t("sidebar.theme")} onClick={toggleTheme}>
            <svg className={dark ? "theme-icon" : "theme-icon on"} viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="2.6" />
              <path d="M8 1.6v1.7M8 12.7v1.7M1.6 8h1.7M12.7 8h1.7M3.4 3.4l1.2 1.2M11.4 11.4l1.2 1.2M12.6 3.4l-1.2 1.2M4.6 11.4l-1.2 1.2" />
            </svg>
            <svg className={dark ? "theme-icon on" : "theme-icon"} viewBox="0 0 16 16" aria-hidden="true">
              <path d="M9.4 2.1a4.9 4.9 0 1 0 4.5 7.3A3.9 3.9 0 0 1 9.4 2.1z" />
            </svg>
          </button>
          <div className="lang" role="group" aria-label={t("sidebar.language")}>
            {LOCALES.map((l) => (
              <button key={l} type="button" className={l === locale ? "on" : undefined} aria-pressed={l === locale} onClick={() => setLocale(l)}>
                {LOCALE_LABELS[l]}
              </button>
            ))}
          </div>
        </div>
      </div>
      {pluginsOpen && <PluginsPage onClose={() => setPluginsOpen(false)} />}
      {menu && target && !confirmId && (
        <div ref={placeMenu} className="menu" role="menu" style={{ left: menu.x, top: menu.y }}>
          {target.archived ? (
            <button type="button" role="menuitem" onClick={() => { setMenu(null); void onArchive(target.id, false); }}>
              {t("sidebar.unarchive")}
            </button>
          ) : (
            <button type="button" role="menuitem" onClick={() => { setMenu(null); void onArchive(target.id, true); }}>
              {t("sidebar.archive")}
            </button>
          )}
          <button type="button" role="menuitem" className="danger" style={{ color: "#e3241b" }} onClick={() => { setMenu(null); setConfirmId(target.id); }}>
            {t("sidebar.delete")}
          </button>
        </div>
      )}
      {confirmId && target && (
        <div className="scrim" onMouseDown={() => setConfirmId(null)}>
          <div
            className="confirm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-workspace-title"
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={trapTab}
          >
            <h2 id="delete-workspace-title">{t("sidebar.deleteTitle")}</h2>
            <p>{t("sidebar.deleteBody", { name: target.name })}</p>
            <div className="actions">
              <button type="button" ref={cancelRef} onClick={() => setConfirmId(null)}>
                {t("sidebar.cancel")}
              </button>
              <button
                type="button"
                ref={deleteRef}
                className="danger"
                style={{ color: "#e3241b" }}
                onClick={() => {
                  const id = target.id;
                  setConfirmId(null);
                  void onDelete(id);
                }}
              >
                {t("sidebar.deleteConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
