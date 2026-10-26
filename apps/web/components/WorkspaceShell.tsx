"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { Chat, type ChatHandle } from "@/components/Chat";
import { EntryDetail } from "@/components/EntryDetail";
import { KnowledgePanel } from "@/components/KnowledgePanel";
import { ModelSettings } from "@/components/ModelSettings";
import { Sidebar } from "@/components/Sidebar";
import { useThreadWindows } from "@/components/ThreadWindowsProvider";
import { WorkspaceSettings } from "@/components/WorkspaceSettings";
import { HubError, archiveWorkspace, createWorkspace, deleteWorkspace, getDaemonStatus, getMessage, listWorkspaces } from "@/lib/hub";
import { mainMessageUrl, openThread } from "@/lib/threads";
import { useT } from "@/lib/i18n";
import type { HubEvent, Workspace, WorkspaceView } from "@/lib/types";
import { useHubEvents } from "@/lib/useHubEvents";

const SELECTED_KEY = "nema.workspace";
const KNOW_WIDTH_KEY = "nema.knowWidth";
const KNOW_COLLAPSED_KEY = "nema.knowCollapsed";
const SIDE_WIDTH_KEY = "nema.sideWidth";
const SIDE_COLLAPSED_KEY = "nema.sideCollapsed";
const STATUS_POLL_MS = 15_000;
const SIDE_DEFAULT = 232;
const KNOW_DEFAULT = 380;
const SNAP = 160;
const RAIL = 12;
const CHAT_MIN = 280;
const MAIN_MESSAGE_PATH = /^\/w\/(ws_[A-Za-z0-9_-]{1,32})$/;
const MAIN_MESSAGE_WORKSPACE_ID = /^ws_[A-Za-z0-9_-]{1,32}$/;
const MAIN_MESSAGE_ID = /^m_[A-Za-z0-9_-]{1,32}$/;

type Col = "side" | "know";

function readWidth(key: string) {
  const n = Number(localStorage.getItem(key));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function writeFlag(key: string, on: boolean) {
  try {
    if (on) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

function writeWidth(key: string, width: number) {
  try {
    localStorage.setItem(key, String(width));
  } catch {
    /* storage unavailable */
  }
}

function mainMessageTarget(hash: string, pathname: string, search: string, roomId: string | null): { workspaceId: string; messageId: string } | null {
  if (!roomId || search || /[\r\n\0]/.test(hash)) return null;
  const path = MAIN_MESSAGE_PATH.exec(pathname);
  if (!path || path[1] !== roomId || !hash.startsWith("#")) return null;
  const pairs = [...new URLSearchParams(hash.slice(1)).entries()];
  if (pairs.length !== 2 || pairs.filter(([key]) => key === "workspace").length !== 1 || pairs.filter(([key]) => key === "message").length !== 1) return null;
  const params = new URLSearchParams(hash.slice(1));
  const workspaceId = params.get("workspace");
  const messageId = params.get("message");
  if (!workspaceId || !MAIN_MESSAGE_WORKSPACE_ID.test(workspaceId) || workspaceId !== roomId || workspaceId !== path[1] || !messageId || !MAIN_MESSAGE_ID.test(messageId)) return null;
  return { workspaceId, messageId };
}

function SettingsMark() {
  return (
    <svg className="mark" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path className="line" d="M1 3h10M1 6h10M1 9h10" />
      <rect x="2" y="2" width="2" height="2" />
      <rect x="7" y="5" width="2" height="2" />
      <rect x="4" y="8" width="2" height="2" />
    </svg>
  );
}

function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg className="mark" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path className="line" d={dir === "left" ? "M7.5 2.5 4.5 6 7.5 9.5" : "M4.5 2.5 7.5 6 4.5 9.5"} />
    </svg>
  );
}

/** Shared by `/` (routeId null: falls back to the stored/first workspace and redirects) and `/w/[id]`. */
export function WorkspaceShell({ routeId }: { routeId: string | null }) {
  const t = useT();
  const router = useRouter();
  const chat = useRef<ChatHandle>(null);
  const threadWindows = useThreadWindows();
  const [workspaces, setWorkspaces] = useState<WorkspaceView[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hubFault, setHubFault] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false);
  const [openState, setOpenState] = useState<{ roomId: string | null; entryId: string | null; tab?: "content" | "history" }>({ roomId: null, entryId: null });
  const [knowWidth, setKnowWidth] = useState<number | null>(null);
  const [knowCollapsed, setKnowCollapsed] = useState(false);
  const [sideWidth, setSideWidth] = useState<number | null>(null);
  const [sideCollapsed, setSideCollapsed] = useState(false);
  const colDrag = useRef<{ col: Col; startX: number; startW: number; collapsed: boolean } | null>(null);
  const [dragging, setDragging] = useState<Col | null>(null);
  const [panelTick, setPanelTick] = useState(0);
  const [detailTick, setDetailTick] = useState(0);
  const openEntryRef = useRef<string | null>(null);
  const mainMessageRequest = useRef(0);

  const refresh = useCallback(async () => {
    try {
      setWorkspaces(await listWorkspaces());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount: state is set once the request resolves
    void refresh();
    try {
      // Stored layout is read after hydration so the server and first client render agree.
      setSelectedId(localStorage.getItem(SELECTED_KEY));
      setKnowWidth(readWidth(KNOW_WIDTH_KEY));
      setKnowCollapsed(localStorage.getItem(KNOW_COLLAPSED_KEY) === "1");
      setSideWidth(readWidth(SIDE_WIDTH_KEY));
      setSideCollapsed(localStorage.getItem(SIDE_COLLAPSED_KEY) === "1");
    } catch {
      /* storage unavailable */
    }
  }, [refresh]);

  // Fall back to the first workspace when nothing (valid) is selected.
  const active = workspaces?.filter((w) => !w.archived) ?? [];
  const wanted = routeId ?? selectedId;
  const current = active.find((w) => w.id === wanted) ?? (routeId ? null : active[0] ?? null);

  // `/` has no workspace of its own: move to the canonical room URL once one is known.
  // An archived or missing room is not opened; go to the next active workspace.
  useEffect(() => {
    if (!workspaces) return;
    if (routeId === null) {
      if (current) router.replace(`/w/${encodeURIComponent(current.id)}`);
      return;
    }
    if (!current) {
      const next = workspaces.find((w) => !w.archived);
      router.replace(next ? `/w/${encodeURIComponent(next.id)}` : "/");
    }
  }, [workspaces, routeId, current, router]);

  useEffect(() => {
    const poll = () => {
      void getDaemonStatus().then((s) => setConnected(s.connected), () => setConnected(false));
      void refresh(); // badges of workspaces other than the streamed one would otherwise go stale
    };
    const id = setInterval(poll, STATUS_POLL_MS);
    void getDaemonStatus().then((s) => setConnected(s.connected), () => setConnected(false));
    return () => clearInterval(id);
  }, [refresh]);

  // A different room never keeps the previous room's entry open: an entry opened in another room does not count.
  const roomId = current?.id ?? null;
  const openEntry = openState.roomId === roomId ? openState.entryId : null;
  const setOpenEntry = useCallback((entryId: string | null) => setOpenState({ roomId, entryId }), [roomId]);
  const setOpenHistory = useCallback((entryId: string) => setOpenState({ roomId, entryId, tab: "history" }), [roomId]);
  useEffect(() => {
    openEntryRef.current = openEntry;
  }, [openEntry]);

  const resync = useCallback(() => {
    chat.current?.resync();
    setPanelTick((n) => n + 1);
    setDetailTick((n) => n + 1);
    void getDaemonStatus().then((s) => setConnected(s.connected), () => setConnected(false));
    void refresh();
  }, [refresh]);

  useHubEvents(
    current?.id ?? null,
    useCallback(
      (e: HubEvent) => {
        if (e.type === "daemon.status") setConnected(e.connected);
        else if (e.type === "knowledge.changed") {
          void refresh();
          setPanelTick((n) => n + 1);
          if (e.entryId === openEntryRef.current) setDetailTick((n) => n + 1);
        } else if (e.type === "task.updated" && (e.task.status === "done" || e.task.status === "failed")) {
          // isNew is computed against the latest done task, so entries written mid-task only get their tag now.
          // The open entry is not touched: its content changes arrive as knowledge.changed, and bumping the
          // detail here would show a false "entry changed elsewhere" notice while the user edits it.
          setPanelTick((n) => n + 1);
        } else if (e.type === "thread.updated") {
          void refresh();
        }
        chat.current?.handleEvent(e);
      },
      [refresh],
    ),
    resync,
  );

  const select = useCallback((id: string) => {
    if (id !== current?.id) router.push(`/w/${encodeURIComponent(id)}`);
    setSelectedId(id);
    setSettingsOpen(false);
    try {
      localStorage.setItem(SELECTED_KEY, id);
    } catch {
      /* storage unavailable */
    }
  }, [current?.id, router]);

  const openTargetThread = useCallback((workspaceId: string, threadId: string, messageId?: string) => {
    if (workspaceId !== current?.id) select(workspaceId);
    openThread(workspaceId, threadId, threadWindows, messageId);
  }, [current?.id, select, threadWindows]);
  const openMainMessage = useCallback((workspaceId: string, message: import("@/lib/types").Message) => {
    if (workspaceId === current?.id) {
      chat.current?.showMessage(message);
      return;
    }
    setSelectedId(workspaceId);
    setSettingsOpen(false);
    try { localStorage.setItem(SELECTED_KEY, workspaceId); } catch { /* storage unavailable */ }
    router.push(mainMessageUrl(workspaceId, message.id));
  }, [current?.id, router]);
  useEffect(() => threadWindows.registerMainMessageHandler(openMainMessage), [threadWindows, openMainMessage]);
  const jumpToMessage = useCallback(async (id: string) => {
    if (!current) return;
    try {
      const message = await getMessage(current.id, id);
      if (message.threadId) openTargetThread(message.workspaceId, message.threadId, message.id);
      else chat.current?.showMessage(message);
    } catch {
      // Existing shell callers may ask to scroll an already mounted message without resolver data.
      chat.current?.scrollToMessage(id);
    }
  }, [current, openTargetThread]);

  useEffect(() => {
    const consumeHash = () => {
      const request = ++mainMessageRequest.current;
      const target = mainMessageTarget(window.location.hash, window.location.pathname, window.location.search, roomId);
      if (!target) return;
      const requestedHash = window.location.hash;
      void getMessage(target.workspaceId, target.messageId).then((message) => {
        if (request !== mainMessageRequest.current || window.location.hash !== requestedHash ||
          message.id !== target.messageId || message.workspaceId !== target.workspaceId) return;
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
        if (message.threadId) openTargetThread(target.workspaceId, message.threadId, message.id);
        else chat.current?.showMessage(message);
      }, () => undefined);
    };
    window.addEventListener("hashchange", consumeHash);
    consumeHash();
    return () => {
      window.removeEventListener("hashchange", consumeHash);
      mainMessageRequest.current++;
    };
  }, [roomId, openTargetThread]);

  async function create(name: string) {
    const ws = await createWorkspace(name); // errors surface in the sidebar form
    await refresh();
    select(ws.id);
  }

  function fail(e: unknown) {
    if (e instanceof HubError) {
      setHubFault(true);
      setError(e.status === 409 ? t("sidebar.busy") : e.message);
      return;
    }
    setHubFault(false);
    setError(e instanceof Error ? e.message : String(e));
  }

  async function reloadList() {
    try {
      setWorkspaces(await listWorkspaces());
    } catch {
      /* keep the list already on screen */
    }
  }

  async function changeArchive(id: string, archived: boolean) {
    try {
      await archiveWorkspace(id, archived);
      setHubFault(false);
      setError(null);
      await refresh();
    } catch (e) {
      await reloadList();
      fail(e);
    }
  }

  async function remove(id: string) {
    try {
      await deleteWorkspace(id);
      setHubFault(false);
      setError(null);
      await refresh();
    } catch (e) {
      await reloadList();
      fail(e);
    }
  }

  function updated(w: Workspace) {
    setWorkspaces((list) => list?.map((x) => (x.id === w.id ? { ...x, ...w } : x)) ?? list);
  }

  function applyColumn(col: Col, raw: number, frameW: number, otherW: number) {
    const max = Math.max(SNAP, frameW - otherW - CHAT_MIN);
    const collapsed = raw < SNAP;
    const open = collapsed ? null : Math.round(Math.min(max, Math.max(SNAP, raw)));
    if (col === "side") {
      setSideCollapsed(collapsed);
      if (open != null) setSideWidth(open);
      writeFlag(SIDE_COLLAPSED_KEY, collapsed);
      if (open != null) writeWidth(SIDE_WIDTH_KEY, open);
    } else {
      setKnowCollapsed(collapsed);
      if (open != null) setKnowWidth(open);
      writeFlag(KNOW_COLLAPSED_KEY, collapsed);
      if (open != null) writeWidth(KNOW_WIDTH_KEY, open);
    }
  }

  function toggleColumn(col: Col) {
    const frame = document.querySelector(".frame");
    if (!frame) return;
    const collapsed = col === "side" ? sideCollapsed : knowCollapsed;
    const saved = col === "side" ? (sideWidth ?? SIDE_DEFAULT) : (knowWidth ?? KNOW_DEFAULT);
    applyColumn(col, collapsed ? saved : 0, frame.getBoundingClientRect().width, otherWidth(col));
  }

  function otherWidth(col: Col) {
    const sel = col === "side" ? ".know-col" : ".side-col";
    return document.querySelector(sel)?.getBoundingClientRect().width ?? (col === "side" ? KNOW_DEFAULT : SIDE_DEFAULT);
  }

  function onColPointerDown(e: PointerEvent<HTMLButtonElement>) {
    if (e.button !== 0) return;
    const col = e.currentTarget.dataset.col === "side" ? "side" : "know";
    const column = e.currentTarget.parentElement;
    if (!column) return;
    colDrag.current = {
      col,
      startX: e.clientX,
      startW: column.getBoundingClientRect().width,
      collapsed: col === "side" ? sideCollapsed : knowCollapsed,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDragging(col);
  }

  function onColPointerMove(e: PointerEvent<HTMLButtonElement>) {
    const drag = colDrag.current;
    const frame = e.currentTarget.closest(".frame");
    if (!drag || !frame) return;
    const delta = e.clientX - drag.startX;
    const raw = drag.col === "side" ? drag.startW + delta : drag.startW - delta;
    applyColumn(drag.col, raw, frame.getBoundingClientRect().width, otherWidth(drag.col));
  }

  function onColPointerUp(e: PointerEvent<HTMLButtonElement>) {
    const drag = colDrag.current;
    colDrag.current = null;
    setDragging(null);
    const frame = e.currentTarget.closest(".frame");
    if (!drag || !frame || !drag.collapsed || Math.abs(e.clientX - drag.startX) > 3) return;
    const saved = drag.col === "side" ? (sideWidth ?? SIDE_DEFAULT) : (knowWidth ?? KNOW_DEFAULT);
    applyColumn(drag.col, saved, frame.getBoundingClientRect().width, otherWidth(drag.col));
  }

  function onColKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    const wider = e.currentTarget.dataset.col === "side" ? e.key === "ArrowRight" : e.key === "ArrowLeft";
    const narrower = e.currentTarget.dataset.col === "side" ? e.key === "ArrowLeft" : e.key === "ArrowRight";
    if (!wider && !narrower) return;
    const frame = e.currentTarget.closest(".frame");
    const column = e.currentTarget.parentElement;
    if (!frame || !column) return;
    e.preventDefault();
    const col: Col = e.currentTarget.dataset.col === "side" ? "side" : "know";
    const collapsed = col === "side" ? sideCollapsed : knowCollapsed;
    const saved = col === "side" ? (sideWidth ?? SIDE_DEFAULT) : (knowWidth ?? KNOW_DEFAULT);
    if (collapsed && wider) {
      applyColumn(col, saved, frame.getBoundingClientRect().width, otherWidth(col));
      return;
    }
    const step = (e.shiftKey ? 48 : 16) * (wider ? 1 : -1);
    applyColumn(col, column.getBoundingClientRect().width + step, frame.getBoundingClientRect().width, otherWidth(col));
  }

  const frameStyle = {
    ...(sideCollapsed ? { "--side-width": `${RAIL}px` } : sideWidth != null ? { "--side-width": `${sideWidth}px` } : {}),
    ...(knowCollapsed ? { "--know-width": `${RAIL}px` } : knowWidth != null ? { "--know-width": `${knowWidth}px` } : {}),
  } as CSSProperties;

  return (
    <div
      className={openEntry && !settingsOpen ? "frame entry-open" : "frame"}
      style={frameStyle}
    >
      <div className={sideCollapsed ? "side-col is-collapsed" : "side-col"}>
        <Sidebar workspaces={workspaces ?? []} selectedId={current?.id ?? null} connected={connected} onSelect={select} onCreate={create} onArchive={changeArchive} onDelete={remove} onOpenThread={openTargetThread} onOpenModelSettings={() => { setSettingsOpen(false); setModelSettingsOpen(true); }} />
        <button
          type="button"
          className={dragging === "side" ? "col-resize side-resize is-dragging" : "col-resize side-resize"}
          data-col="side"
          role="separator"
          aria-orientation="vertical"
          aria-label={t("sidebar.resize")}
          onPointerDown={onColPointerDown}
          onPointerMove={onColPointerMove}
          onPointerUp={onColPointerUp}
          onPointerCancel={onColPointerUp}
          onKeyDown={onColKeyDown}
        />
        <button
          type="button"
          className="col-toggle"
          aria-expanded={!sideCollapsed}
          aria-label={t(sideCollapsed ? "sidebar.expand" : "sidebar.collapse")}
          onClick={() => toggleColumn("side")}
        >
          <Chevron dir={sideCollapsed ? "right" : "left"} />
        </button>
      </div>
      <main className="chat">
        {current ? (
          <>
            <div className="bar">
              <h1>{current.name}</h1>
              {current.confidential && <span className="tag">{t("sidebar.confidential")}</span>}
              <button type="button" className="sp link" onClick={() => { setModelSettingsOpen(false); setSettingsOpen((o) => !o); }}>
                <SettingsMark />
                {t("common.settings")}
              </button>
            </div>
            <Chat key={current.id} ref={chat} workspaceId={current.id} connected={connected} onOpenEntry={setOpenEntry} onOpenHistory={setOpenHistory} onOpenThread={(tid, mid) => openTargetThread(current.id, tid, mid)} />
          </>
        ) : (
          <div className="placeholder">{workspaces === null && !error ? t("common.loading") : t("main.empty")}</div>
        )}
        {error && (
          <p className="error banner" role="alert">
            {hubFault ? error : t("common.error", { message: error })}
          </p>
        )}
      </main>
      <div className={knowCollapsed ? "know-col is-collapsed" : "know-col"}>
        <button
          type="button"
          className={dragging === "know" ? "col-resize know-resize is-dragging" : "col-resize know-resize"}
          data-col="know"
          role="separator"
          aria-orientation="vertical"
          aria-label={t("know.resize")}
          onPointerDown={onColPointerDown}
          onPointerMove={onColPointerMove}
          onPointerUp={onColPointerUp}
          onPointerCancel={onColPointerUp}
          onKeyDown={onColKeyDown}
        />
        <button
          type="button"
          className="col-toggle"
          aria-expanded={!knowCollapsed}
          aria-label={t(knowCollapsed ? "know.expand" : "know.collapse")}
          onClick={() => toggleColumn("know")}
        >
          <Chevron dir={knowCollapsed ? "left" : "right"} />
        </button>
        {modelSettingsOpen ? (
          <ModelSettings onClose={() => setModelSettingsOpen(false)} />
        ) : current && settingsOpen ? (
          <WorkspaceSettings key={current.id} workspace={current} onUpdated={updated} onClose={() => setSettingsOpen(false)} />
        ) : (
        <aside className="know">
          {current && openEntry ? (
            <EntryDetail
              key={`${current.id}/${openEntry}/${openState.tab ?? "content"}`}
              workspaceId={current.id}
              entryId={openEntry}
              refreshKey={detailTick}
              onClose={() => setOpenEntry(null)}
              onOpenEntry={setOpenEntry}
              onJumpToMessage={(id) => void jumpToMessage(id)}
              initialTab={openState.tab}
            />
          ) : current ? (
            <KnowledgePanel key={current.id} workspaceId={current.id} knowledgeLanguage={current.knowledgeLanguage} refreshKey={panelTick} onOpen={setOpenEntry} />
          ) : (
            <div className="placeholder">{t("main.empty")}</div>
          )}
        </aside>
        )}
      </div>
    </div>
  );
}
