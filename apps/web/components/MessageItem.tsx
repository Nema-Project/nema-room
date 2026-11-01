"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AttachmentList } from "@/components/AttachmentList";
import { Markdown } from "@/components/Markdown";
import { SkillOfferCard } from "@/components/SkillOfferCard";
import { editMessage, getEntry, HubError, listEntries, listMessageVersions, withdrawEntry } from "@/lib/hub";
import { formatTime } from "@/lib/format";
import { useLocale, useT } from "@/lib/i18n";
import { useHubEvents } from "@/lib/useHubEvents";
import type { AgentMessageMeta, Entry, Message, MessageQuote, ReportMessageMeta, RouteDecision } from "@/lib/types";

export function AgentAvatar() {
  return <div className="av ai">AI</div>;
}

type Props = {
  message: Message;
  /** Opens an entry in the knowledge column; a report's entry ids link to it. */
  onOpenEntry?: (entryId: string) => void;
  /** Sends a reply to one open follow-up. The question id is named in the chat message. */
  onAnswer?: (questionId: string, content: string) => Promise<void>;
  /** User messages after this one. A `回答 Q-n：` reply closes that question's box. */
  repliesAfter?: readonly string[];
  onQuote?: (message: Message) => void;
  /** Replaces the message in the chat after an edit succeeds. */
  onEdited?: (message: Message) => void;
  onJump?: (messageId: string) => void;
  onOpenHistory?: (entryId: string) => void;
};

export function messageRoleLabel(t: (key: string) => string, role: Message["role"]): string {
  if (role === "user") return t("chat.you");
  if (role === "system") return t("chat.role.system");
  if (role === "report") return t("chat.role.report");
  return "Nema";
}

function quoteOf(message: Message): MessageQuote | undefined {
  const meta = message.meta as { quote?: MessageQuote } | null;
  return meta?.quote;
}

export function MessageItem({ message, onOpenEntry, onQuote, onEdited, onJump, onOpenHistory }: Props) {
  const t = useT();
  const [locale] = useLocale();
  const time = formatTime(new Date(message.createdAt), locale);

  if (message.role === "system") {
    const meta = message.meta as AgentMessageMeta | null;
    return (
      <div className="sysmsg" id={`msg-${message.id}`}>
        <button type="button" className="quiet" onClick={() => onQuote?.(message)}>{t("chat.quote")}</button>
        {message.content}
        {meta?.askedQuestion && <AskedQuestion workspaceId={message.workspaceId} asked={meta.askedQuestion} added={[]} />}
      </div>
    );
  }

  if (message.role === "user") {
    return <UserMessage message={message} time={time} onQuote={onQuote} onEdited={onEdited} onJump={onJump} />;
  }

  if (message.role === "report") {
    return <ReportItem message={message} time={time} onOpenEntry={onOpenEntry} onQuote={onQuote} onJump={onJump} />;
  }

  const meta = message.meta as AgentMessageMeta | null;
  const quote = quoteOf(message);
  return (
    <div className="msg" id={`msg-${message.id}`}>
      <AgentAvatar />
      <div>
        <div className="who">
          Nema
          <time>{time}</time>
          <button type="button" className="quiet" onClick={() => onQuote?.(message)}>{t("chat.quote")}</button>
        </div>
        {quote && <QuoteBlock quote={quote} onJump={onJump} />}
        <Markdown source={message.content} />
        {meta && meta.changes.length > 0 && (
          <div className="changes">
            {meta.changes.map((c) => (
              <span className="chip" key={`${c.entryId}-${c.op}`}>
                <b>{c.entryId}</b>
                <button type="button" className="chip-link" onClick={() => onOpenEntry?.(c.entryId)}>{c.title}</button>
                <i>{`${t(`kind.${c.kind}`)} · ${t(c.kind === "source" && c.op === "add" ? "chip.register" : `chip.${c.op}`)}`}</i>
                {c.op === "add" && <WithdrawChip workspaceId={message.workspaceId} entryId={c.entryId} />}
                {c.op === "update" && <button type="button" onClick={() => onOpenHistory?.(c.entryId)}>{t("chip.history")}</button>}
              </span>
            ))}
          </div>
        )}
        {meta?.changes.filter((c) => c.kind === "workpackage").slice(0, 1).map((c) => (
          <WorkPackageCard key={c.entryId} workspaceId={message.workspaceId} entryId={c.entryId} onOpenEntry={onOpenEntry} />
        ))}
        {meta?.route && <RouteLine route={meta.route} />}
        {meta?.skillOffers?.map((offer) => <SkillOfferCard key={offer.id} offer={offer} />)}
        {meta && (meta.askedQuestion || meta.changes.some((c) => c.kind === "question" && c.op === "add")) && (
          <AskedQuestion workspaceId={message.workspaceId} asked={meta.askedQuestion} added={meta.changes.filter((c) => c.kind === "question" && c.op === "add").map((c) => ({ id: c.entryId, title: c.title }))} />
        )}
      </div>
    </div>
  );
}

/**
 * Which account and model answered, and why (spec 2026-10-31 §4.6, D-5). One small line under the reply,
 * opening into what was tried and what the provider reported. A message written before routing existed has no
 * `route` and renders exactly as it did — no empty line, no placeholder.
 */
export function RouteLine({ route }: { route: RouteDecision }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const reason = t(`route.reason.${route.reason}`);
  return (
    <div className="route" data-testid="route-line">
      <span>
        {t("route.lineWithReason", { account: route.accountName, model: route.model, reason })}
      </span>
      <button type="button" className="quiet" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {t("route.details")}
      </button>
      {open && (
        <div className="route-details" data-testid="route-details">
          <div data-testid="route-usage">
            {route.usage && (route.usage.inputTokens !== undefined || route.usage.outputTokens !== undefined)
              ? t("route.usage", {
                input: route.usage.inputTokens ?? "—",
                output: route.usage.outputTokens ?? "—",
              })
              : t("route.noUsage")}
          </div>
          {route.attempts && route.attempts.length > 0 && (
            <div data-testid="route-attempts">
              <b>{t("route.attempts")}</b>
              <ul>
                {route.attempts.map((a, i) => (
                  <li key={`${a.accountId}-${i}`}>
                    {a.accountName}
                    {a.model ? ` · ${a.model}` : ""} — {a.failure}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type QuestionSnap = { id: string; title: string; body: string };
const questionNumber = (id: string) => Number(id.slice(id.indexOf("-") + 1)) || 0;

/** A question added in this message is what the reply asked. An older askedQuestion is only the fallback. */
function AskedQuestion({ workspaceId, asked, added }: { workspaceId: string; asked: QuestionSnap | null; added: { id: string; title: string }[] }) {
  const t = useT();
  const addedKey = JSON.stringify(added);
  const preview: QuestionSnap | null = added[0] ? { id: added[0].id, title: added[0].title, body: "" } : asked;
  const [question, setQuestion] = useState<QuestionSnap | null>(preview);
  useEffect(() => {
    const parsed = JSON.parse(addedKey) as { id: string; title: string }[];
    const ids = parsed.length > 0 ? parsed.map((item) => item.id) : asked ? [asked.id] : [];
    if (ids.length === 0) return;
    let live = true;
    Promise.all(ids.map(async (id) => {
      try {
        return { id, entry: await getEntry(workspaceId, id), failed: false };
      } catch {
        return { id, entry: null, failed: true };
      }
    })).then((results) => {
      if (!live) return;
      const openQuestions = results.flatMap((result) => {
        const entry = result.entry;
        if (!entry || entry.kind !== "question" || entry.status !== "open") return [];
        const addedTitle = parsed.find((item) => item.id === result.id)?.title;
        const prior = asked?.id === result.id ? asked : null;
        return [{ id: result.id, title: entry.title || addedTitle || prior?.title || "", body: entry.body || prior?.body || "", priority: entry.priority }];
      });
      openQuestions.sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9) || questionNumber(a.id) - questionNumber(b.id));
      const picked = openQuestions[0];
      if (picked) {
        setQuestion({ id: picked.id, title: picked.title, body: picked.body });
        return;
      }
      const fallback = parsed[0];
      if (fallback) setQuestion({ id: fallback.id, title: fallback.title, body: "" });
      else if (asked) setQuestion(asked);
    });
    return () => { live = false; };
  }, [workspaceId, addedKey, asked]);
  if (!question) return null;
  return (
    <div className="ask">
      <div className="k">{t("chat.askedQuestion", { id: question.id })}</div>
      <div className="q">{question.title}</div>
      {question.body && <Markdown source={question.body} />}
    </div>
  );
}

function WithdrawChip({ workspaceId, entryId }: { workspaceId: string; entryId: string }) {
  const t = useT();
  const [dropped, setDropped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const requestVersion = useRef(0);
  const refresh = useCallback(async () => {
    const mine = ++requestVersion.current;
    try {
      const entry = await getEntry(workspaceId, entryId);
      if (mine === requestVersion.current) setDropped(entry.status === "dropped");
    } catch { /* keep the current chip state while the hub is unavailable */ }
  }, [workspaceId, entryId]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial status comes from an async hub request
    void refresh();
  }, [refresh]);
  useHubEvents(workspaceId, (event) => { if (event.type === "knowledge.changed" && event.entryId === entryId) void refresh(); });
  if (dropped) return null;
  return <>
    <button type="button" disabled={busy} onClick={() => { setBusy(true); setError(false); void withdrawEntry(workspaceId, entryId).then(() => { requestVersion.current++; setDropped(true); }).catch(() => setError(true)).finally(() => setBusy(false)); }}>{t("chip.withdraw")}</button>
    {error && <small className="error">{t("chip.withdrawFailed")}</small>}
  </>;
}

function QuoteBlock({ quote, onJump }: { quote: MessageQuote; onJump?: (messageId: string) => void }) {
  const t = useT();
  return (
    <button type="button" className="quote" onClick={() => onJump?.(quote.messageId)}>
      <b>{messageRoleLabel(t, quote.role)}:</b> {quote.excerpt}
    </button>
  );
}

/**
 * Deletion is final, so a response read before a delete committed (an edit racing it) must not bring
 * the attachment back: keep the newer tombstone for any attachment the latest message has deleted.
 */
function keepTombstones(next: Message, current: Message): Message {
  if (!next.attachments || !current.attachments) return next;
  const gone = new Map(current.attachments.filter((a) => a.status === "deleted").map((a) => [a.id, a]));
  if (gone.size === 0) return next;
  return { ...next, attachments: next.attachments.map((a) => (a.status !== "deleted" && gone.get(a.id)) || a) };
}

function UserMessage({
  message,
  time,
  onQuote,
  onEdited,
  onJump,
}: {
  message: Message;
  time: string;
  onQuote?: (message: Message) => void;
  onEdited?: (message: Message) => void;
  onJump?: (messageId: string) => void;
}) {
  const latest = useRef(message);
  useEffect(() => { latest.current = message; }, [message]);
  const t = useT();
  const [locale] = useLocale();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [editError, setEditError] = useState<string | null>(null);
  const [versions, setVersions] = useState<{ version: number; content: string; createdAt: string }[] | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const quote = quoteOf(message);
  const attachments = message.attachments ?? [];

  useEffect(() => {
    // Keep a cancelled edit draft aligned with a newer message object.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!editing) setDraft(message.content);
  }, [editing, message.content]);

  async function save() {
    setEditError(null);
    try {
      const { message: next } = await editMessage(message.workspaceId, message.id, draft);
      onEdited?.(keepTombstones(next, latest.current));
      setEditing(false);
      setVersions(null);
      setVersionsOpen(false);
    } catch (e) {
      setEditError(e instanceof HubError && e.status === 409 && e.message === "message is still being processed" ? t("chat.editBusy") : e instanceof Error ? e.message : String(e));
    }
  }

  async function toggleVersions() {
    if (!versions) setVersions(await listMessageVersions(message.workspaceId, message.id));
    setVersionsOpen((open) => !open);
  }

  return (
    <div className="msg" id={`msg-${message.id}`}>
      <div className="av me">{t("chat.you")}</div>
      <div>
        <div className="who">
          {t("chat.you")}
          <time>{time}</time>
          <button type="button" className="quiet" onClick={() => onQuote?.(message)}>{t("chat.quote")}</button>
          <button type="button" className="quiet" onClick={() => { setDraft(message.content); setEditing(true); setEditError(null); }}>{t("chat.edit")}</button>
          {message.editedAt && <button type="button" onClick={() => void toggleVersions()}>{t("chat.edited")}</button>}
        </div>
        {quote && <QuoteBlock quote={quote} onJump={onJump} />}
        {editing ? (
          <div className="editbox">
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} />
            <div className="actions">
              <button type="button" className="primary" onClick={() => void save()}>{t("chat.save")}</button>
              <button type="button" onClick={() => { setEditing(false); setDraft(message.content); setEditError(null); }}>{t("chat.cancel")}</button>
            </div>
            {editError && <p className="error" role="alert">{editError}</p>}
          </div>
        ) : message.content.trim() !== "" || attachments.length === 0 ? (
          <div className="memo">
            <Markdown source={message.content} />
          </div>
        ) : null}
        <AttachmentList
          workspaceId={message.workspaceId}
          attachments={attachments}
          canDelete
          onChange={(next) => {
            // Merge into the newest message: a delete can land after an edit or another delete.
            const cur = latest.current;
            const merged = { ...cur, attachments: (cur.attachments ?? []).map((x) => (x.id === next.id ? next : x)) };
            latest.current = merged;
            onEdited?.(merged);
          }}
        />
        {versionsOpen && versions && (
          <div className="versions">
            <div>{t("chat.versions")}</div>
            {versions.map((v) => (
              <div key={v.version}>
                <time>{formatTime(new Date(v.createdAt), locale)}</time>
                {v.content}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A coding agent's report in two blocks: what the agent claims, kept as sent, and what the hub checked itself
 * (git, commit authors, the GitHub read). Neither block is acceptance, and no line here says tests passed.
 */
function ReportItem({ message, time, onOpenEntry, onQuote, onJump }: { message: Message; time: string; onOpenEntry?: (entryId: string) => void; onQuote?: (message: Message) => void; onJump?: (messageId: string) => void }) {
  const t = useT();
  const meta = message.meta as ReportMessageMeta | null;
  const report = meta?.report;
  const missing = useMissingEntries(message.workspaceId, report?.entries ?? []);
  return (
    <div className="msg report" id={`msg-${message.id}`}>
      <div className="av rp" aria-hidden="true">CA</div>
      <div>
        <div className="who">
          <span className="rlabel">{t("report.label")}</span>
          <time>{time}</time>
          <button type="button" className="quiet" onClick={() => onQuote?.(message)}>{t("chat.quote")}</button>
        </div>
        {quoteOf(message) && <QuoteBlock quote={quoteOf(message)!} onJump={onJump} />}
        <div className="rbody">
          <Markdown source={message.content} />
          {report && report.entries.length > 0 && (
            <div className="rrow">
              {report.entries.filter((id) => !missing.has(id)).map((id) =>
                onOpenEntry ? (
                  <button key={id} type="button" className="rtag rlink" onClick={() => onOpenEntry(id)}>{id}</button>
                ) : (
                  <span key={id} className="rtag">{id}</span>
                ),
              )}
            </div>
          )}
          {[...missing].map((id) => <p key={id} className="rcheck-note">{t("report.entryMissing", { id })}</p>)}
          {report && <ReportClaim report={report} />}
          {meta && <ReportHubCheck meta={meta} />}
        </div>
      </div>
    </div>
  );
}

// One entry list request per workspace while it is in flight, shared by every report rendered at that moment.
const entryIdsInFlight = new Map<string, Promise<Set<string> | null>>();
function workspaceEntryIds(workspaceId: string): Promise<Set<string> | null> {
  let pending = entryIdsInFlight.get(workspaceId);
  if (!pending) {
    pending = Promise.resolve()
      .then(() => listEntries(workspaceId))
      .then((list) => new Set(list.map((e) => e.id)))
      .catch(() => null)
      .finally(() => entryIdsInFlight.delete(workspaceId));
    entryIdsInFlight.set(workspaceId, pending);
  }
  return pending;
}

/**
 * Entry ids the report names that this workspace does not have. Shown as a quiet note; nothing is created.
 * One list read serves every report on screen; a later knowledge change for a missing id reads again.
 */
function useMissingEntries(workspaceId: string, ids: string[]): Set<string> {
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [version, setVersion] = useState(0);
  const key = ids.join(",");
  useHubEvents(workspaceId, (event) => {
    if (event.type === "knowledge.changed" && missing.has(event.entryId)) setVersion((v) => v + 1);
  });
  useEffect(() => {
    if (!key) return;
    let live = true;
    void workspaceEntryIds(workspaceId).then((known) => {
      // A failed read leaves every id as a link rather than calling it missing.
      if (live && known) setMissing(new Set(key.split(",").filter((id) => !known.has(id))));
    });
    return () => {
      live = false;
    };
  }, [workspaceId, key, version]);
  return missing;
}

/** The agent's own account, as sent. Never relabelled as a hub check. */
function ReportClaim({ report }: { report: NonNullable<ReportMessageMeta["report"]> }) {
  const t = useT();
  return (
    <section className="rblock" data-testid="report-claim">
      <h4 className="rblock-title">{t("report.claim")}</h4>
      <p className="kmeta"><span className="ragent">{report.agent}</span> <span>{t("report.agentNote")}</span></p>
      {report.commits.length > 0 && (
        <div className="rrow">
          {report.commits.map((c) => <code key={c} className="rsha">{c.slice(0, 7)}</code>)}
        </div>
      )}
      {(report.branch || report.pr !== undefined || report.headSha) && (
        <div className="rrow">
          {report.branch && <span className="rtag">{t("report.claimBranch")}: {report.branch}</span>}
          {report.pr !== undefined && <span className="rtag">PR #{report.pr}</span>}
          {report.headSha && <span className="rtag">{t("report.claimHead")}: <code className="rsha">{report.headSha.slice(0, 12)}</code></span>}
        </div>
      )}
      {(report.verified ?? []).length > 0 && (
        <ul className="rclaims">{report.verified!.map((v) => <li key={v}>{t("report.claimVerified")}: {v}</li>)}</ul>
      )}
      {(report.notVerified ?? []).length > 0 && (
        <ul className="rclaims">{report.notVerified!.map((v) => <li key={v}>{t("report.claimNotVerified")}: {v}</li>)}</ul>
      )}
      {(report.ci ?? []).length > 0 && (
        <ul className="rclaims">
          {report.ci!.map((c, i) => <li key={`${c.name}-${i}`}>{t("report.claimCi")}: {c.name}{c.conclusion ? ` (${c.conclusion})` : ""}</li>)}
        </ul>
      )}
      {(report.blockers ?? []).length > 0 && (
        <ul className="rclaims">{report.blockers!.map((b) => <li key={b}>{t("report.claimBlockers")}: {b}</li>)}</ul>
      )}
    </section>
  );
}

const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required", "stale"]);

/** What the hub checked itself: the three git lines, commit authors and the GitHub read, each on its own. */
function ReportHubCheck({ meta }: { meta: ReportMessageMeta }) {
  const t = useT();
  const check = meta.check ?? null;
  return (
    <section className="rblock" data-testid="report-hub">
      <h4 className="rblock-title">{t("report.hubCheck")}</h4>
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
      ) : meta.checkError ? (
        <p className="rcheck-note">{t("report.checkFailed", { message: meta.checkError })}</p>
      ) : meta.checkSkipped === "in_progress_no_commits" ? (
        <p className="rcheck-note">{t("report.checkSkipped")}</p>
      ) : (
        <p className="rcheck-note">{t("report.checkPending")}</p>
      )}
      <div className="rsub">
        <h5 className="rsub-title">{t("report.authors")}</h5>
        {meta.authors ? (
          <>
            <ul className="rauthors">
              {meta.authors.commits.map((c) => (
                <li key={c.sha}>
                  <code className="rsha">{c.sha.slice(0, 7)}</code>
                  <span>{t("report.author")}: {c.authorName}</span> <span>{c.authorEmail}</span>
                  <span>{t("report.committer")}: {c.committerName}</span> <span>{c.committerEmail}</span>
                </li>
              ))}
            </ul>
            {meta.authors.missing.length > 0 && <p className="rcheck-note">{t("report.authorsMissing")}: {meta.authors.missing.map((c) => c.slice(0, 7)).join(", ")}</p>}
            <p className="kmeta">{t("report.authorsNote")}</p>
          </>
        ) : (
          <p className="rcheck-note">{t("report.noRecord")}</p>
        )}
      </div>
      <div className="rsub">
        {meta.github ? (
          <>
            <div data-testid="github-current"><GithubRead observation={meta.github.current} /></div>
            {meta.github.history.map((h, i) => (
              <div key={`${h.observedAt}-${i}`} className="rhistory">
                <span className="stag">{t("report.history")}</span>
                <GithubRead observation={h} />
              </div>
            ))}
          </>
        ) : (
          <>
            <h5 className="rsub-title">GitHub</h5>
            <p className="rcheck-note">{t("report.noRecord")}</p>
          </>
        )}
      </div>
    </section>
  );
}

/** One GitHub read. A read that failed shows only its reason; it never borrows an earlier read's runs. */
function GithubRead({ observation }: { observation: NonNullable<ReportMessageMeta["github"]>["current"] }) {
  const t = useT();
  const pr = observation.binding?.pr;
  return (
    <>
      <h5 className="rsub-title">{pr !== undefined ? t("report.github", { pr }) : "GitHub"}</h5>
      {observation.headMatch && <p className={observation.headMatch === "mismatch" ? "itag red" : "kmeta"}>{t(`report.githubHead.${observation.headMatch}`)}</p>}
      {observation.state === "not_requested" && <p className="rcheck-note">{t("report.githubNotRequested")}</p>}
      {observation.reasonCode && <p className="rcheck-note">{t("report.githubReason", { code: observation.reasonCode })}</p>}
      {observation.state === "read" && observation.checkRuns.length > 0 && (
        <div className="rrow">
          {observation.checkRuns.map((run, i) => (
            <span key={`${run.name}-${i}`} className={run.conclusion && FAILED_CONCLUSIONS.has(run.conclusion) ? "itag red" : "itag"}>
              {run.name}: {run.conclusion ?? run.status}
            </span>
          ))}
        </div>
      )}
      {observation.truncated && <p className="rcheck-note">{t("report.githubTruncated")}</p>}
      <p className="kmeta">
        {observation.state !== "read" ? t("report.checkRunsNone") : observation.checkRuns.length > 0 ? t("report.checkRunsRead") : t("report.checkRunsEmpty")}
      </p>
    </>
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
