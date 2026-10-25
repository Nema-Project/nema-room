"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Composer } from "@/components/Composer";
import { MessageItem } from "@/components/MessageItem";
import { EntryDetail } from "@/components/EntryDetail";
import { getMessage, getThreadMessages, markThreadRead, postThreadMessage } from "@/lib/hub";
import { useT } from "@/lib/i18n";
import type { HubEvent, Message, Thread } from "@/lib/types";
import { useHubEvents } from "@/lib/useHubEvents";
import { threadUrl } from "@/lib/threads";

export type ThreadViewProps = {
  workspaceId: string;
  threadId: string;
  active?: boolean;
  floating?: boolean;
  onClose?: () => void;
  onOpenThread?: (workspaceId: string, threadId: string, messageId?: string) => void;
  event?: HubEvent;
  focusMessageId?: string;
};

export function ThreadView({ workspaceId, threadId, active = true, floating = false, onClose, onOpenThread, event, focusMessageId }: ThreadViewProps) {
  const t = useT();
  const [thread, setThread] = useState<Thread | null>(null);
  const [anchor, setAnchor] = useState<Message | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [entry, setEntry] = useState<{ id: string; history: boolean } | null>(null);
  const [quote, setQuote] = useState<Message | null>(null);
  const [focused, setFocused] = useState(() => typeof document === "undefined" || document.hasFocus());
  const acked = useRef(0);
  const load = useCallback(async () => {
    const result = await getThreadMessages(workspaceId, threadId);
    setThread(result.thread);
    setAnchor(result.anchor);
    if (focusMessageId && focusMessageId !== result.anchor.id && !result.messages.some((message) => message.id === focusMessageId)) {
      const target = await getMessage(workspaceId, focusMessageId);
      setMessages([...result.messages, target].sort((a, b) => a.seq - b.seq));
    } else setMessages(result.messages);
  }, [workspaceId, threadId, focusMessageId]);
  useEffect(() => {
    // Load this thread after mount and when the selected target changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  const handleEvent = useCallback((e: HubEvent) => {
    if (e.type === "message.created" && e.message.workspaceId === workspaceId && (e.message.threadId === threadId || e.message.id === threadId)) {
      if (e.message.id === threadId) setAnchor(e.message);
      else setMessages((current) => current.some((m) => m.id === e.message.id) ? current : [...current, e.message]);
    } else if (e.type === "message.updated" && e.message.workspaceId === workspaceId) {
      if (e.message.id === threadId) setAnchor(e.message);
      setMessages((current) => current.map((m) => m.id === e.message.id ? e.message : m));
    } else if (e.type === "thread.updated" && e.thread.id === threadId) setThread(e.thread);
  }, [workspaceId, threadId]);
  useEffect(() => {
    // Parent SSE events update every mounted floating window.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (event) handleEvent(event);
  }, [event, handleEvent]);
  useHubEvents(floating ? null : workspaceId, handleEvent);
  useEffect(() => {
    if (!focusMessageId || !messages.some((message) => message.id === focusMessageId)) return;
    document.getElementById(`msg-${focusMessageId}`)?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  }, [focusMessageId, messages]);
  useEffect(() => {
    const focus = () => setFocused(true);
    const blur = () => setFocused(false);
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    return () => { window.removeEventListener("focus", focus); window.removeEventListener("blur", blur); };
  }, []);
  const throughSeq = useMemo(() => messages.reduce((max, message) => Math.max(max, message.seq), 0), [messages]);
  useEffect(() => {
    if (!thread || throughSeq <= acked.current || !active || !focused) return;
    acked.current = throughSeq;
    void markThreadRead(workspaceId, threadId, throughSeq);
  }, [thread, throughSeq, workspaceId, threadId, active, floating, focused]);

  async function send(content: string, quoted?: Message | null) {
    const { message } = await postThreadMessage(workspaceId, threadId, content, quoted?.id);
    setMessages((current) => current.some((m) => m.id === message.id) ? current : [...current, message]);
    if (quoted) setQuote(null);
  }
  const jump = useCallback(async (messageId: string) => {
    const message = await getMessage(workspaceId, messageId);
    if (message.threadId) {
      if (message.threadId !== threadId) {
        if (onOpenThread) onOpenThread(workspaceId, message.threadId, message.id);
        else if ("nemaWindowControls" in window) window.open(threadUrl(workspaceId, message.threadId, message.id), "_blank");
        else window.location.assign(threadUrl(workspaceId, message.threadId, message.id));
      } else if (!messages.some((item) => item.id === message.id) && anchor?.id !== message.id) {
        setMessages((current) => [...current, message].sort((a, b) => a.seq - b.seq));
      }
      return;
    }
    document.getElementById(`msg-${messageId}`)?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  }, [workspaceId, threadId, onOpenThread, messages, anchor]);
  const openEntry = (entryId: string) => setEntry({ id: entryId, history: false });
  const onThread = async (content: string) => { /* nested /thread is intentionally unavailable */ await send(content); };
  return (
    <section className={floating ? "thread-window" : "thread-page"} data-thread-id={threadId}>
      <header className="thread-header">
        <div><b>{thread?.title ?? "…"}</b><span>{t("thread.replies", { n: thread?.replyCount ?? messages.length })}</span></div>
        {onClose && <button type="button" aria-label={t("common.close")} onClick={onClose}>×</button>}
      </header>
      <div className="thread-scroll">
        {anchor && <div className="thread-anchor"><span>{t("thread.anchor")}</span><MessageItem message={anchor} onOpenEntry={openEntry} onQuote={setQuote} onEdited={(next) => setAnchor(next)} onJump={jump} onOpenHistory={(id) => setEntry({ id, history: true })} /></div>}
        {messages.map((message) => <MessageItem key={message.id} message={message} onOpenEntry={openEntry} onQuote={setQuote} onEdited={(next) => setMessages((cur) => cur.map((m) => m.id === next.id ? next : m))} onJump={jump} onOpenHistory={(id) => setEntry({ id, history: true })} />)}
      </div>
      <Composer onSend={(content) => send(content, quote)} quote={quote} onClearQuote={() => setQuote(null)} onThread={onThread} threadMode />
      {entry && <div className="thread-entry"><EntryDetail key={`${entry.id}:${entry.history}`} workspaceId={workspaceId} entryId={entry.id} onClose={() => setEntry(null)} onOpenEntry={openEntry} onJumpToMessage={(id) => void jump(id)} initialTab={entry.history ? "history" : "content"} /></div>}
    </section>
  );
}
