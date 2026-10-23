"use client";

import { useEffect, useState, type FormEvent } from "react";
import { formatDay, formatTime } from "@/lib/format";
import { bindRepo, listPlugins, listRepos, listWorkspacePlugins, unbindRepo, updateRepo, updateWorkspacePlugin } from "@/lib/hub";
import { useLocale, useT, type Locale } from "@/lib/i18n";
import type { PluginCatalogItem, Repo, WorkspacePlugin } from "@/lib/types";

const EXTRA_RULES_MAX = 2000;

function fetchStatus(repo: Repo, t: ReturnType<typeof useT>, locale: Locale): string | null {
  if (!repo.hasOrigin) return t("code.noOrigin");
  const failed = repo.lastFetchError ? `${t("code.fetchFailed")} ${repo.lastFetchError}` : null;
  if (!repo.lastFetchAt) return failed;
  const at = new Date(repo.lastFetchAt);
  const fetched = `${t("code.fetchedAt")} ${formatDay(at, locale)} ${formatTime(at, locale)}`;
  return failed ? `${failed} · ${fetched}` : fetched;
}

function installText(pluginId: string, catalog: PluginCatalogItem[], t: ReturnType<typeof useT>): string {
  const row = catalog.find((item) => item.id === pluginId);
  const status = t(row?.installed ? "plugins.installed" : "plugins.notInstalled");
  return row?.detail ? `${status} ${row.detail}` : status;
}

export function CodeAndPlugins({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const [locale] = useLocale();
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [plugins, setPlugins] = useState<WorkspacePlugin[] | null>(null);
  const [catalog, setCatalog] = useState<PluginCatalogItem[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [label, setLabel] = useState("");
  const [mainBranch, setMainBranch] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
    listRepos(workspaceId)
      .then((rows) => {
        if (!cancel) setRepos(rows);
      })
      .catch((err: unknown) => {
        if (cancel) return;
        setRepos([]);
        setFormError(message(err));
      });
    listWorkspacePlugins(workspaceId)
      .then((rows) => {
        if (!cancel) setPlugins(rows);
      })
      .catch((err: unknown) => {
        if (cancel) return;
        setPlugins([]);
        setFormError(message(err));
      });
    // Install status is a join. A failed catalog must not hide the toggles.
    listPlugins()
      .then((rows) => {
        if (!cancel) setCatalog(rows);
      })
      .catch((err: unknown) => {
        if (!cancel) setCatalogError(message(err));
      });
    return () => {
      cancel = true;
    };
  }, [workspaceId]);

  async function add(e: FormEvent) {
    e.preventDefault();
    const trimmedPath = path.trim();
    const trimmedLabel = label.trim();
    if (!trimmedPath || !trimmedLabel) return;
    const branch = mainBranch.trim();
    const body = { path: trimmedPath, label: trimmedLabel, ...(branch ? { mainBranch: branch } : {}) };
    try {
      const created = await bindRepo(workspaceId, body);
      setRepos((list) => [...(list ?? []), created]);
      setPath("");
      setLabel("");
      setMainBranch("");
      setFormError(null);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveRepo(repoId: string, patch: { label?: string; mainBranch?: string }) {
    try {
      const next = await updateRepo(workspaceId, repoId, patch);
      setRepos((list) => list?.map((repo) => (repo.id === repoId ? next : repo)) ?? null);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async function removeRepo(repoId: string) {
    const previous = repos;
    setRepos((list) => list?.filter((repo) => repo.id !== repoId) ?? null);
    try {
      await unbindRepo(workspaceId, repoId);
    } catch (err) {
      setRepos(previous);
      setFormError(err instanceof Error ? err.message : String(err));
    }
  }

  async function patchPlugin(pluginId: string, patch: { enabled?: boolean; disabledFunctions?: string[]; settings?: Record<string, unknown> }) {
        try {
      const next = await updateWorkspacePlugin(workspaceId, pluginId, patch);
      setPlugins((list) => list?.map((row) => (row.plugin.id === pluginId ? next : row)) ?? null);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  return (
    <section className="code-section">
      <h2 className="label">{t("code.title")}</h2>

      <h3 className="label">{t("code.repos")}</h3>
      {(repos ?? []).map((repo) => (
        <RepoRow key={repo.id} repo={repo} locale={locale} onSave={saveRepo} onRemove={removeRepo} />
      ))}
      <form onSubmit={(e) => void add(e)}>
        <label className="field">
          <span className="label">{t("code.path")}</span>
          <input type="text" value={path} onChange={(e) => setPath(e.target.value)} />
        </label>
        <label className="field">
          <span className="label">{t("code.label")}</span>
          <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label className="field">
          <span className="label">{t("code.mainBranch")}</span>
          <input type="text" value={mainBranch} onChange={(e) => setMainBranch(e.target.value)} />
        </label>
        <button type="submit">{t("code.addRepo")}</button>
        {formError && (
          <p className="error" role="alert">
            {formError}
          </p>
        )}
      </form>

      <h3 className="label">{t("code.plugins")}</h3>
      {(plugins ?? []).map((row) => {
        const open = openId === row.plugin.id;
        return (
          <div key={row.plugin.id} className="plugin-row">
            <div className="plugin-head">
              <label className="check">
                <input type="checkbox" checked={row.enabled} onChange={(e) => void patchPlugin(row.plugin.id, { enabled: e.target.checked }).catch(() => {})} />
                <span>{row.plugin.displayName}</span>
              </label>
              <span className={row.plugin.dataFlow === "external" ? "tag red" : "tag"}>
                {t(row.plugin.dataFlow === "external" ? "plugins.external" : "plugins.local")}
              </span>
              <button type="button" aria-expanded={open} aria-label={row.plugin.displayName} onClick={() => setOpenId(open ? null : row.plugin.id)}>
                {open ? "▾" : "▸"}
              </button>
            </div>
            {row.plugin.dataFlow === "external" && <p className="help">{t("plugins.externalNote")}</p>}
            {catalogError ? (
              <p className="error">{catalogError}</p>
            ) : catalog ? (
              <p className="kmeta">{installText(row.plugin.id, catalog, t)}</p>
            ) : (
              <p className="kmeta">{t("common.loading")}</p>
            )}
            {row.plugin.id === "grill" && <GrillSettings row={row} onSave={(settings) => patchPlugin("grill", { settings })} />}
            {open &&
              row.plugin.functions
                .filter((fn) => fn.readOnly)
                .map((fn) => (
                  <label key={fn.name} className="check">
                    <input
                      type="checkbox"
                      checked={!row.disabledFunctions.includes(fn.name)}
                      onChange={(e) => {
                        const disabledFunctions = e.target.checked
                          ? row.disabledFunctions.filter((name) => name !== fn.name)
                          : [...row.disabledFunctions, fn.name];
                        void patchPlugin(row.plugin.id, { disabledFunctions }).catch(() => {});
                      }}
                    />
                    <span className="kid">{fn.name}</span>
                    <span>{fn.description}</span>
                  </label>
                ))}
          </div>
        );
      })}

      <p className="help">{t("code.modelEgress")}</p>
    </section>
  );
}

/** grill-me's two settings: how strict the questioning is, and up to 2000 characters of the workspace's own rules. */
function GrillSettings({ row, onSave }: { row: WorkspacePlugin; onSave: (settings: { strictness: string; extraRules: string }) => Promise<void> }) {
  const t = useT();
  const stored = row.settings ?? {};
  const [strictness, setStrictness] = useState(stored.strictness === "lenient" ? "lenient" : "strict");
  const [extraRules, setExtraRules] = useState(typeof stored.extraRules === "string" ? stored.extraRules : "");
  const [saving, setSaving] = useState(false);
  const length = Array.from(extraRules).length;
  const tooLong = length > EXTRA_RULES_MAX;
  async function save() {
    if (tooLong || saving) return;
    setSaving(true);
    try {
      await onSave({ strictness, extraRules });
    } catch {
      /* the page shows the hub's message */
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="grill-settings">
      <label className="field">
        <span className="label">{t("grill.strictness")}</span>
        <select value={strictness} onChange={(e) => setStrictness(e.target.value)}>
          <option value="strict">{t("grill.strict")}</option>
          <option value="lenient">{t("grill.lenient")}</option>
        </select>
      </label>
      <label className="field">
        <span className="label">{t("grill.extraRules")}</span>
        <textarea rows={5} value={extraRules} onChange={(e) => setExtraRules(e.target.value)} />
      </label>
      <p className={tooLong ? "error" : "kmeta"} data-testid="grill-counter">{t("grill.counter", { n: length })}</p>
      {tooLong && <p className="error" role="alert">{t("grill.tooLong")}</p>}
      <button type="button" disabled={tooLong || saving} onClick={() => void save()}>{t("wp.save")}</button>
    </div>
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
  onSave: (repoId: string, patch: { label?: string; mainBranch?: string }) => Promise<void>;
  onRemove: (repoId: string) => Promise<void>;
}) {
  const t = useT();
  const [label, setLabel] = useState(repo.label);
  const [branch, setBranch] = useState(repo.mainBranch);
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
      <p className="kmeta">
        GitHub: {repo.githubTarget ? <span className="kid">{repo.githubTarget}</span> : <span>{t("github.noRemote")}</span>}
      </p>
      <button type="button" aria-label={`${t("sidebar.delete")} ${repo.path}`} onClick={() => void onRemove(repo.id)}>
        {t("sidebar.delete")}
      </button>
    </div>
  );
}
