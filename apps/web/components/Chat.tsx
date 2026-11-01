"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { MessageMention } from "@nema/shared";
import { Composer } from "@/components/Composer";
import { AgentAvatar, MessageItem, messageRoleLabel } from "@/components/MessageItem";
import { formatDay, formatTime } from "@/lib/format";
import { createThread, getActiveTask, getMessage, listMessages, listThreads, postMessage, searchMessages } from "@/lib/hub";
import { useLocale, useT } from "@/lib/i18n";
import type { HubEvent, Message, Thread } from "@/lib/types";

export type ChatHandle = {
  scrollToMessage: (messageId: string) => void;
  showMessage: (message: Message) => void;
  /** The page owns the single SSE subscription and forwards events here. */
  handleEvent: (e: HubEvent) => void;
  /** Refetch after the stream reconnected (events in between were lost). */
  resync: () => void;
};

type Props = {
  workspaceId: string;
  connected?: boolean;
  /** Opens an entry in the knowledge column (a report's entry ids). */
  onOpenEntry?: (entryId: string) => void;
  onOpenThread?: (threadId: string, messageId?: string) => void;
  onOpenHistory?: (entryId: string) => void;
  searchOpen?: boolean;
  onSearchClose?: () => void;
};

function Snippet({ content, q }: { content: string; q: string }) {
  const needle = q.trim();
  const at = content.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0 || needle === "") return <>{content}</>;
  const start = Math.max(0, at - 40);
  const end = Math.min(content.length, at + needle.length + 40);
  return (
    <>
      {content.slice(start, at)}
      <mark>{content.slice(at, at + needle.length)}</mark>
      {content.slice(at + needle.length, end)}
    </>
  );
}

const dayKey = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

function merge(list: Message[], m: Message): Message[] {
  return list.some((x) => x.id === m.id) ? list : [...list, m];
}

export const Chat = forwardRef<ChatHandle, Props>(function Chat({ workspaceId, connected = true, onOpenEntry, onOpenThread, onOpenHistory, searchOpen = false, onSearchClose }, ref) {
  const t = useT();
  const [locale] = useLocale();
  const [messages, setMessages] = useState<Message[]>([]);
  const [threads, setThreads] = useState<Map<string, Thread>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [runningTask, setRunningTask] = useState<string | null>(null);
  const [runningMessageId, setRunningMessageId] = useState<string | null>(null);
  const [indexing, setIndexing] = useState<{ repoId: string; label: string }[]>([]);
  const [progress, setProgress] = useState<string>("");
  const [quote, setQuote] = useState<Message | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Message[] | null>(null);
  const [openHit, setOpenHit] = useState<string | null>(null);
  const stream = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  // Bumped by every SSE-driven change of runningTask and by every active-task request, so a stale HTTP response never overwrites newer state.
  const taskVersion = useRef(0);
  const indexVersion = useRef(0);
  const runningId = useRef<string | null>(null);
  const messageVersion = useRef(0);
  const messageVersions = useRef(new Map<string, number>());
  const threadVersion = useRef(0);
  const threadVersions = useRef(new Map<string, number>());
  const pendingJump = useRef<string | null>(null);
  const [jumpTick, setJumpTick] = useState(0);

  const load = useCallback(async () => {
    const startedAt = messageVersion.current;
    try {
      const list = (await listMessages(workspaceId)).filter((message) => message.threadId == null);
      setMessages((cur) => {
        const next = new Map(list.map((message) => [message.id, message]));
        for (const message of cur) {
          if ((messageVersions.current.get(message.id) ?? 0) > startedAt || !next.has(message.id)) next.set(message.id, message);
        }
        return [...next.values()].sort((a, b) => a.seq - b.seq);
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [workspaceId]);


  const loadThreads = useCallback(async () => {
    const startedAt = threadVersion.current;
    try {
      const list = await listThreads(workspaceId);
      setThreads((current) => {
        const next = new Map(list.map((thread) => [thread.id, thread]));
        for (const [id, version] of threadVersions.current) {
          if (version > startedAt) {
            const newer = current.get(id);
            if (newer) next.set(id, newer);
          }
        }
        return next;
      });
    } catch {
      /* retain rows already on screen */
    }
  }, [workspaceId]);

  // The server is the source of truth for "is a task running": seed on mount and replace stale state on resync.
  const loadActive = useCallback(async () => {
    const mine = ++taskVersion.current;
    const indexMine = indexVersion.current;
    try {
      const { running, indexing: active } = await getActiveTask(workspaceId);
      if (indexMine === indexVersion.current) setIndexing(active ?? []);
      if (mine !== taskVersion.current) return; // an SSE event or a newer request superseded this response
      runningId.current = running ? running.id : null;
      setRunningTask(running ? running.id : null);
      setRunningMessageId(running ? running.messageId : null);
      setProgress("");
    } catch {
      /* keep whatever we have; the next event or resync corrects it */
    }
  }, [workspaceId]);

  useEffect(() => {
    // Fetches seed component state from the hub after mount.
    void load();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount, state updates after the network response
    void loadActive();
    void loadThreads();
  }, [load, loadActive, loadThreads]);

  const scrollToMessage = (id: string) => {
    const element = [...(stream.current?.querySelectorAll<HTMLElement>("[id]") ?? [])].find((item) => item.id === `msg-${id}`);
    element?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  };
  const hasMessage = (id: string) => [...(stream.current?.querySelectorAll<HTMLElement>("[id]") ?? [])].some((item) => item.id === `msg-${id}`);
  const showMessage = useCallback((message: Message) => {
    if (message.workspaceId !== workspaceId || message.threadId != null) return;
    setMessages((current) => merge(current, message));
    pendingJump.current = message.id;
    setJumpTick((tick) => tick + 1);
  }, [workspaceId]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToMessage,
      showMessage,
      handleEvent(e) {
        if (e.type === "message.created" && e.message.workspaceId === workspaceId) {
          if (e.message.threadId == null) {
            messageVersions.current.set(e.message.id, ++messageVersion.current);
            setMessages((l) => merge(l, e.message));
          }
          const done = e.message.taskId;
          if (done && e.message.role !== "user") {
            taskVersion.current++;
            if (runningId.current === done) {
              runningId.current = null;
              setRunningMessageId(null);
            }
            setRunningTask((cur) => (cur === done ? null : cur));
          }
        } else if (e.type === "message.updated" && e.message.workspaceId === workspaceId) {
          if (e.message.threadId == null) {
            messageVersions.current.set(e.message.id, ++messageVersion.current);
            setMessages((l) => l.map((x) => (x.id === e.message.id ? e.message : x)));
          }
        } else if (e.type === "task.updated" && e.task.workspaceId === workspaceId) {
          taskVersion.current++;
          if (e.task.status === "running") {
            runningId.current = e.task.id;
            setRunningTask(e.task.id);
            setRunningMessageId(e.task.messageId);
            setProgress("");
          } else if (runningId.current === e.task.id) {
            runningId.current = null;
            setRunningTask(null);
            setRunningMessageId(null);
          }
        } else if (e.type === "repo.index") {
          indexVersion.current++;
          setIndexing((cur) =>
            e.status === "running"
              ? cur.some((row) => row.repoId === e.repoId) ? cur : [...cur, { repoId: e.repoId, label: e.label }]
              : cur.filter((row) => row.repoId !== e.repoId),
          );
        } else if (e.type === "thread.updated" && e.thread.workspaceId === workspaceId) {
          threadVersions.current.set(e.thread.id, ++threadVersion.current);
          setThreads((current) => new Map(current).set(e.thread.id, e.thread));
        } else if (e.type === "task.progress") {
          setRunningTask((cur) => {
            if (cur === e.taskId) setProgress(e.text);
            return cur;
          });
        }
      },
      resync: () => {
        void load();
        void loadActive();
        void loadThreads();
      },
    }),
    [workspaceId, load, loadActive, loadThreads, showMessage],
  );

  const runningMessage = runningMessageId ? messages.find((m) => m.id === runningMessageId) : undefined;
  // ponytail: the hub's bind prompt contains 画架构图. The bar label depends on that phrase.
  const drawingDiagram = runningMessage?.role === "system" && runningMessage.content.includes("画架构图");

  useLayoutEffect(() => {
    const el = stream.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, runningTask, progress, indexing]);

  useLayoutEffect(() => {
    const id = pendingJump.current;
    if (!id) return;
    scrollToMessage(id);
    pendingJump.current = null;
  }, [messages, jumpTick]);

  async function send(content: string, attachmentIds: string[], mentions?: MessageMention[], quoted?: Message | null, accountId?: string | null) {
    const { message } = accountId
      ? await postMessage(workspaceId, content, quoted?.id, attachmentIds, mentions, accountId)
      : await postMessage(workspaceId, content, quoted?.id, attachmentIds, mentions);
    setMessages((l) => merge(l, message));
    if (quoted) setQuote(null);
  }

  useEffect(() => {
    if (searchOpen) searchInput.current?.focus();
  }, [searchOpen]);

  async function search() {
    const term = query.trim();
    if (!term) {
      setHits(null);
      return;
    }
    setHits(await searchMessages(workspaceId, term));
  }

  async function jumpToMessage(id: string) {
    if (hasMessage(id)) { scrollToMessage(id); return; }
    try {
      const message = await getMessage(workspaceId, id);
      if (message.threadId) onOpenThread?.(message.threadId, message.id);
      else showMessage(message);
    } catch { /* a deleted source can no longer be opened */ }
  }

  async function createThreadFromComposer(content: string, attachmentIds: string[], mentions?: MessageMention[], accountId?: string | null) {
    const result = accountId
      ? await createThread(workspaceId, content, quote?.id, attachmentIds, mentions, accountId)
      : await createThread(workspaceId, content, quote?.id, attachmentIds, mentions);
    setMessages((cur) => merge(cur, result.message));
    setThreads((cur) => new Map(cur).set(result.thread.id, result.thread));
    setQuote(null);
    onOpenThread?.(result.thread.id);
  }

  return (
    <>
      {!connected && (
        <div className="offline" role="status">
          {t("chat.offline")}
        </div>
      )}
      {searchOpen && <div className="search">
        <input
          ref={searchInput}
          placeholder={t("chat.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void search();
            if (e.key === "Escape") onSearchClose?.();
          }}
        />
        {hits && hits.length === 0 && <p>{t("chat.noResults")}</p>}
        {hits?.map((hit) => (
          <div
            key={hit.id}
            className="search-hit"
            onClick={() => {
              if (hasMessage(hit.id)) scrollToMessage(hit.id);
              else { setOpenHit((cur) => (cur === hit.id ? null : hit.id)); void jumpToMessage(hit.id); }
            }}
          >
            <span>{messageRoleLabel(t, hit.role)}</span>
            <time>{formatTime(new Date(hit.createdAt), locale)}</time>
            {openHit === hit.id ? hit.content : <Snippet content={hit.content} q={query} />}
            <button type="button" onClick={(e) => { e.stopPropagation(); setQuote(hit); }}>{t("chat.quote")}</button>
          </div>
        ))}
      </div>}
      <div className="stream" ref={stream}>
        {messages.map((m, index) => {
          const key = dayKey(m.createdAt);
          const divider = index === 0 || key !== dayKey(messages[index - 1]!.createdAt);
          return (
            <div key={m.id}>
              {divider && <div className="day">{formatDay(new Date(m.createdAt), locale)}</div>}
              <MessageItem
                message={m}
                onOpenEntry={onOpenEntry}
                onQuote={setQuote}
                onEdited={(message) => setMessages((l) => l.map((x) => (x.id === message.id ? message : x)))}
                onJump={jumpToMessage}
                onOpenHistory={onOpenHistory}
              />
              {threads.has(m.id) && <button type="button" className="thread-row" onClick={() => onOpenThread?.(m.id)}><b>{threads.get(m.id)!.title}</b><span>{t("thread.replyCount", { n: threads.get(m.id)!.replyCount })}</span>{threads.get(m.id)!.unread > 0 && <strong>{threads.get(m.id)!.unread}</strong>}<time>{threads.get(m.id)!.lastReplyAt ? formatTime(new Date(threads.get(m.id)!.lastReplyAt!), locale) : ""}</time></button>}
            </div>
          );
        })}
        {indexing.map((row) => (
          <div className="msg" key={row.repoId}>
            <AgentAvatar />
            <div>
              <div className="who">Nema</div>
              <div className="working">
                <span className="bar2" />
                {t("chat.indexing", { label: row.label })}
              </div>
            </div>
          </div>
        ))}
        {runningTask && (
          <div className="msg">
            <AgentAvatar />
            <div>
              <div className="who">Nema</div>
              <div className="working">
                <span className="bar2" />
                {progress ? `${t("chat.working")} · ${progress}` : drawingDiagram ? t("chat.drawingDiagram") : t("chat.working")}
              </div>
            </div>
          </div>
        )}
      </div>
      {error && (
        <p className="error banner" role="alert">
          {t("common.error", { message: error })}
        </p>
      )}
      <Composer workspaceId={workspaceId} onSend={(content, attachmentIds, mentions, accountId) => send(content, attachmentIds, mentions, quote, accountId)} onThread={createThreadFromComposer} quote={quote} onClearQuote={() => setQuote(null)} />
    </>
  );
});
