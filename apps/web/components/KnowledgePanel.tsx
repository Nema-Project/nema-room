"use client";

import { INACTIVE_STATUSES, isStale } from "@nema/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatDay } from "@/lib/format";
import { diagramHtmlUrl, getTimeline, listEntries, listRepos, requestWorkPackage } from "@/lib/hub";
import { useLocale, useT } from "@/lib/i18n";
import type { EntryListItem, EntrySummary, Implementation, KnowledgeLanguage, Repo } from "@/lib/types";

type Row = EntrySummary & { isNew?: boolean };
type Group = "pending" | "workpackage" | "requirement" | "decision" | "tradeoff" | "diagram" | "source";

/** 开发包 sits between 待确认 and 当前需求 and, like 代码图, is shown only once there is one. 代码图 sits after 取舍记录 and before 外部来源; it is only shown once there is a diagram. */
export const GROUPS: readonly Group[] = ["pending", "workpackage", "requirement", "decision", "tradeoff", "diagram", "source"];
export const groupOf = (kind: EntrySummary["kind"]): Group => (kind === "question" ? "pending" : kind);

const inactive = (status: string) => (INACTIVE_STATUSES as readonly string[]).includes(status);
const num = (id: string) => Number(id.slice(id.indexOf("-") + 1));
const domain = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** A requirement's implementation status. Work inferred from code reads differently from a coding agent's report. */
export function ImplTag({ implementation }: { implementation: Implementation }) {
  const t = useT();
  const { status, evidence } = implementation;
  const inferred = status === "reported" && evidence.inferred;
  const cls = status === "mismatch" ? "itag red" : inferred ? "itag inferred" : status === "verified" ? "itag verified" : "itag";
  return <span className={cls} data-testid="impl-tag">{t(inferred ? "impl.reportedInferred" : `impl.${status}`)}</span>;
}

type Props = {
  workspaceId: string;
  knowledgeLanguage: KnowledgeLanguage;
  onOpen: (entryId: string) => void;
  /** Bumped by the shell on knowledge.changed / SSE resync to refetch. */
  refreshKey?: number;
};

export function KnowledgePanel({ workspaceId, knowledgeLanguage, onOpen, refreshKey = 0 }: Props) {
  const t = useT();
  const [view, setView] = useState<"kind" | "time">("kind");
  const [entries, setEntries] = useState<EntryListItem[] | null>(null);
  const [timeline, setTimeline] = useState<EntrySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current; // only the latest request may write state
    try {
      const data = view === "kind" ? await listEntries(workspaceId) : await getTimeline(workspaceId);
      if (mine !== seq.current) return;
      if (view === "kind") setEntries(data as EntryListItem[]);
      else setTimeline(data);
      setError(null);
    } catch (e) {
      if (mine === seq.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [workspaceId, view]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount and refresh: state is set once the request resolves
    void load();
  }, [load, refreshKey]);

  // Repo labels for the 代码图 group, fetched only once there is a diagram; without them a diagram falls back to its repo id.
  const hasDiagrams = !!entries?.some((x) => x.kind === "diagram");
  useEffect(() => {
    if (!hasDiagrams) return;
    let live = true;
    listRepos(workspaceId).then((r) => live && setRepos(r), () => {});
    return () => {
      live = false;
    };
  }, [workspaceId, refreshKey, hasDiagrams]);

  const openDiagram = useCallback((gid: string) => {
    window.open(diagramHtmlUrl(workspaceId, gid), "_blank", "noopener");
  }, [workspaceId]);

  return (
    <div className="kp" lang={knowledgeLanguage === "follow" ? undefined : knowledgeLanguage}>
      <div className="bar kp-bar">
        <h2>{t("know.title")}</h2>
        <div className="seg sp" role="group">
          <button type="button" className={view === "kind" ? "on" : ""} aria-pressed={view === "kind"} onClick={() => setView("kind")}>
            {t("know.byKind")}
          </button>
          <button type="button" className={view === "time" ? "on" : ""} aria-pressed={view === "time"} onClick={() => setView("time")}>
            {t("know.timeline")}
          </button>
        </div>
      </div>
      <div className="kp-body">
        {error && <p className="error" role="alert">{t("know.loadFailed", { message: error })}</p>}
        {view === "kind" ? (
          <ByKind workspaceId={workspaceId} entries={entries} repos={repos} onOpen={onOpen} onOpenDiagram={openDiagram} />
        ) : (
          <ByTime entries={timeline} onOpen={onOpen} />
        )}
      </div>
    </div>
  );
}

type ByKindProps = { workspaceId: string; entries: EntryListItem[] | null; repos: Repo[]; onOpen: (id: string) => void; onOpenDiagram: (id: string) => void };

function ByKind({ workspaceId, entries, repos, onOpen, onOpenDiagram }: ByKindProps) {
  const t = useT();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [selecting, setSelecting] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [requested, setRequested] = useState<string | null>(null);
  const toggle = (id: string) =>
    setChecked((c) => {
      const next = new Set(c);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  async function generateSelected() {
    if (busy || checked.size === 0) return;
    setBusy(true);
    setFailure(null);
    setRequested(null);
    try {
      const wp = await requestWorkPackage(workspaceId, [...checked].sort((a, b) => num(a) - num(b)));
      setRequested(wp.id);
      setChecked(new Set());
      setSelecting(false);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  if (!entries) return <p className="placeholder">{t("common.loading")}</p>;
  if (entries.length === 0) return <p className="placeholder">{t("know.empty")}</p>;
  return (
    <>
      {GROUPS.map((g) => {
        const all = entries.filter((x) => groupOf(x.kind) === g);
        const cmp = g === "pending" ? (a: Row, b: Row) => (a.priority ?? 9) - (b.priority ?? 9) || num(a.id) - num(b.id) : (a: Row, b: Row) => num(a.id) - num(b.id);
        const live = all.filter((x) => !inactive(x.status)).sort(cmp);
        const dead = all.filter((x) => inactive(x.status)).sort(cmp);
        if (g === "workpackage" && all.length === 0) return null;
        if (g === "diagram") {
          if (all.length === 0) return null;
          return <DiagramGroup key={g} live={live} dead={dead} repos={repos} onOpen={onOpen} onOpenDiagram={onOpenDiagram} />;
        }
        return (
          <section key={g} className="kgroup">
            <h3>
              <span>{g === "workpackage" ? t("know.workpackages") : t(`group.${g}`)}</span>
              <span className={g === "pending" ? "n red" : "n"}>{live.length}</span>
            </h3>
            {g === "requirement" && (
              <div className="actions">
                <button type="button" className="link" aria-pressed={selecting} onClick={() => { setSelecting((v) => !v); setChecked(new Set()); }}>
                  {t("wp.select")}
                </button>
                {selecting && (
                  <button type="button" className="primary" disabled={busy || checked.size === 0} onClick={() => void generateSelected()}>{t("wp.generateSelected")}</button>
                )}
              </div>
            )}
            {g === "requirement" && requested && <p className="notice" role="status">{t("wp.requested", { id: requested })}</p>}
            {g === "requirement" && failure && <p className="error" role="alert">{failure}</p>}
            {live.map((x) => (
              <EntryRow key={x.id} entry={x} onOpen={onOpen} onOpenQuestion={onOpen} select={g === "requirement" && selecting ? { checked: checked.has(x.id), onToggle: () => toggle(x.id) } : undefined} />
            ))}
            {dead.length > 0 && (
              <>
                <button type="button" className="fold" aria-expanded={!!open[g]} onClick={() => setOpen((o) => ({ ...o, [g]: !o[g] }))}>
                  {t("know.inactive", { n: dead.length })}
                </button>
                {open[g] && dead.map((x) => <EntryRow key={x.id} entry={x} onOpen={onOpen} onOpenQuestion={onOpen} dim />)}
              </>
            )}
          </section>
        );
      })}
    </>
  );
}

function DiagramGroup({ live, dead, repos, onOpen, onOpenDiagram }: { live: Row[]; dead: Row[]; repos: Repo[]; onOpen: (id: string) => void; onOpenDiagram: (id: string) => void }) {
  const t = useT();
  const [showDead, setShowDead] = useState(false);
  const labels = new Map(repos.map((r) => [r.id, r.label]));
  // One label line per repo, in the order repos were bound; repos no longer bound come last.
  const order = new Map(repos.map((r, i) => [r.id, i]));
  const byRepo = (rows: Row[]) => {
    const groups = new Map<string, Row[]>();
    for (const x of rows) {
      const key = x.diagram?.repoId ?? "";
      groups.set(key, [...(groups.get(key) ?? []), x]);
    }
    return [...groups.entries()].sort(([a], [b]) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity) || a.localeCompare(b));
  };
  const render = (rows: Row[], dim?: boolean) =>
    byRepo(rows).map(([repoId, xs]) => (
      <div key={repoId} className="krepo">
        <div className="krepo-label" data-testid="repo-label">{labels.get(repoId) ?? (repoId || "—")}</div>
        {xs.map((x) => <DiagramRow key={x.id} entry={x} onOpen={onOpen} onOpenDiagram={onOpenDiagram} dim={dim} />)}
      </div>
    ));
  return (
    <section className="kgroup">
      <h3>
        <span>{t("know.diagrams")}</span>
        <span className="n">{live.length}</span>
      </h3>
      {render(live)}
      {dead.length > 0 && (
        <>
          <button type="button" className="fold" aria-expanded={showDead} onClick={() => setShowDead((v) => !v)}>
            {t("know.inactive", { n: dead.length })}
          </button>
          {showDead && render(dead, true)}
        </>
      )}
    </section>
  );
}

/** The title opens the rendered diagram in its own window; the id opens the detail (type, source commit, update). */
function DiagramRow({ entry, onOpen, onOpenDiagram, dim }: { entry: Row; onOpen: (id: string) => void; onOpenDiagram: (id: string) => void; dim?: boolean }) {
  const t = useT();
  const meta = [entry.diagram?.type ?? null, entry.stale ? t("know.stale") : null].filter(Boolean);
  return (
    <div className={dim ? "krow dim" : "krow"} data-testid="entry-row">
      <button type="button" className="kid kid-btn" data-testid="entry-id" onClick={() => onOpen(entry.id)}>{entry.id}</button>
      <div className="kmain">
        <button type="button" className="ktitle" title={t("diagram.open")} onClick={() => onOpenDiagram(entry.id)}>
          {entry.title}
        </button>
        <span className="ext" aria-hidden="true">↗</span>
        {entry.isNew && <span className="newtag">{t("know.new")}</span>}
        {meta.length > 0 && <div className="kmeta">{meta.join(" · ")}</div>}
      </div>
    </div>
  );
}

function ByTime({ entries, onOpen }: { entries: EntrySummary[] | null; onOpen: (id: string) => void }) {
  const t = useT();
  const [locale] = useLocale();
  if (!entries) return <p className="placeholder">{t("common.loading")}</p>;
  if (entries.length === 0) return <p className="placeholder">{t("know.empty")}</p>;
  const dated = new Map<string, EntrySummary[]>();
  const undated: EntrySummary[] = [];
  for (const x of entries) {
    if (x.businessDate) dated.set(x.businessDate, [...(dated.get(x.businessDate) ?? []), x]);
    else undated.push(x);
  }
  const days = [...dated.keys()].sort();
  return (
    <>
      {days.map((d) => (
        <section key={d} className="kgroup">
          <h3><span>{formatDay(new Date(`${d}T00:00:00`), locale)}</span></h3>
          {dated.get(d)!.map((x) => <EntryRow key={x.id} entry={x} onOpen={onOpen} dim={inactive(x.status)} />)}
        </section>
      ))}
      {undated.length > 0 && (
        <section className="kgroup">
          <h3><span>{t("know.noDate")}</span></h3>
          {undated.map((x) => <EntryRow key={x.id} entry={x} onOpen={onOpen} dim={inactive(x.status)} />)}
        </section>
      )}
    </>
  );
}

type RowSelect = { checked: boolean; onToggle: () => void };

function EntryRow({ entry, onOpen, onOpenQuestion, select, dim }: { entry: Row; onOpen: (id: string) => void; onOpenQuestion?: (id: string) => void; select?: RowSelect; dim?: boolean }) {
  const t = useT();
  const [locale] = useLocale();
  const meta = [
    entry.businessDate ? formatDay(new Date(`${entry.businessDate}T00:00:00`), locale) : null,
    entry.related.length ? entry.related.join(", ") : null,
    entry.url ? domain(entry.url) : null,
    isStale(entry, new Date()) || entry.stale ? t("know.stale") : null,
  ].filter(Boolean);
  return (
    <div className={dim ? "krow dim" : "krow"} data-testid="entry-row">
      {select && <input type="checkbox" className="kcheck" aria-label={entry.id} checked={select.checked} onChange={select.onToggle} />}
      <span className={entry.kind === "question" ? "kid red" : "kid"} data-testid="entry-id">{entry.id}</span>
      <div className="kmain">
        <button type="button" className="ktitle" onClick={() => onOpen(entry.id)}>{entry.title}</button>
        {entry.kind === "workpackage" && <span className="itag" data-testid="wp-status">{t(`wp.status.${entry.status}`)}</span>}
        {entry.kind === "workpackage" && entry.workpackage?.blockedOn && (
          <button type="button" className="itag red rlink" onClick={() => onOpenQuestion?.(entry.workpackage!.blockedOn!)}>
            {t("wp.blocked")} {entry.workpackage.blockedOn}
          </button>
        )}
        {entry.basis === "inferred" && <span className="atag">{t("basis.inferred")}</span>}
        {entry.kind === "requirement" && entry.implementation && <ImplTag implementation={entry.implementation} />}
        {entry.isNew && <span className="newtag">{t("know.new")}</span>}
        {entry.url && (
          <a className="ext" href={entry.url} target="_blank" rel="noopener noreferrer" aria-label={`${entry.title} (${domain(entry.url)})`}>↗</a>
        )}
        {meta.length > 0 && <div className="kmeta">{meta.join(" · ")}</div>}
      </div>
    </div>
  );
}
