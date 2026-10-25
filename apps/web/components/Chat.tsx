"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { Composer } from "@/components/Composer";
import { AgentAvatar, MessageItem, messageRoleLabel } from "@/components/MessageItem";
import { formatDay, formatTime } from "@/lib/format";
import { getActiveTask, listMessages, postMessage, searchMessages } from "@/lib/hub";
import { useLocale, useT } from "@/lib/i18n";
import type { AgentMessageMeta, HubEvent, Message } from "@/lib/types";

export type ChatHandle = {
  scrollToMessage: (messageId: string) => void;
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

/** The latest follow-up with no user reply after it. Older cards stay as history. */
export function answerableMessageId(messages: Message[]): string | null {
  let id: string | null = null;
  let answered = false;
  for (const m of messages) {
    if (m.role === "user") {
      if (id) answered = true;
      continue;
    }
    const asked = m.role === "agent" ? (m.meta as AgentMessageMeta | null)?.askedQuestion : null;
    if (asked) {
      id = m.id;
      answered = false;
    }
  }
  return answered ? null : id;
}

export const Chat = forwardRef<ChatHandle, Props>(function Chat({ workspaceId, connected = true, onOpenEntry }, ref) {
  const t = useT();
  const [locale] = useLocale();
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [runningTask, setRunningTask] = useState<string | null>(null);
  const [progress, setProgress] = useState<string>("");
  const [quote, setQuote] = useState<Message | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Message[] | null>(null);
  const [openHit, setOpenHit] = useState<string | null>(null);
  const stream = useRef<HTMLDivElement>(null);
  // Bumped by every SSE-driven change of runningTask and by every active-task request, so a stale HTTP response never overwrites newer state.
  const taskVersion = useRef(0);

  const load = useCallback(async () => {
    try {
      const list = await listMessages(workspaceId);
      // Keep anything that arrived over SSE while the request was in flight.
      setMessages((cur) => list.concat(cur.filter((c) => !list.some((l) => l.id === c.id))));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [workspaceId]);

  // The server is the source of truth for "is a task running": seed on mount and replace stale state on resync.
  const loadActive = useCallback(async () => {
    const mine = ++taskVersion.current;
    try {
      const { running } = await getActiveTask(workspaceId);
      if (mine !== taskVersion.current) return; // an SSE event or a newer request superseded this response
      setRunningTask(running ? running.id : null);
      setProgress("");
    } catch {
      /* keep whatever we have; the next event or resync corrects it */
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
    void loadActive();
  }, [load, loadActive]);

  const scrollToMessage = (id: string) => {
    document.getElementById(`msg-${id}`)?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  };

  useImperativeHandle(
    ref,
    () => ({
      scrollToMessage,
      handleEvent(e) {
        if (e.type === "message.created" && e.message.workspaceId === workspaceId) {
          setMessages((l) => merge(l, e.message));
          const done = e.message.taskId;
          if (done && e.message.role !== "user") {
            taskVersion.current++;
            setRunningTask((cur) => (cur === done ? null : cur));
          }
        } else if (e.type === "message.updated" && e.message.workspaceId === workspaceId) {
          // Only a message we already show is replaced; one not loaded yet arrives with the next load.
          setMessages((l) => l.map((x) => (x.id === e.message.id ? e.message : x)));
        } else if (e.type === "task.updated" && e.task.workspaceId === workspaceId) {
          taskVersion.current++;
          if (e.task.status === "running") {
            setRunningTask(e.task.id);
            setProgress("");
          } else setRunningTask((cur) => (cur === e.task.id ? null : cur));
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
      },
    }),
    [workspaceId, load, loadActive],
  );

  useLayoutEffect(() => {
    const el = stream.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, runningTask, progress]);

  async function send(content: string, quoted?: Message | null) {
    const { message } = quoted ? await postMessage(workspaceId, content, quoted.id) : await postMessage(workspaceId, content);
    setMessages((l) => merge(l, message));
    if (quoted) setQuote(null);
  }

  async function search() {
    const term = query.trim();
    if (!term) {
      setHits(null);
      return;
    }
    setHits(await searchMessages(workspaceId, term));
  }

  const answerId = answerableMessageId(messages);
  let lastDay = "";
  return (
    <>
      {!connected && (
        <div className="offline" role="status">
          {t("chat.offline")}
        </div>
      )}
      <div className="search">
        <input
          placeholder={t("chat.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void search();
          }}
        />
        {hits && hits.length === 0 && <p>{t("chat.noResults")}</p>}
        {hits?.map((hit) => (
          <div
            key={hit.id}
            className="search-hit"
            onClick={() => {
              if (document.getElementById(`msg-${hit.id}`)) scrollToMessage(hit.id);
              else setOpenHit((cur) => (cur === hit.id ? null : hit.id));
            }}
          >
            <span>{messageRoleLabel(t, hit.role)}</span>
            <time>{formatTime(new Date(hit.createdAt), locale)}</time>
            {openHit === hit.id ? hit.content : <Snippet content={hit.content} q={query} />}
            <button type="button" onClick={(e) => { e.stopPropagation(); setQuote(hit); }}>{t("chat.quote")}</button>
          </div>
        ))}
      </div>
      <div className="stream" ref={stream}>
        {messages.map((m) => {
          const key = dayKey(m.createdAt);
          const divider = key !== lastDay;
          lastDay = key;
          return (
            <div key={m.id}>
              {divider && <div className="day">{formatDay(new Date(m.createdAt), locale)}</div>}
              <MessageItem
                message={m}
                onOpenEntry={onOpenEntry}
                onAnswer={m.id === answerId ? (content) => send(content) : undefined}
                onQuote={setQuote}
                onEdited={(message) => setMessages((l) => l.map((x) => (x.id === message.id ? message : x)))}
                onJump={scrollToMessage}
              />
            </div>
          );
        })}
        {runningTask && (
          <div className="msg">
            <AgentAvatar />
            <div>
              <div className="who">Nema</div>
              <div className="working">
                <span className="bar2" />
                {progress ? `${t("chat.working")} · ${progress}` : t("chat.working")}
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
      <Composer onSend={(content) => send(content, quote)} quote={quote} onClearQuote={() => setQuote(null)} />
    </>
  );
});
