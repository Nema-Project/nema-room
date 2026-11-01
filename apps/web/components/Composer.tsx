"use client";

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { MENTION_LIMITS, messageHasBody, type MessageMention } from "@nema/shared";
import { AccountPicker } from "@/components/AccountPicker";
import { AttachmentTray } from "@/components/AttachmentTray";
import { messageRoleLabel } from "@/components/MessageItem";
import { useAttachmentTray } from "@/lib/attachments";
import { applyFormat, type FormatKind } from "@/lib/markdownFormat";
import { applySlash, matchingItems, slashToken, type SkillRow, type SlashItem } from "@/lib/slash";
import { MentionMenu, MentionTray, type MentionChip } from "@/components/MentionMenu";
import { groupCandidates, mentionToken, syncMentions, type MentionCandidate, type MentionContextResponse } from "@/lib/mentions";
import { searchMentionContext } from "@/lib/hub";
import { useAccounts } from "@/lib/useAccounts";
import { useSkillRows } from "@/lib/skillMenu";
import { useT } from "@/lib/i18n";
import type { Message } from "@/lib/types";

function excerpt(content: string): string {
  const chars = Array.from(content);
  return chars.length <= 200 ? content : chars.slice(0, 200).join("");
}

/** How long typing in an `@` token waits before asking the hub, and how long an answer is reused. */
const MENTION_DEBOUNCE_MS = 150;
const MENTION_CACHE_MS = 30_000;
/** Matches the hub's own limit on a mention query. */
const EMPTY_CONTEXT: MentionContextResponse = { status: "ok", entries: [], attachments: [], threads: [], truncated: false };

function availableItems(value: string, token: { query: string; start: number }, skills: readonly SkillRow[], threadMode: boolean): SlashItem[] {
  // Skills only when the `/` starts the whole message; other lines keep just the built-in commands.
  return matchingItems(token.query, { atMessageStart: value.slice(0, token.start).trim() === "", skills, threadMode });
}

export function Composer({
  workspaceId,
  onSend,
  quote,
  onClearQuote,
  onThread,
  threadMode = false,
  threadId,
  disabled = false,
}: {
  /** Enables attachments: uploads are staged in this workspace. */
  workspaceId?: string;
  onSend: (content: string, attachmentIds: string[], mentions?: MessageMention[], accountId?: string | null) => Promise<void>;
  quote?: { role: Message["role"]; content: string } | null;
  onClearQuote?: () => void;
  onThread?: (content: string, attachmentIds: string[], mentions?: MessageMention[], accountId?: string | null) => Promise<void>;
  threadMode?: boolean;
  /** The thread this composer posts into, when it posts into one. */
  threadId?: string;
  disabled?: boolean;
}) {
  const t = useT();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const composing = useRef(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const pendingSel = useRef<[number, number] | null>(null);
  const [cursor, setCursor] = useState(0);
  const [active, setActive] = useState(0);
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const tray = useAttachmentTray(workspaceId);
  // The per-message account choice lives only here: it travels with this send and is stored nowhere (spec
  // §1.2). `null` means "not chosen", which the daemon resolves from the thread's and then the workspace's
  // binding, then the global default.
  const accountsState = useAccounts();
  const [accountId, setAccountId] = useState<string | null>(null);
  const token = slashToken(value, cursor);
  // `@` owns the menu whenever the caret sits in a mention token; the `/` menu keeps its line-start rule and
  // only yields while a mention token is open, so the two can never show at once.
  const at = slashToken(value, cursor) === null ? mentionToken(value, cursor) : null;
  const skills = useSkillRows(workspaceId, token !== null);
  const matches = token ? availableItems(value, token, skills, threadMode) : [];
  const tokenKey = token ? `${token.start}:${token.query}` : "";
  const menuOpen = token !== null && matches.length > 0 && closedFor !== tokenKey;
  const highlighted = matches.length === 0 ? 0 : active % matches.length;

  // --- @ mentions -----------------------------------------------------------------------------------------
  // The chips are the message's mentions. They follow the body: a chip whose text is gone from the body goes too.
  const [chips, setChips] = useState<MentionChip[]>([]);
  const [context, setContext] = useState<MentionContextResponse>(EMPTY_CONTEXT);
  /** Whether the menu's answer is still on its way, failed, or a real (possibly empty) result. */
  const [contextState, setContextState] = useState<"idle" | "loading" | "ok" | "failed">("idle");
  const [mentionActive, setMentionActive] = useState(0);
  const [mentionClosedFor, setMentionClosedFor] = useState<string | null>(null);
  const cache = useRef(new Map<string, { at: number; ctx: MentionContextResponse }>());
  const atKey = at ? `${at.start}:${at.query}` : "";
  const groups = useMemo(() => (at ? groupCandidates(at.query, context) : []), [at, context]);
  const mentionRows = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const mentionOpen = at !== null && workspaceId !== undefined && mentionClosedFor !== atKey;

  useEffect(() => {
    if (!at || workspaceId === undefined) return;
    const key = at.query.trim();
    const hit = cache.current.get(key);
    if (hit && Date.now() - hit.at < MENTION_CACHE_MS) {
      setContext(hit.ctx);
      setContextState("ok");
      return;
    }
    setContextState("loading");
    let live = true;
    const timer = setTimeout(() => {
      searchMentionContext(workspaceId, key)
        .then((ctx) => {
          cache.current.set(key, { at: Date.now(), ctx });
          // A later keystroke or another workspace may have moved on; that request owns the menu now.
          if (live) {
            setContext(ctx);
            setContextState("ok");
          }
        })
        .catch(() => {
          if (live) {
            setContext(EMPTY_CONTEXT);
            setContextState("failed"); // the menu says it could not look; typing and sending still work
          }
        });
    }, MENTION_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [at, workspaceId]);

  const syncChips = useCallback((content: string) => {
    setChips((cur) => {
      const kept = syncMentions(content, cur.map((c) => c.mention));
      return kept.map((mention) => cur.find((c) => c.mention === mention) ?? cur.find((c) => c.mention.type === mention.type && c.mention.id === mention.id)!);
    });
  }, []);

  function chooseMention(item: MentionCandidate) {
    const el = ref.current;
    const caret = el?.selectionStart ?? cursor;
    const current = mentionToken(el?.value ?? value, caret);
    if (!current) return;
    const text = el?.value ?? value;
    // A message carries at most MENTION_LIMITS.perMessage mentions; refuse the extra one instead of failing the send.
    if (chips.length >= MENTION_LIMITS.perMessage) {
      setError(t("mention.tooMany", { max: MENTION_LIMITS.perMessage }));
      return;
    }
    const insert = `${item.text} `;
    const next = { text: text.slice(0, current.start) + insert + text.slice(current.end), cursor: current.start + insert.length };
    setChips((cur) => [...cur, { mention: { type: item.type, id: item.id, text: item.text } as MessageMention, label: item.type === "entry" ? `[${item.id}]` : item.label }]);
    place(next.text, next.cursor);
    setMentionActive(0);
  }

  function removeMention(index: number) {
    const el = ref.current;
    const text = el?.value ?? value;
    const chip = chips[index];
    if (!chip) return;
    // Which occurrence this chip owns: the same text may have been inserted more than once on purpose, so the
    // k-th chip with a given text takes the k-th occurrence in the body, not always the first one.
    const k = chips.slice(0, index).filter((c) => c.mention.text === chip.mention.text).length;
    let at2 = -1;
    for (let seen = 0, i = text.indexOf(chip.mention.text); i !== -1; i = text.indexOf(chip.mention.text, i + chip.mention.text.length)) {
      if (seen++ === k) {
        at2 = i;
        break;
      }
    }
    // The insertion adds one space after the text; taking the chip out takes that space too.
    const end = at2 < 0 ? -1 : at2 + chip.mention.text.length + (text[at2 + chip.mention.text.length] === " " ? 1 : 0);
    const next = at2 < 0 ? text : text.slice(0, at2) + text.slice(end);
    setChips((cur) => cur.filter((_, i) => i !== index));
    place(next, Math.max(0, Math.min((el?.selectionStart ?? cursor), next.length)));
  }

  useLayoutEffect(() => {
    if (pendingSel.current && ref.current) {
      ref.current.focus();
      ref.current.setSelectionRange(...pendingSel.current);
      pendingSel.current = null;
    }
  });
  const highlightedId = matches[highlighted]?.id;
  useLayoutEffect(() => {
    if (!menuOpen || !highlightedId) return;
    document.getElementById(`slash-${highlightedId}`)?.scrollIntoView?.({ block: "nearest" });
  }, [menuOpen, highlightedId]);

  async function send() {
    const sent = value;
    const content = sent.trim();
    const attached = tray.ready;
    const ids = attached.map((a) => a.id);
    const mentions = chips.map((c) => c.mention);
    // Attachments still uploading, failed, or unreadable by the adapter (D-2) hold the message back.
    if (sending || tray.blocker || !messageHasBody(content, ids)) return;
    setSending(true);
    setError(null);
    const chosen = accountId;
    try {
      const threadText = content.match(/^\/thread\s+([\s\S]+)$/);
      // With no choice the callback is invoked exactly as it was before accounts existed: three arguments,
      // no `null`. A wrapper that ignores the new parameter therefore behaves identically, and only a send
      // that actually names an account carries one.
      if (threadText && onThread) {
        if (accountId === null) await onThread(threadText[1]!.trim(), ids, mentions);
        else await onThread(threadText[1]!.trim(), ids, mentions, accountId);
      } else if (accountId === null) {
        await onSend(content, ids, mentions);
      } else {
        await onSend(content, ids, mentions, accountId);
      }
      tray.clear(attached.map((a) => a.key));
      // Only the chips this send carried go; one added while it was in flight belongs to the text kept below.
      const sentChips = new Set(chips);
      setChips((cur) => cur.filter((c) => !sentChips.has(c)));
      sentChips.clear();
      // Text typed while the send was in flight stays: drop only what was sent.
      if (content !== "") setValue((cur) => (cur === sent ? "" : cur.startsWith(sent) ? cur.slice(sent.length).trimStart() : cur));
      // The choice belonged to the message that just went (spec §1.2: "this message's account"), so the
      // next one starts from the default again. A pick made while the send was in flight is left alone:
      // it is the next message's choice, not this one's.
      setAccountId((cur) => (cur === chosen ? null : cur));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e)); // keep the draft
    } finally {
      setSending(false);
    }
  }

  function place(text: string, caret: number) {
    pendingSel.current = [caret, caret];
    setValue(text);
    setCursor(caret);
    setActive(0);
    setClosedFor(null);
  }

  function choose(item: SlashItem) {
    const el = ref.current;
    const caret = el?.selectionStart ?? cursor;
    const current = slashToken(el?.value ?? value, caret);
    if (!current) return;
    const insert = item.skill ? item.insert : item.type ? t(item.insert, { type: item.type }) : t(item.insert);
    const next = applySlash(el?.value ?? value, current, insert);
    place(next.text, next.cursor);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
    const caret = e.currentTarget.selectionStart;
    // The @ menu, when it owns the caret. Same keys as the / menu; Esc closes until the token changes.
    const atNow = slashToken(e.currentTarget.value, caret) === null ? mentionToken(e.currentTarget.value, caret) : null;
    const atNowKey = atNow ? `${atNow.start}:${atNow.query}` : "";
    if (atNow && mentionClosedFor !== atNowKey) {
      const rows = groupCandidates(atNow.query, context).flatMap((g) => g.items);
      if (rows.length > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        setMentionActive((i) => (e.key === "ArrowDown" ? (i + 1) % rows.length : (i - 1 + rows.length) % rows.length));
        return;
      }
      if (rows.length > 0 && (e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
        e.preventDefault();
        chooseMention(rows[mentionActive % rows.length]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionClosedFor(atNowKey);
        return;
      }
    }
    const current = slashToken(e.currentTarget.value, caret);
    const shown = current ? availableItems(e.currentTarget.value, current, skills, threadMode) : [];
    const open = current !== null && shown.length > 0 && closedFor !== `${current.start}:${current.query}`;
    if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setActive((i) => {
        const n = shown.length;
        const cur = i % n;
        return e.key === "ArrowDown" ? (cur + 1) % n : (cur - 1 + n) % n;
      });
      return;
    }
    if (open && (e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
      e.preventDefault();
      choose(shown[highlighted % shown.length]!);
      return;
    }
    if (open && e.key === "Escape") {
      e.preventDefault();
      setClosedFor(`${current.start}:${current.query}`);
      return;
    }
    if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      void send();
    }
    // Plain Enter keeps the textarea default: a newline.
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData?.files ?? []);
    // Office apps put a picture of copied text next to the text itself; pasting text wins.
    if (!tray.enabled || files.length === 0 || (e.clipboardData.getData("text/plain") ?? "") !== "") return;
    e.preventDefault();
    void tray.add(files);
  }

  const hasFiles = (e: DragEvent) => tray.enabled && Array.from(e.dataTransfer?.types ?? []).includes("Files");
  function onDragOver(e: DragEvent<HTMLDivElement>) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setDragging(true);
  }
  function onDrop(e: DragEvent<HTMLDivElement>) {
    setDragging(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (!tray.enabled || files.length === 0) return;
    e.preventDefault();
    void tray.add(files);
  }

  function format(kind: FormatKind) {
    const el = ref.current;
    if (!el) return;
    const r = applyFormat(value, el.selectionStart, el.selectionEnd, kind);
    pendingSel.current = [r.selStart, r.selEnd];
    setValue(r.text);
  }

  return (
    <div className={dragging ? "composer att-drop" : "composer"} onDragOver={onDragOver} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
      {quote && (
        <div className="quote-bar">
          <span>
            <b>{messageRoleLabel(t, quote.role)}</b> {excerpt(quote.content)}
          </span>
          <button type="button" onClick={onClearQuote}>{t("chat.quoteRemove")}</button>
        </div>
      )}
      {mentionOpen && !menuOpen && (
        <MentionMenu
          groups={groups}
          active={mentionRows.length === 0 ? 0 : mentionActive % mentionRows.length}
          onChoose={chooseMention}
          onHover={setMentionActive}
          empty={{
            entries: context.entries.length > 0,
            attachments: context.attachments.length > 0,
            state: contextState,
            query: at?.query ?? "",
          }}
        />
      )}
      {menuOpen && (
        <div className="cmdmenu" id="slash-commands" role="listbox" aria-label={t("cmd.menu")}>
          {matches.map((item, i) => (
            <Fragment key={item.id}>
            {item.skill && !matches[i - 1]?.skill && (
              <div className="cmdgroup" role="presentation">
                {t("cmd.skills")}
              </div>
            )}
            <button
              type="button"
              role="option"
              id={`slash-${item.id}`}
              aria-selected={i === highlighted}
              className={i === highlighted ? "on" : ""}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(item)}
            >
              <span className="name">{item.skill ? item.skill.command : `/${item.id}`}</span>
              <span className="hint">{item.skill ? item.hint : t(item.hint)}</span>
            </button>
            </Fragment>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        className="in"
        rows={3}
        value={value}
        disabled={disabled}
        placeholder={t("composer.placeholder")}
        aria-controls={menuOpen ? "slash-commands" : undefined}
        aria-activedescendant={menuOpen ? `slash-${matches[highlighted]?.id}` : undefined}
        aria-label={t("composer.placeholder")}
        onChange={(e) => {
          const nextCursor = e.target.selectionStart;
          const prev = slashToken(value, cursor);
          const next = slashToken(e.target.value, nextCursor);
          setValue(e.target.value);
          setCursor(nextCursor);
          if (prev?.query !== next?.query) setActive(0);
          const nextKey = next ? `${next.start}:${next.query}` : "";
          if (closedFor && nextKey !== closedFor) setClosedFor(null);
          const prevAt = mentionToken(value, cursor);
          const nextAt = mentionToken(e.target.value, nextCursor);
          if (prevAt?.query !== nextAt?.query) setMentionActive(0);
          if (mentionClosedFor && (nextAt ? `${nextAt.start}:${nextAt.query}` : "") !== mentionClosedFor) setMentionClosedFor(null);
          syncChips(e.target.value);
        }}
        onSelect={(e) => setCursor(e.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        onCompositionStart={() => (composing.current = true)}
        onCompositionEnd={() => (composing.current = false)}
        onPaste={onPaste}
      />
      <MentionTray chips={chips} onRemove={removeMention} />
      <AttachmentTray items={tray.items} caps={tray.caps} notices={tray.notices} onRemove={tray.remove} onRetry={tray.retry} />
      {error && (
        <p className="error" role="alert">
          {t("composer.sendFailed", { message: error })}
        </p>
      )}
      {workspaceId !== undefined && (
        <AccountPicker
          scope="message"
          accounts={accountsState.accounts}
          value={accountId}
          onChange={setAccountId}
          supported={accountsState.supported}
          autoRouting={accountsState.autoRouting}
          threadId={threadId}
          disabled={disabled}
        />
      )}
      <div className="tb">
        <button type="button" className="fmt" style={{ fontWeight: 700 }} aria-label={t("composer.bold")} onClick={() => format("bold")}>
          B
        </button>
        <button type="button" className="fmt" style={{ fontStyle: "italic" }} aria-label={t("composer.italic")} onClick={() => format("italic")}>
          I
        </button>
        <button type="button" className="fmt" style={{ fontFamily: "var(--mono)" }} aria-label={t("composer.code")} onClick={() => format("code")}>
          {"</>"}
        </button>
        <button type="button" className="fmt" onClick={() => format("list")}>
          {t("composer.list")}
        </button>
        <button type="button" className="fmt" onClick={() => format("link")}>
          {t("composer.link")}
        </button>
        {tray.enabled && (
          <>
            <button type="button" className="fmt att-add" aria-label={t("attach.add")} disabled={disabled} onClick={() => picker.current?.click()}>
              {t("attach.button")}
            </button>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              aria-label={t("attach.choose")}
              onChange={(e) => {
                const files = Array.from(e.currentTarget.files ?? []);
                e.currentTarget.value = "";
                void tray.add(files);
              }}
            />
          </>
        )}
        <span className="sep">|</span>
        <span>{t("composer.hint")}</span>
        <button type="button" className="send" disabled={sending || disabled || tray.blocker !== null} onClick={() => void send()}>
          {t("composer.send")}
        </button>
      </div>
    </div>
  );
}
