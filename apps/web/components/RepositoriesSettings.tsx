"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { formatDay, formatTime } from "@/lib/format";
import { bindRepo, listRepos, pickDirectory, previewRepo, unbindRepo, updateRepo, type RepoPreview } from "@/lib/hub";
import { useLocale, useT, type Locale } from "@/lib/i18n";
import type { Repo } from "@/lib/types";
import { hubErrorText } from "@/lib/errorText";

function fetchStatus(repo: Repo, t: ReturnType<typeof useT>, locale: Locale): string | null {
  if (!repo.hasOrigin) return t("code.noOrigin");
  const failed = repo.lastFetchError ? `${t("code.fetchFailed")} ${repo.lastFetchError}` : null;
  if (!repo.lastFetchAt) return failed;
  const at = new Date(repo.lastFetchAt);
  const fetched = `${t("code.fetchedAt")} ${formatDay(at, locale)} ${formatTime(at, locale)}`;
  return failed ? `${failed} · ${fetched}` : fetched;
}

export function RepositoriesSettings({ workspaceId, onRepoBound }: { workspaceId: string; onRepoBound: () => void }) {
  const t = useT();
  const [locale] = useLocale();
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [preview, setPreview] = useState<RepoPreview | null>(null);
  const [label, setLabel] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  // Every list read and every mutation bumps this. A list response that resolves after a mutation
  // (or a newer read) must not overwrite the mutated list, and a failed background reread keeps the
  // list that is already shown.
  const seq = useRef(0);

  useEffect(() => {
    let cancel = false;
    const mine = ++seq.current;
    const message = (err: unknown) => (hubErrorText(err, t));
    listRepos(workspaceId)
      .then((rows) => {
        if (!cancel && mine === seq.current) setRepos(rows);
      })
      .catch((err: unknown) => {
        if (cancel || mine !== seq.current) return;
        setRepos((list) => list ?? []);
        setFormError(message(err));
      });
    return () => {
      cancel = true;
    };
  }, [workspaceId, t]);

  async function browse() {
    setPicking(true);
    let replacing = false;
    try {
      const chosen = await pickDirectory();
      if (!chosen?.path) return;
      replacing = true;
      setPreviewing(true);
      setFormError(null);
      const next = await previewRepo(workspaceId, chosen.path);
      setPreview(next);
      setLabel(next.label);
    } catch (err) {
      if (replacing) setPreview(null);
      setFormError(hubErrorText(err, t));
    } finally {
      setPicking(false);
      setPreviewing(false);
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!preview) return;
    const trimmedLabel = label.trim();
    if (!trimmedLabel || (preview.labelTaken && trimmedLabel === preview.label)) return;
    try {
      const created = await bindRepo(workspaceId, { path: preview.root, label: trimmedLabel, mainBranch: preview.defaultBranch });
      seq.current += 1;
      setRepos((list) => [...(list ?? []), created]);
      // Binding starts the repository's graph build: the first real Graphify call, so the offer may open here.
      onRepoBound();
      setPreview(null);
      setLabel("");
      setFormError(null);
    } catch (err) {
      setFormError(hubErrorText(err, t));
    }
  }

  async function saveRepo(repoId: string, patch: { label?: string; mainBranch?: string; trustSkills?: boolean }) {
    try {
      const next = await updateRepo(workspaceId, repoId, patch);
      seq.current += 1;
      setRepos((list) => list?.map((repo) => (repo.id === repoId ? next : repo)) ?? null);
    } catch (err) {
      setFormError(hubErrorText(err, t));
      throw err;
    }
  }

  async function removeRepo(repoId: string) {
    const previous = repos;
    seq.current += 1;
    setRepos((list) => list?.filter((repo) => repo.id !== repoId) ?? null);
    try {
      await unbindRepo(workspaceId, repoId);
    } catch (err) {
      setRepos(previous);
      setFormError(hubErrorText(err, t));
    }
  }

  return (
    <section className="repositories-section settings-group" aria-labelledby="workspace-repositories-heading">
      <h2 className="label" id="workspace-repositories-heading">{t("settings.repositories")}</h2>
      <h3 className="label">{t("code.repos")}</h3>
      {(repos ?? []).map((repo) => (
        <RepoRow key={repo.id} repo={repo} locale={locale} onSave={saveRepo} onRemove={removeRepo} />
      ))}
      <form onSubmit={(e) => void add(e)}>
        <div className="field">
          <span className="label">{t("code.path")}</span>
          <div className="path-pick">
            <button type="button" onClick={() => void browse()} disabled={picking || previewing}>{t("code.browse")}</button>
            <span className="repo-path">{preview?.root || t("code.pathEmpty")}</span>
          </div>
        </div>
        {previewing && <p className="kmeta">{t("code.previewing")}</p>}
        {preview && <>
          <p><span className="label">{t("code.remote")}</span> {preview.hasOrigin && preview.remoteUrl ? preview.remoteUrl : t("code.noOrigin")}</p>
          <p><span className="label">{t("code.mainBranch")}</span> {preview.defaultBranch}</p>
          {preview.labelTaken && <label className="field">
            <span className="label">{t("code.label")}</span>
            <input type="text" aria-label={t("code.label")} value={label} onChange={(e) => setLabel(e.target.value)} />
            <span className="help">{t("code.labelTaken")}</span>
          </label>}
        </>}
        <button type="submit" disabled={!preview || previewing || (preview.labelTaken && (!label.trim() || label.trim() === preview.label))}>{t("code.addRepo")}</button>
        {formError && (
          <p className="error" role="alert">
            {formError}
          </p>
        )}
      </form>
    </section>
  );
}

function RepoRow({
  repo,
  locale,
  onSave,
  onRemove,
}: {
  repo: Repo;
  locale: Locale;
  onSave: (repoId: string, patch: { label?: string; mainBranch?: string; trustSkills?: boolean }) => Promise<void>;
  onRemove: (repoId: string) => Promise<void>;
}) {
  const t = useT();
  const [label, setLabel] = useState(repo.label);
  const [branch, setBranch] = useState(repo.mainBranch);
  const [confirmTrust, setConfirmTrust] = useState(false);
  const status = fetchStatus(repo, t, locale);

  function commitLabel() {
    const trimmed = label.trim();
    if (!trimmed || trimmed === repo.label) return setLabel(repo.label);
    void onSave(repo.id, { label: trimmed }).catch(() => setLabel(repo.label));
  }

  function commitBranch() {
    const trimmed = branch.trim();
    if (!trimmed || trimmed === repo.mainBranch) return setBranch(repo.mainBranch);
    void onSave(repo.id, { mainBranch: trimmed }).catch(() => setBranch(repo.mainBranch));
  }

  return (
    <div className="repo-row">
      <div className="repo-path">{repo.path}</div>
      <label className="field">
        <span className="label">{t("code.label")}</span>
        <input type="text" aria-label={`${t("code.label")} ${repo.path}`} value={label} onChange={(e) => setLabel(e.target.value)} onBlur={commitLabel} />
      </label>
      <label className="field">
        <span className="label">{t("code.mainBranch")}</span>
        <input type="text" aria-label={`${t("code.mainBranch")} ${repo.path}`} value={branch} onChange={(e) => setBranch(e.target.value)} onBlur={commitBranch} />
      </label>
      {status && <p className="kmeta">{status}</p>}
      <label className="check">
        <input
          type="checkbox"
          aria-label={`${t("code.trustSkills")} ${repo.path}`}
          checked={repo.trustSkills}
          onChange={(e) => {
            if (e.target.checked) return setConfirmTrust(true);
            setConfirmTrust(false);
            void onSave(repo.id, { trustSkills: false }).catch(() => {});
          }}
        />
        <span>{t("code.trustSkills")}</span>
      </label>
      {confirmTrust && !repo.trustSkills && (
        <div role="group" aria-label={`${t("code.trustSkills")} ${repo.path}`} className="confirm">
          <p className="help">{t("code.trustSkillsConfirm")}</p>
          <button type="button" className="settings-action" onClick={() => { setConfirmTrust(false); void onSave(repo.id, { trustSkills: true }).catch(() => {}); }}>
            {t("code.trustSkillsYes")}
          </button>
          <button type="button" className="settings-action" onClick={() => setConfirmTrust(false)}>
            {t("sidebar.cancel")}
          </button>
        </div>
      )}
      {repo.trustSkills && <p className="kmeta">{t("code.trustSkillsNext")}</p>}
      <p className="kmeta">
        GitHub: {repo.githubTarget ? <span className="kid">{repo.githubTarget}</span> : <span>{t("github.noRemote")}</span>}
      </p>
      <button type="button" className="settings-action" aria-label={`${t("sidebar.delete")} ${repo.path}`} onClick={() => void onRemove(repo.id)}>
        {t("sidebar.delete")}
      </button>
    </div>
  );
}
