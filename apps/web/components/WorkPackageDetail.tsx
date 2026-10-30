"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { HistoryTab } from "@/components/HistoryTab";
import { Markdown } from "@/components/Markdown";
import { approveWorkPackage, confirmWorkPackageTask, dropWorkPackage, getHistory, getWorkPackage, regenerateWorkPackage, saveWorkPackageDoc } from "@/lib/hub";
import { useT } from "@/lib/i18n";
import type { HistoryItem, WorkPackage, WpTask, WpTaskView } from "@/lib/types";

type Tab = "overview" | "spec" | "plan" | "history";
type Props = {
  workspaceId: string;
  entryId: string;
  onClose: () => void;
  onJumpToMessage: (messageId: string) => void;
  /** Opens another entry in the knowledge column; requirements and `[R-3]`-style markers link to it. */
  onOpenEntry?: (entryId: string) => void;
  refreshKey?: number;
  initialTab?: "overview" | "history";
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * A task's status, in the same tag style as a requirement's implementation status. A task the user confirmed
 * reads "task marked done by you", never requirement acceptance. A `verified` task reads "commits checked" only
 * when its own report's check passed; otherwise it has no verified label.
 */
export function TaskTag({ task }: { task: WpTask }) {
  const t = useT();
  const { reportPassed } = task as WpTaskView;
  if (task.status === "verified") {
    if (task.confirmedBy === "user") return <span className="itag verified" data-testid="task-tag">{t("impl.taskConfirmed")}</span>;
    if (!task.inferred && reportPassed === true) return <span className="itag verified" data-testid="task-tag">{t("impl.verified")}</span>;
    return null;
  }
  const inferred = task.status === "reported" && task.inferred;
  const cls = task.status === "mismatch" ? "itag red" : inferred ? "itag inferred" : "itag";
  const label = task.status === "pending" ? t("wp.task.pending") : t(inferred ? "impl.reportedInferred" : `impl.${task.status}`);
  return <span className={cls} data-testid="task-tag">{label}</span>;
}

export function WorkPackageDetail({ workspaceId, entryId, onClose, onJumpToMessage, onOpenEntry, refreshKey = 0, initialTab = "overview" }: Props) {
  const t = useT();
  const [wp, setWp] = useState<WorkPackage | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [editing, setEditing] = useState<"spec" | "plan" | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current; // only the latest request may write state
    try {
      const [p, h] = await Promise.all([getWorkPackage(workspaceId, entryId), getHistory(workspaceId, entryId)]);
      if (mine !== seq.current) return;
      setWp(p);
      setHistory(h);
      setError(null);
    } catch (e) {
      if (mine === seq.current) setError(errMsg(e));
    }
  }, [workspaceId, entryId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount and refresh: state is set once the requests resolve
    void load();
  }, [load, refreshKey]);

  if (!wp) {
    return (
      <div className="detail">
        <div className="detail-head"><button type="button" className="x" aria-label={t("common.close")} onClick={onClose}>✕</button></div>
        {error ? <p className="error" role="alert">{t("wp.loadFailed", { message: error })}</p> : <p className="placeholder">{t("common.loading")}</p>}
      </div>
    );
  }

  const { entry, spec, plan } = wp;
  const meta = entry.workpackage!;
  const act = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setActionError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const saveDoc = async () => {
    if (!editing) return;
    const which = editing;
    await act(async () => {
      await saveWorkPackageDoc(workspaceId, entryId, which, draft);
      setEditing(null);
    });
  };
  const canApprove = entry.status === "draft" && !!spec && !!plan;
  const canRegenerate = entry.status !== "dropped";
  const doc = (which: "spec" | "plan", text: string | null) =>
    editing === which ? (
      <form className="editform" onSubmit={(ev) => { ev.preventDefault(); void saveDoc(); }}>
        <textarea className="mono" rows={20} aria-label={t(`wp.tab.${which}`)} value={draft} onChange={(e) => setDraft(e.target.value)} />
        <div className="actions">
          <button type="submit" className="primary" disabled={busy}>{t("wp.save")}</button>
          <button type="button" onClick={() => setEditing(null)}>{t("wp.cancel")}</button>
        </div>
      </form>
    ) : (
      <>
        {text ? <Markdown source={text} onOpenEntry={onOpenEntry} /> : <p className="placeholder">{t("wp.noDoc")}</p>}
        {entry.status !== "dropped" && (
          <div className="actions">
            <button type="button" className="editbtn" onClick={() => { setDraft(text ?? ""); setEditing(which); }}>{t("wp.edit")}</button>
          </div>
        )}
      </>
    );

  return (
    <div className="detail">
      <div className="detail-head">
        <div className="crumb">
          <span>{t("know.title")}</span> / <span>{t("know.workpackages")}</span> / <span>{entry.id}</span>
          <button type="button" className="x" aria-label={t("common.close")} onClick={onClose}>✕</button>
        </div>
        <div className="detail-id">
          <span className="kid">{entry.id}</span>
          <span className="stag">{t(`wp.status.${entry.status}`)}</span>
          {meta.blockedOn && (
            <button type="button" className="atag rlink" onClick={() => onOpenEntry?.(meta.blockedOn!)}>{t("wp.blocked")} {meta.blockedOn}</button>
          )}
        </div>
        <h2 className="detail-title">{entry.title}</h2>
        <div className="tabs" role="tablist">
          {(["overview", "spec", "plan", "history"] as const).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
              {t(`wp.tab.${k}`)}
            </button>
          ))}
        </div>
        <div className="actions wp-actions">
          {canApprove && <button type="button" className="primary" disabled={busy} onClick={() => void act(() => approveWorkPackage(workspaceId, entryId))}>{t("wp.approve")}</button>}
          {canRegenerate && <button type="button" className="editbtn" disabled={busy} onClick={() => void act(() => regenerateWorkPackage(workspaceId, entryId))}>{t("wp.regenerate")}</button>}
          {canRegenerate && <button type="button" className="editbtn" disabled={busy} onClick={() => void act(() => dropWorkPackage(workspaceId, entryId))}>{t("wp.drop")}</button>}
        </div>
      </div>
      <div className="detail-body">
        {actionError && <p className="error" role="alert">{actionError}</p>}
        {tab === "overview" && (
          <>
            <dl className="defs">
              <dt>{t("edit.status")}</dt>
              <dd>{t(`wp.status.${entry.status}`)}</dd>
              <dt>{t("wp.requirements")}</dt>
              <dd>
                {meta.requirements.length === 0
                  ? t("detail.noValue")
                  : meta.requirements.map((id) => (
                      <button key={id} type="button" className="rtag rlink" onClick={() => onOpenEntry?.(id)}>{id}</button>
                    ))}
              </dd>
            </dl>
            <h3>{t("wp.tasks")}</h3>
            {meta.tasks.length === 0 ? (
              <p className="placeholder">{t("wp.noTasks")}</p>
            ) : (
              <ul className="wp-tasks">
                {meta.tasks.map((task) => (
                  <li key={task.n} data-testid="task-row">
                    <span className="kid">{t("wp.taskLabel", { n: task.n })}</span>
                    <span className="wp-task-title">{task.title}</span>
                    <TaskTag task={task} />
                    {task.reportMessageId && (
                      <button type="button" className="link" onClick={() => onJumpToMessage(task.reportMessageId!)}>{t("impl.reportLink")}</button>
                    )}
                    {(task.status === "reported" || task.status === "mismatch") && (
                      <button type="button" className="editbtn" disabled={busy} aria-label={`${t("impl.confirm")} ${task.n}`} onClick={() => void act(() => confirmWorkPackageTask(workspaceId, entryId, task.n))}>
                        {t("impl.confirm")}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {tab === "spec" && doc("spec", spec)}
        {tab === "plan" && doc("plan", plan)}
        {tab === "history" && <HistoryTab workspaceId={workspaceId} entryId={entryId} history={history} current={entry} />}
      </div>
    </div>
  );
}
