"use client";

import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { messageRoleLabel } from "@/components/MessageItem";
import { applyFormat, type FormatKind } from "@/lib/markdownFormat";
import { useT } from "@/lib/i18n";
import type { Message } from "@/lib/types";

function excerpt(content: string): string {
  const chars = Array.from(content);
  return chars.length <= 200 ? content : chars.slice(0, 200).join("");
}

export function Composer({
  onSend,
  quote,
  onClearQuote,
}: {
  onSend: (content: string) => Promise<void>;
  quote?: { role: Message["role"]; content: string } | null;
  onClearQuote?: () => void;
}) {
  const t = useT();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const composing = useRef(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const pendingSel = useRef<[number, number] | null>(null);

  useLayoutEffect(() => {
    if (pendingSel.current && ref.current) {
      ref.current.focus();
      ref.current.setSelectionRange(...pendingSel.current);
      pendingSel.current = null;
    }
  });

  async function send() {
    const sent = value;
    const content = sent.trim();
    if (!content || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSend(content);
      // Text typed while the send was in flight stays: drop only what was sent.
      setValue((cur) => (cur === sent ? "" : cur.startsWith(sent) ? cur.slice(sent.length).trimStart() : cur));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e)); // keep the draft
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      void send();
    }
    // Plain Enter keeps the textarea default: a newline.
  }

  function format(kind: FormatKind) {
    const el = ref.current;
    if (!el) return;
    const r = applyFormat(value, el.selectionStart, el.selectionEnd, kind);
    pendingSel.current = [r.selStart, r.selEnd];
    setValue(r.text);
  }

  return (
    <div className="composer">
      {quote && (
        <div className="quote-bar">
          <span>
            <b>{messageRoleLabel(t, quote.role)}</b> {excerpt(quote.content)}
          </span>
          <button type="button" onClick={onClearQuote}>{t("chat.quoteRemove")}</button>
        </div>
      )}
      <textarea
        ref={ref}
        className="in"
        rows={3}
        value={value}
        placeholder={t("composer.placeholder")}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        onCompositionStart={() => (composing.current = true)}
        onCompositionEnd={() => (composing.current = false)}
      />
      {error && (
        <p className="error" role="alert">
          {t("composer.sendFailed", { message: error })}
        </p>
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
        <span className="sep">|</span>
        <span>{t("composer.hint")}</span>
        <button type="button" className="send" disabled={sending} onClick={() => void send()}>
          {t("composer.send")}
        </button>
      </div>
    </div>
  );
}
