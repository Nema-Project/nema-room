"use client";

import { useEffect, useRef, useState, type FormEvent, type MouseEvent as ReactMouseEvent } from "react";
import { PluginsPage } from "@/components/PluginsPage";
import { LOCALES, useLocale, useT, type Locale } from "@/lib/i18n";
import type { WorkspaceView } from "@/lib/types";

const LOCALE_LABELS: Record<Locale, string> = { en: "EN", ja: "日本語", zh: "中文" };

export type SidebarProps = {
  workspaces: WorkspaceView[];
  selectedId: string | null;
  connected: boolean;
  onSelect: (id: string) => void;
  onCreate: (name: string) => void | Promise<void>;
  onArchive: (id: string, archived: boolean) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
};

export function Sidebar({ workspaces, selectedId, connected, onSelect, onCreate, onArchive, onDelete }: SidebarProps) {
  const t = useT();
  const [locale, setLocale] = useLocale();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const rowEls = useRef(new Map<string, HTMLButtonElement>());
  const restoreId = useRef<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setError(null);
    try {
      await onCreate(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err)); // keep the form and the typed name
      return;
    }
    setName("");
    setAdding(false);
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
      <button
        key={w.id}
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
          <form className="ws add-form" onSubmit={submit}>
            <input autoFocus aria-label={t("sidebar.newWorkspaceName")} placeholder={t("sidebar.newWorkspaceName")} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setAdding(false)} />
            {error && <span className="error" role="alert">{error}</span>}
          </form>
        ) : (
          <button type="button" className="ws add" onClick={() => setAdding(true)}>
            {t("sidebar.newWorkspace")}
          </button>
        )}
      </nav>
      <div className="foot">
        <button type="button" className="nav-plugins" aria-expanded={pluginsOpen} onClick={() => setPluginsOpen((open) => !open)}>
          {t("plugins.nav")}
        </button>
        <div>
          <span className={`dot${connected ? "" : " off"}`} />
          {connected ? t("sidebar.agentOnline") : t("sidebar.agentOffline")}
        </div>
        <div className="lang" role="group" aria-label={t("sidebar.language")}>
          {LOCALES.map((l) => (
            <button key={l} type="button" className={l === locale ? "on" : undefined} aria-pressed={l === locale} onClick={() => setLocale(l)}>
              {LOCALE_LABELS[l]}
            </button>
          ))}
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
