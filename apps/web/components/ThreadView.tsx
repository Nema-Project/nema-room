"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Composer } from "@/components/Composer";
import { EntryDetail } from "@/components/EntryDetail";
import { MessageItem } from "@/components/MessageItem";
import { getMessage, getThreadMessages, markThreadRead, postThreadMessage } from "@/lib/hub";
import { threadUrl, mainMessageUrl } from "@/lib/threads";
import { useT } from "@/lib/i18n";
import type { HubEvent, Message, Thread } from "@/lib/types";
import { useHubEvents } from "@/lib/useHubEvents";

export type ThreadViewProps = {
  workspaceId: string;
  threadId: string;
  active?: boolean;
  floating?: boolean;
  onClose?: () => void;
  onOpenThread?: (workspaceId: string, threadId: string, messageId?: string) => void;
  onOpenMainMessage?: (workspaceId: string, message: Message) => void;
  focusMessageId?: string;
};

export function ThreadView({ workspaceId, threadId, active = true, floating = false, onClose, onOpenThread, onOpenMainMessage, focusMessageId }: ThreadViewProps) {
  const t = useT();
  const root = useRef<HTMLElement>(null);
  const [thread, setThread] = useState<Thread | null>(null);
  const [anchor, setAnchor] = useState<Message | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [entry, setEntry] = useState<{ id: string; history: boolean } | null>(null);
  const [quote, setQuote] = useState<Message | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [jumpError, setJumpError] = useState(false);
  const [focused, setFocused] = useState(() => typeof document === "undefined" || document.hasFocus());
  const [focusVersion, setFocusVersion] = useState(0);
  const [reconnectVersion, setReconnectVersion] = useState(0);
  const [retryVersion, setRetryVersion] = useState(0);
  const [jumpVersion, setJumpVersion] = useState(0);
  const confirmedSeq = useRef(0);
  const pendingSeq = useRef(0);
  const inFlightSeq = useRef<number | null>(null);
  const eventVersion = useRef(0);
  const messageVersions = useRef(new Map<string, number>());
  const anchorVersion = useRef(0);
  const threadVersion = useRef(0);
  const pendingScroll = useRef<string | null>(null);
  const initialFocusDone = useRef(false);

  useEffect(() => {
    confirmedSeq.current = 0;
    pendingSeq.current = 0;
    inFlightSeq.current = null;
    eventVersion.current = 0;
    messageVersions.current.clear();
    anchorVersion.current = 0;
    threadVersion.current = 0;
    initialFocusDone.current = false;
  }, [workspaceId, threadId]);

  const load = useCallback(async () => {
    const startedAt = eventVersion.current;
    try {
      const result = await getThreadMessages(workspaceId, threadId);
      let target: Message | null = null;
      let invalidTarget = false;
      if (focusMessageId && focusMessageId !== result.anchor.id && !result.messages.some((message) => message.id === focusMessageId)) {
        try {
          target = await getMessage(workspaceId, focusMessageId);
          if (target.workspaceId !== workspaceId || target.threadId !== threadId) {
            target = null;
            invalidTarget = true;
          }
        } catch {
          target = null;
          invalidTarget = true;
        }
      }
      setThread((current) => threadVersion.current > startedAt ? current : result.thread);
      setAnchor((current) => anchorVersion.current > startedAt ? current : result.anchor);
      setMessages((current) => {
        const next = new Map(result.messages.map((message) => [message.id, message]));
        if (target) next.set(target.id, target);
        for (const message of current) {
          if ((messageVersions.current.get(message.id) ?? 0) > startedAt || !next.has(message.id)) next.set(message.id, message);
        }
        return [...next.values()].sort((a, b) => a.seq - b.seq);
      });
      if (invalidTarget) setJumpError(true);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [workspaceId, threadId, focusMessageId]);

  const onEvent = useCallback((event: HubEvent) => {
    if (event.type === "message.created" && event.message.workspaceId === workspaceId && (event.message.threadId === threadId || event.message.id === threadId)) {
      const version = ++eventVersion.current;
      messageVersions.current.set(event.message.id, version);
      if (event.message.id === threadId) {
        anchorVersion.current = version;
        setAnchor(event.message);
      } else setMessages((current) => current.some((message) => message.id === event.message.id) ? current : [...current, event.message].sort((a, b) => a.seq - b.seq));
    } else if (event.type === "message.updated" && event.message.workspaceId === workspaceId && (event.message.threadId === threadId || event.message.id === threadId)) {
      const version = ++eventVersion.current;
      messageVersions.current.set(event.message.id, version);
      if (event.message.id === threadId) {
        anchorVersion.current = version;
        setAnchor(event.message);
      } else setMessages((current) => current.map((message) => message.id === event.message.id ? event.message : message));
    } else if (event.type === "thread.updated" && event.thread.id === threadId && event.thread.workspaceId === workspaceId) {
      threadVersion.current = ++eventVersion.current;
      setThread(event.thread);
    }
  }, [workspaceId, threadId]);

  const resync = useCallback(() => {
    setReconnectVersion((version) => version + 1);
    void load();
  }, [load]);
  useEffect(() => {
    // Fetch the thread after mount and when the selected target changes.
    void load();
  }, [load]);
  useHubEvents(workspaceId, onEvent, resync);

  useEffect(() => {
    const focus = () => { setFocused(true); setFocusVersion((version) => version + 1); };
    const blur = () => setFocused(false);
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    return () => { window.removeEventListener("focus", focus); window.removeEventListener("blur", blur); };
  }, []);

  const throughSeq = useMemo(() => messages.reduce((max, message) => Math.max(max, message.seq), 0), [messages]);
  const acknowledge = useCallback(async () => {
    const through = Math.max(throughSeq, pendingSeq.current);
    pendingSeq.current = through;
    if (!thread || through === 0 || through <= confirmedSeq.current || !active || !focused || inFlightSeq.current !== null) return;
    inFlightSeq.current = through;
    try {
      await markThreadRead(workspaceId, threadId, through);
      confirmedSeq.current = Math.max(confirmedSeq.current, through);
    } catch {
      // Keep the pending sequence; a later focus or reconnect retries it.
    } finally {
      inFlightSeq.current = null;
      if (pendingSeq.current > through) setRetryVersion((version) => version + 1);
    }
  }, [thread, throughSeq, workspaceId, threadId, active, focused]);
  useEffect(() => { void acknowledge(); }, [acknowledge, focusVersion, reconnectVersion, retryVersion]);

  const scrollWithinThread = useCallback((messageId: string) => {
    const targetId = `msg-${messageId}`;
    const target = [...(root.current?.querySelectorAll<HTMLElement>("[id]") ?? [])].find((element) => element.id === targetId);
    target?.scrollIntoView?.({ behavior: "smooth", block: "center" });
    return Boolean(target);
  }, []);
  useLayoutEffect(() => {
    const targetId = pendingScroll.current ?? (!initialFocusDone.current ? focusMessageId ?? null : null);
    if (!targetId || !scrollWithinThread(targetId)) return;
    pendingScroll.current = null;
    if (targetId === focusMessageId) initialFocusDone.current = true;
  }, [messages, anchor, entry, focusMessageId, jumpVersion, scrollWithinThread]);

  async function send(content: string, quoted?: Message | null) {
    const { message } = await postThreadMessage(workspaceId, threadId, content, quoted?.id);
    setMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message].sort((a, b) => a.seq - b.seq));
    if (quoted) setQuote(null);
  }

  const jump = useCallback(async (messageId: string) => {
    try {
      const message = await getMessage(workspaceId, messageId);
      if (message.workspaceId !== workspaceId) { setJumpError(true); return; }
      setEntry(null);
      setJumpError(false);
      if (message.id === threadId || message.threadId === threadId) {
        if (message.id !== threadId && !messages.some((item) => item.id === message.id)) setMessages((current) => [...current, message].sort((a, b) => a.seq - b.seq));
        pendingScroll.current = message.id;
        setJumpVersion((version) => version + 1);
        return;
      }
      if (message.threadId) {
        if (onOpenThread) onOpenThread(workspaceId, message.threadId, message.id);
        else if ("nemaWindowControls" in window) window.open(threadUrl(workspaceId, message.threadId, message.id), "_blank");
        else window.location.assign(threadUrl(workspaceId, message.threadId, message.id));
        return;
      }
      if (onOpenMainMessage) onOpenMainMessage(workspaceId, message);
      else window.location.assign(mainMessageUrl(workspaceId, message.id));
    } catch {
      setJumpError(true);
    }
  }, [workspaceId, threadId, messages, onOpenThread, onOpenMainMessage]);

  const openEntry = (entryId: string) => setEntry({ id: entryId, history: false });
  const onThread = async (content: string) => { await send(content); };
  return (
    <section ref={root} className={floating ? "thread-window" : "thread-page"} data-thread-id={threadId}>
      <header className="thread-header">
        <div><b>{thread?.title ?? "…"}</b><span>{t("thread.replies", { n: thread?.replyCount ?? messages.length })}</span></div>
        {onClose && <button type="button" aria-label={t("common.close")} onClick={onClose}>×</button>}
      </header>
      {loadError && <p className="error thread-error" role="alert">{t("thread.loadFailed")} <button type="button" onClick={() => void load()}>{t("thread.retry")}</button></p>}
      {jumpError && <p className="error thread-error" role="alert">{t("thread.jumpUnavailable")}</p>}
      <div className="thread-scroll">
        {anchor && <div className="thread-anchor"><span>{t("thread.anchor")}</span><MessageItem message={anchor} onOpenEntry={openEntry} onQuote={setQuote} onEdited={setAnchor} onJump={jump} onOpenHistory={(id) => setEntry({ id, history: true })} /></div>}
        {messages.map((message) => <MessageItem key={message.id} message={message} onOpenEntry={openEntry} onQuote={setQuote} onEdited={(next) => setMessages((current) => current.map((item) => item.id === next.id ? next : item))} onJump={jump} onOpenHistory={(id) => setEntry({ id, history: true })} />)}
      </div>
      <Composer onSend={(content) => send(content, quote)} quote={quote} onClearQuote={() => setQuote(null)} onThread={onThread} threadMode disabled={loadError || !thread} />
      {entry && <div className="thread-entry"><EntryDetail key={`${entry.id}:${entry.history}`} workspaceId={workspaceId} entryId={entry.id} onClose={() => setEntry(null)} onOpenEntry={openEntry} onJumpToMessage={(id) => void jump(id)} initialTab={entry.history ? "history" : "content"} /></div>}
    </section>
  );
}
