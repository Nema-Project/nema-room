"use client";

import { useEffect, useState } from "react";
import { GraphifyEntry } from "@/components/ComponentsSettings";
import { graphifyErrorText } from "@/lib/graphifyText";
import { HubError, listPlugins, listWorkspacePlugins, updateWorkspacePlugin } from "@/lib/hub";
import { useT } from "@/lib/i18n";
import type { PluginCatalogItem, WorkspacePlugin } from "@/lib/types";

const EXTRA_RULES_MAX = 2000;

function installText(pluginId: string, catalog: PluginCatalogItem[], t: ReturnType<typeof useT>): string {
  const row = catalog.find((item) => item.id === pluginId);
  if (row?.graphifyError) return graphifyErrorText(row.graphifyError, t);
  const status = t(row?.installed ? "plugins.installed" : "plugins.notInstalled");
  return row?.detail ? `${status} ${row.detail}` : status;
}

export function CodeAndPlugins({ workspaceId, graphOfferSignal }: { workspaceId: string; graphOfferSignal: number }) {
  const t = useT();
  const [plugins, setPlugins] = useState<WorkspacePlugin[] | null>(null);
  const [catalog, setCatalog] = useState<PluginCatalogItem[] | null>(null);
  const [catalogError, setCatalogError] = useState<{ message: string; graphifyError?: HubError["graphifyError"] } | null>(null);
  const [pluginError, setPluginError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
    listWorkspacePlugins(workspaceId)
      .then((rows) => {
        if (!cancel) setPlugins(rows);
      })
      .catch((err: unknown) => {
        if (cancel) return;
        setPlugins([]);
        setPluginError(message(err));
      });
    // Install status is a join. A failed catalog must not hide the toggles.
    listPlugins()
      .then((rows) => {
        if (!cancel) setCatalog(rows);
      })
      .catch((err: unknown) => {
        if (!cancel) setCatalogError({ message: message(err), graphifyError: err instanceof HubError ? err.graphifyError : undefined });
      });
    return () => {
      cancel = true;
    };
  }, [workspaceId]);

  async function patchPlugin(pluginId: string, patch: { enabled?: boolean; disabledFunctions?: string[]; settings?: Record<string, unknown> }) {
    try {
      const next = await updateWorkspacePlugin(workspaceId, pluginId, patch);
      setPlugins((list) => list?.map((row) => (row.plugin.id === pluginId ? next : row)) ?? null);
    } catch (err) {
      setPluginError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  return (
    <section className="code-section settings-group" aria-labelledby="workspace-code-heading">
      <h2 className="label" id="workspace-code-heading">{t("code.title")}</h2>

      <GraphifyEntry offerSignal={graphOfferSignal} />

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
              <p className="error">{catalogError.graphifyError ? graphifyErrorText(catalogError.graphifyError, t) : catalogError.message}</p>
            ) : row.plugin.id === "github" ? null : catalog ? (
              <p className="kmeta">{installText(row.plugin.id, catalog, t)}</p>
            ) : (
              <p className="kmeta">{t("common.loading")}</p>
            )}
            {row.plugin.id === "grill" && <GrillSettings row={row} onSave={(settings) => patchPlugin("grill", { settings })} />}
            {row.plugin.id === "github" && (
              <label className="check">
                <input type="checkbox" checked={row.settings?.allowWrites === true} onChange={(e) => void patchPlugin("github", { settings: { allowWrites: e.target.checked } }).catch(() => {})} />
                <span>{t("github.allowWrites")}</span>
              </label>
            )}
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

      {pluginError && <p className="error" role="alert">{pluginError}</p>}
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
      <button type="button" className="settings-action" disabled={tooLong || saving} onClick={() => void save()}>{t("wp.save")}</button>
    </div>
  );
}
