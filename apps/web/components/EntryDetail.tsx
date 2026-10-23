"use client";

import { KIND_STATUSES, isStale } from "@nema/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { HistoryTab } from "@/components/HistoryTab";
import { ImplTag, groupOf } from "@/components/KnowledgePanel";
import { Markdown } from "@/components/Markdown";
import { WhyTab } from "@/components/WhyTab";
import { WorkPackageDetail } from "@/components/WorkPackageDetail";
import { formatDay, formatTime } from "@/lib/format";
import { confirmEntry, confirmImplementation, diagramHtmlUrl, getEntry, getHistory, getWhy, listEntries, listMessages, listRepos, putEntry, requestWorkPackage, updateDiagram } from "@/lib/hub";
import { useLocale, useT } from "@/lib/i18n";
import type { Entry, EntryListItem, HistoryItem, Message, ParagraphBlame, Repo } from "@/lib/types";

type Tab = "content" | "history" | "why";
type Props = {
  workspaceId: string;
  entryId: string;
  onClose: () => void;
  onJumpToMessage: (messageId: string) => void;
  /** Bumped by the shell when this entry changed elsewhere. */
  refreshKey?: number;
  /** Opens another entry in the knowledge column (work package requirement links and markers). */
  onOpenEntry?: (entryId: string) => void;
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Work packages (`W-n`) have their own detail with tabs for spec and plan; every other entry uses the common one. */
export function EntryDetail(props: Props) {
  if (props.entryId.startsWith("W-")) return <WorkPackageDetail {...props} />;
  return <PlainEntryDetail {...props} />;
}

function PlainEntryDetail({ workspaceId, entryId, onClose, onJumpToMessage, refreshKey = 0 }: Props) {
  const t = useT();
  const [locale] = useLocale();
  const [entry, setEntry] = useState<Entry | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [why, setWhy] = useState<ParagraphBlame[]>([]);
  const [messages, setMessages] = useState<Map<string, Message>>(new Map());
  const [statuses, setStatuses] = useState<Map<string, EntryListItem["status"]>>(new Map());
  const [tab, setTab] = useState<Tab>("content");
  const [picked, setPicked] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const seq = useRef(0);
  const editingRef = useRef(false);
  editingRef.current = editing;

  const load = useCallback(async () => {
    const mine = ++seq.current; // only the latest request may write state
    try {
      const [e, h, w] = await Promise.all([getEntry(workspaceId, entryId), getHistory(workspaceId, entryId), getWhy(workspaceId, entryId)]);
      if (mine !== seq.current) return;
      setEntry(e);
      setHistory(h);
      setWhy(w);
      setError(null);
    } catch (err) {
      if (mine === seq.current) setError(errMsg(err));
    }
    // Context for source text and resolved-question styling; the detail still works without it.
    void listMessages(workspaceId).then((l) => setMessages(new Map(l.map((m) => [m.id, m]))), () => {});
    void listEntries(workspaceId).then((l) => setStatuses(new Map(l.map((x) => [x.id, x.status]))), () => {});
  }, [workspaceId, entryId]);

  // A diagram names its repo by id; the label is looked up for display.
  const [repos, setRepos] = useState<Repo[]>([]);
  const isDiagram = entry?.kind === "diagram";
  useEffect(() => {
    if (!isDiagram) return;
    let live = true;
    listRepos(workspaceId).then((r) => live && setRepos(r), () => {});
    return () => {
      live = false;
    };
  }, [workspaceId, isDiagram]);

  const firstRun = useRef(true);
  useEffect(() => {
    // A change event while the form is open must not reset the typed values; flag it instead.
    if (!firstRun.current && editingRef.current) setStale(true);
    firstRun.current = false;
    void load();
  }, [load, refreshKey]);

  if (error && !entry) {
    return (
      <div className="detail">
        <div className="detail-head"><button type="button" className="x" aria-label={t("common.close")} onClick={onClose}>✕</button></div>
        <p className="error" role="alert">{t("detail.loadFailed", { message: error })}</p>
      </div>
    );
  }
  if (!entry) return <div className="detail"><p className="placeholder">{t("common.loading")}</p></div>;

  const last = history[0];
  const lastAt = last ? new Date(last.committedAt) : null;
  const stamp = (iso: string | null) => {
    if (!iso) return t("detail.noValue");
    const at = new Date(iso);
    return `${formatDay(at, locale)} ${formatTime(at, locale)}`;
  };
  async function confirm() {
    if (confirming) return;
    setConfirming(true);
    try {
      await confirmEntry(workspaceId, entryId);
      await load();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setConfirming(false);
    }
  }
  return (
    <div className="detail">
      <div className="detail-head">
        <div className="crumb">
          <span>{t("know.title")}</span> / <span>{t(`group.${groupOf(entry.kind)}`)}</span> / <span>{entry.id}</span>
          <button type="button" className="x" aria-label={t("common.close")} onClick={onClose}>✕</button>
        </div>
        <div className="detail-id">
          <span className={entry.kind === "question" ? "kid red" : "kid"}>{entry.id}</span>
          <span className="stag">{t(`status.${entry.status}`)}</span>
        </div>
        <h2 className="detail-title">{entry.title}</h2>
        <div className="tabs" role="tablist">
          {(["content", "history", "why"] as const).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
              {k === "history" ? t("detail.tab.history", { n: history.length }) : t(`detail.tab.${k}`)}
            </button>
          ))}
          {/* A diagram is redrawn by the Agent (the update button), not edited by hand. */}
          {!editing && entry.kind !== "diagram" && <button type="button" className="sp editbtn" onClick={() => { setEditing(true); setTab("content"); }}>{t("detail.edit")}</button>}
        </div>
      </div>
      <div className="detail-body">
        {error && <p className="error" role="alert">{t("detail.loadFailed", { message: error })}</p>}
        {editing && stale && tab === "content" && (
          <p className="notice" role="status">
            {t("edit.staleNotice")}{" "}
            <button type="button" className="link" onClick={() => { setFormKey((k) => k + 1); setStale(false); }}>{t("edit.reload")}</button>
          </p>
        )}
        {/* The form stays mounted (hidden) on the other tabs so an unsaved draft survives tab switches. */}
        {editing && (
          <div hidden={tab !== "content"}>
            <EditForm
              key={formKey}
              entry={entry}
              onCancel={() => { setEditing(false); setStale(false); }}
              onSaved={async () => {
                setEditing(false);
                setStale(false);
                setTab("content");
                await load();
              }}
              workspaceId={workspaceId}
            />
          </div>
        )}
        {tab === "content" ? (editing ? null : entry.diagram ? (
          <DiagramContent workspaceId={workspaceId} entry={entry} diagram={entry.diagram} repos={repos} />
        ) : (
          <>
            <dl className="defs">
              <dt>{t("detail.date")}</dt>
              <dd>{entry.businessDate ? formatDay(new Date(`${entry.businessDate}T00:00:00`), locale) : t("detail.noValue")}</dd>
              <dt>{t("detail.lastModified")}</dt>
              <dd>{last && lastAt ? `${formatDay(lastAt, locale)} ${formatTime(lastAt, locale)} · ${t(`author.${last.author}`)}` : t("detail.noValue")}</dd>
              <dt>{t("detail.related")}</dt>
              <dd>
                {entry.related.length === 0
                  ? t("detail.noValue")
                  : entry.related.map((id) => (
                      <span key={id} className="rtag" style={statuses.get(id) === "resolved" ? { textDecoration: "line-through" } : undefined}>{id}</span>
                    ))}
              </dd>
              <dt>{t("detail.basis")}</dt>
              <dd>{entry.basis ? t(`basis.${entry.basis}`) : t("detail.noValue")}</dd>
              <dt>{t("detail.ingestedAt")}</dt>
              <dd>{stamp(entry.ingestedAt)}</dd>
              <dt>{t("detail.confirmedAt")}</dt>
              <dd>{stamp(entry.confirmedAt)}</dd>
            </dl>
            {(entry.basis === "inferred" || isStale(entry, new Date())) && (
              <button type="button" className="editbtn" disabled={confirming} onClick={() => confirm()}>{t("detail.confirm")}</button>
            )}
            {entry.kind === "requirement" && entry.status === "active" && <GenerateWorkPackage workspaceId={workspaceId} entryId={entry.id} />}
            {entry.kind === "requirement" && entry.implementation && (
              <ImplementationBox
                workspaceId={workspaceId}
                entryId={entry.id}
                implementation={entry.implementation}
                onJumpToMessage={onJumpToMessage}
                onConfirmed={load}
              />
            )}
            <Markdown source={entry.body} />
            {entry.sourceMessages.length > 0 && (
              <div className="srcs">
                <h3>{t("detail.sources")}</h3>
                {entry.sourceMessages.map((id) => {
                  const m = messages.get(id);
                  const at = m ? new Date(m.createdAt) : null;
                  return (
                    <button key={id} type="button" className="srcitem" data-testid="source-item" title={t("detail.sourceJump")} onClick={() => onJumpToMessage(id)}>
                      {at && <span className="srctime">{`${formatDay(at, locale)} ${formatTime(at, locale)}`}</span>}
                      <span>{m ? Array.from(m.content).slice(0, 30).join("") : id}</span>
                    </button>
                  );
                })}
              </div>
            )}
            {entry.quotes.length > 0 && (
              <div className="srcs">
                <h3>{t("detail.quotes")}</h3>
                {entry.quotes.map((q) => (
                  <blockquote key={`${q.messageId}:${q.text}`}>
                    <button type="button" className="srcitem" title={t("detail.sourceJump")} onClick={() => onJumpToMessage(q.messageId)}>
                      {q.text}
                    </button>
                  </blockquote>
                ))}
              </div>
            )}
          </>
        )) : tab === "history" ? (
          <HistoryTab key={picked ?? "none"} workspaceId={workspaceId} entryId={entryId} history={history} current={entry} initialVersion={picked} />
        ) : (
          <WhyTab
            blame={why}
            onSelectVersion={(v) => {
              setPicked(v);
              setTab("history");
              const src = history.find((h) => h.version === v)?.sourceMessages[0];
              if (src) onJumpToMessage(src);
            }}
          />
        )}
      </div>
    </div>
  );
}

/** Asks the hub for a work package that covers this one requirement. A hub refusal (no repo, superpowers off) shows inline. */
function GenerateWorkPackage({ workspaceId, entryId }: { workspaceId: string; entryId: string }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [requested, setRequested] = useState<string | null>(null);
  async function generate() {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    setRequested(null);
    try {
      const wp = await requestWorkPackage(workspaceId, [entryId]);
      setRequested(wp.id);
    } catch (e) {
      setFailure(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="actions">
      <button type="button" className="editbtn" disabled={busy} onClick={() => void generate()}>{t("wp.generate")}</button>
      {requested && <span className="notice" role="status">{t("wp.requested", { id: requested })}</span>}
      {failure && <p className="error" role="alert">{failure}</p>}
    </div>
  );
}

/** Status, evidence and, while it is not verified, the user's own confirm. Only this confirm or a passing report reaches verified. */
function ImplementationBox({ workspaceId, entryId, implementation, onJumpToMessage, onConfirmed }: {
  workspaceId: string;
  entryId: string;
  implementation: NonNullable<Entry["implementation"]>;
  onJumpToMessage: (messageId: string) => void;
  onConfirmed: () => Promise<void>;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const { status, evidence } = implementation;
  async function confirmImpl() {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await confirmImplementation(workspaceId, entryId);
      await onConfirmed();
    } catch (e) {
      setFailure(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="impl" aria-label={t("impl.title")}>
      <dl className="defs">
        <dt>{t("impl.title")}</dt>
        <dd><ImplTag implementation={implementation} /></dd>
        <dt>{t("impl.evidence")}</dt>
        <dd>
          {evidence.reportMessageId && (
            <button type="button" className="link" onClick={() => onJumpToMessage(evidence.reportMessageId!)}>{t("impl.reportLink")}</button>
          )}
          {evidence.commits.length > 0 && (
            <div className="rrow">{evidence.commits.map((c) => <code key={c} className="rsha">{c.slice(0, 7)}</code>)}</div>
          )}
          {evidence.note && <div>{evidence.note}</div>}
          {evidence.confirmedBy === "user" && <div>{t("impl.confirmedByUser")}</div>}
          {!evidence.reportMessageId && evidence.commits.length === 0 && !evidence.note && evidence.confirmedBy !== "user" && t("detail.noValue")}
        </dd>
      </dl>
      {(status === "reported" || status === "mismatch") && (
        <div className="actions">
          <button type="button" className="editbtn" disabled={busy} onClick={() => void confirmImpl()}>{t("impl.confirm")}</button>
        </div>
      )}
      {failure && <p className="error" role="alert">{failure}</p>}
    </section>
  );
}

function DiagramContent({ workspaceId, entry, diagram, repos }: { workspaceId: string; entry: Entry; diagram: NonNullable<Entry["diagram"]>; repos: Repo[] }) {
  const t = useT();
  const [state, setState] = useState<"idle" | "busy" | "queued">("idle");
  const [failure, setFailure] = useState<string | null>(null);
  const sha = diagram.sourceCommits[diagram.repoId] ?? Object.values(diagram.sourceCommits)[0];
  const repo = repos.find((r) => r.id === diagram.repoId);
  async function update() {
    if (state === "busy") return;
    setState("busy");
    setFailure(null);
    try {
      await updateDiagram(workspaceId, entry.id);
      setState("queued");
    } catch (e) {
      setFailure(errMsg(e));
      setState("idle");
    }
  }
  return (
    <>
      <dl className="defs">
        <dt>{t("diagram.type")}</dt>
        <dd>{diagram.type}</dd>
        <dt>{t("diagram.repo")}</dt>
        <dd>{repo?.label ?? diagram.repoId}</dd>
        <dt>{t("diagram.sourceCommit")}</dt>
        <dd className="mono">{sha ? sha.slice(0, 7) : t("detail.noValue")}</dd>
        <dt>{t("diagram.nodes")}</dt>
        <dd>{Object.keys(diagram.nodePaths).length}</dd>
      </dl>
      <div className="diagram-actions">
        <button type="button" className="primary" onClick={() => window.open(diagramHtmlUrl(workspaceId, entry.id), "_blank", "noopener")}>
          {t("diagram.open")}
        </button>
        <button type="button" className="editbtn" disabled={state !== "idle"} onClick={() => void update()}>{t("diagram.update")}</button>
        {state === "queued" && <span className="notice" role="status">{t("diagram.updateQueued")}</span>}
      </div>
      {failure && <p className="error" role="alert">{t("diagram.updateFailed", { message: failure })}</p>}
      <Markdown source={entry.body} />
    </>
  );
}

function EditForm({ entry, workspaceId, onCancel, onSaved }: { entry: Entry; workspaceId: string; onCancel: () => void; onSaved: () => Promise<void> }) {
  const t = useT();
  const [title, setTitle] = useState(entry.title);
  const [body, setBody] = useState(entry.body);
  const [status, setStatus] = useState<string>(entry.status);
  const [date, setDate] = useState(entry.businessDate ?? "");
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!reason.trim()) {
      setFormError(t("edit.reasonRequired"));
      return;
    }
    setBusy(true);
    try {
      await putEntry(workspaceId, entry.id, {
        kind: entry.kind,
        title,
        body,
        status: status as Entry["status"],
        businessDate: date || null,
        related: entry.related,
        sourceMessages: entry.sourceMessages,
        ...(entry.url !== undefined ? { url: entry.url } : {}),
        ...(entry.priority !== undefined ? { priority: entry.priority } : {}),
        reason: reason.trim(),
      });
      await onSaved();
    } catch (e) {
      setFormError(t("edit.saveFailed", { message: errMsg(e) }));
      setBusy(false);
    }
  }

  return (
    <form className="editform" onSubmit={(ev) => { ev.preventDefault(); void save(); }}>
      <label>
        <span>{t("edit.title")}</span>
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        <span>{t("edit.body")}</span>
        <textarea className="mono" rows={10} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <label>
        <span>{t("edit.status")}</span>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {KIND_STATUSES[entry.kind].map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
        </select>
      </label>
      <label>
        <span>{t("edit.date")}</span>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      <label>
        <span>{t("edit.reason")}</span>
        <input type="text" value={reason} maxLength={500} onChange={(e) => { setReason(e.target.value); setFormError(null); }} />
      </label>
      {formError && <p className="error" role="alert">{formError}</p>}
      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>{t("edit.save")}</button>
        <button type="button" onClick={onCancel}>{t("edit.cancel")}</button>
      </div>
    </form>
  );
}
