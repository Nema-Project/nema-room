"use client";

import { useEffect, useState } from "react";
import { Markdown } from "@/components/Markdown";
import { getEntry } from "@/lib/hub";
import { formatTime } from "@/lib/format";
import { useLocale, useT } from "@/lib/i18n";
import type { AgentMessageMeta, Entry, Message, ReportMessageMeta } from "@/lib/types";

export function AgentAvatar() {
  return <div className="av ai">AI</div>;
}

type Props = {
  message: Message;
  /** Opens an entry in the knowledge column; a report's entry ids link to it. */
  onOpenEntry?: (entryId: string) => void;
  /** Present only on the latest follow-up that has no user message after it. */
  onAnswer?: (content: string) => Promise<void>;
};

export function MessageItem({ message, onOpenEntry, onAnswer }: Props) {
  const t = useT();
  const [locale] = useLocale();
  const time = formatTime(new Date(message.createdAt), locale);

  if (message.role === "system") {
    return (
      <div className="sysmsg" id={`msg-${message.id}`}>
        {message.content}
      </div>
    );
  }

  if (message.role === "user") {
    return (
      <div className="msg" id={`msg-${message.id}`}>
        <div className="av me">{t("chat.you")}</div>
        <div>
          <div className="who">
            {t("chat.you")}
            <time>{time}</time>
          </div>
          <div className="memo">
            <Markdown source={message.content} />
          </div>
        </div>
      </div>
    );
  }

  if (message.role === "report") {
    return <ReportItem message={message} time={time} onOpenEntry={onOpenEntry} />;
  }

  const meta = message.meta as AgentMessageMeta | null;
  return (
    <div className="msg" id={`msg-${message.id}`}>
      <AgentAvatar />
      <div>
        <div className="who">
          Nema
          <time>{time}</time>
        </div>
        <Markdown source={message.content} />
        {meta && meta.changes.length > 0 && (
          <div className="changes">
            {meta.changes.map((c) => (
              <span className="chip" key={`${c.entryId}-${c.op}`}>
                <b>{c.entryId}</b>
                {c.title}
                <i>{`${t(`kind.${c.kind}`)} · ${t(c.kind === "source" && c.op === "add" ? "chip.register" : `chip.${c.op}`)}`}</i>
              </span>
            ))}
          </div>
        )}
        {meta?.changes.filter((c) => c.kind === "workpackage").slice(0, 1).map((c) => (
          <WorkPackageCard key={c.entryId} workspaceId={message.workspaceId} entryId={c.entryId} onOpenEntry={onOpenEntry} />
        ))}
        {meta?.askedQuestion && (
          <div className="ask">
            <div className="k">{t("chat.askedQuestion", { id: meta.askedQuestion.id })}</div>
            <div className="q">{meta.askedQuestion.title}</div>
            <Markdown source={meta.askedQuestion.body} />
            {onAnswer && <AnswerBox onAnswer={onAnswer} />}
          </div>
        )}
      </div>
    </div>
  );
}

/** Sends the reply as a normal chat message. The hub treats the next user message as the answer to this question. */
function AnswerBox({ onAnswer }: { onAnswer: (content: string) => Promise<void> }) {
  const t = useT();
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    const content = value.trim();
    if (!content || sending) return;
    setSending(true);
    setError(null);
    try {
      await onAnswer(content);
      setValue("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <form className="ask-answer" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <textarea
        aria-label={t("chat.answer")}
        rows={2}
        value={value}
        placeholder={t("chat.answerPlaceholder")}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.key === "Process" || e.keyCode === 229) return;
          if (e.key === "Enter" && e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <button type="submit" disabled={sending || value.trim() === ""}>{t("chat.answer")}</button>
      {error && <p className="error" role="alert">{t("composer.sendFailed", { message: error })}</p>}
    </form>
  );
}

/** A coding agent's report: the agent's summary, then its entries, commits and the daemon's git check. */
function ReportItem({ message, time, onOpenEntry }: { message: Message; time: string; onOpenEntry?: (entryId: string) => void }) {
  const t = useT();
  const meta = message.meta as ReportMessageMeta | null;
  const report = meta?.report;
  const check = meta?.check ?? null;
  return (
    <div className="msg report" id={`msg-${message.id}`}>
      <div className="av rp" aria-hidden="true">CA</div>
      <div>
        <div className="who">
          <span className="rlabel">{t("report.label")}</span>
          {report && <span className="ragent">{report.agent}</span>}
          <time>{time}</time>
        </div>
        <div className="rbody">
          <Markdown source={message.content} />
          {report && report.entries.length > 0 && (
            <div className="rrow">
              {report.entries.map((id) =>
                onOpenEntry ? (
                  <button key={id} type="button" className="rtag rlink" onClick={() => onOpenEntry(id)}>{id}</button>
                ) : (
                  <span key={id} className="rtag">{id}</span>
                ),
              )}
            </div>
          )}
          {report && (
            <div className="rrow">
              {report.commits.map((c) => <code key={c} className="rsha">{c.slice(0, 7)}</code>)}
            </div>
          )}
          {check ? (
            <ul className="rcheck">
              <li className={check.commitsExist ? "ok" : "bad"}>
                {t("report.commitsExist")}
                {!check.commitsExist && check.missingCommits.length > 0 && <span className="rfiles">{check.missingCommits.map((c) => c.slice(0, 7)).join(", ")}</span>}
              </li>
              <li className={check.onMain === "yes" ? "ok" : "wait"}>{t(check.onMain === "yes" ? "report.onMain" : "report.notYet")}</li>
              <li className={check.filesOk ? "ok" : "bad"}>
                {check.filesOk ? t("report.filesOk") : `${t("report.untouched")}: ${check.untouchedFiles.join(", ")}`}
              </li>
            </ul>
          ) : meta?.checkError ? (
            <p className="rcheck-note">{t("report.checkFailed", { message: meta.checkError })}</p>
          ) : (
            <p className="rcheck-note">{t("report.checkPending")}</p>
          )}
        </div>
      </div>
    </div>
  );
}

/** The result of a work package task: id, status and task count, or the question it is waiting on. */
function WorkPackageCard({ workspaceId, entryId, onOpenEntry }: { workspaceId: string; entryId: string; onOpenEntry?: (entryId: string) => void }) {
  const t = useT();
  const [entry, setEntry] = useState<Entry | null>(null);
  useEffect(() => {
    let live = true;
    getEntry(workspaceId, entryId).then((e) => live && setEntry(e), () => {});
    return () => {
      live = false;
    };
  }, [workspaceId, entryId]);
  const meta = entry?.workpackage;
  if (!entry || !meta) return null;
  return (
    <div className="wpcard" data-testid="wp-card">
      {onOpenEntry ? (
        <button type="button" className="kid kid-btn" onClick={() => onOpenEntry(entry.id)}>{entry.id}</button>
      ) : (
        <span className="kid">{entry.id}</span>
      )}
      <span className="stag">{t(`wp.status.${entry.status}`)}</span>
      {meta.blockedOn ? (
        <button type="button" className="itag red rlink" onClick={() => onOpenEntry?.(meta.blockedOn!)}>{t("wp.cardBlocked", { id: meta.blockedOn })}</button>
      ) : (
        <span className="kmeta">{t("wp.card", { n: meta.tasks.length })}</span>
      )}
    </div>
  );
}
