"use client";

import { useState } from "react";
import { CodeAndPlugins } from "@/components/CodeAndPlugins";
import { updateWorkspace } from "@/lib/hub";
import { useT } from "@/lib/i18n";
import type { KnowledgeLanguage, Workspace, WorkspaceView } from "@/lib/types";

const LANGS: KnowledgeLanguage[] = ["ja", "en", "zh", "follow"];

export type WorkspaceSettingsProps = {
  workspace: WorkspaceView;
  onUpdated: (w: Workspace) => void;
  onClose: () => void;
};

export function WorkspaceSettings({ workspace, onUpdated, onClose }: WorkspaceSettingsProps) {
  const t = useT();
  const [name, setName] = useState(workspace.name);
  const [error, setError] = useState<string | null>(null);

  async function save(patch: Parameters<typeof updateWorkspace>[1]) {
    setError(null);
    try {
      onUpdated(await updateWorkspace(workspace.id, patch));
    } catch (e) {
      setError(t("settings.saveFailed", { message: e instanceof Error ? e.message : String(e) }));
    }
  }

  function commitName() {
    const trimmed = name.trim();
    if (trimmed === "") return setName(workspace.name);
    if (trimmed !== workspace.name) void save({ name: trimmed });
  }

  return (
    <aside className="drawer" role="dialog" aria-label={t("settings.title")}>
      <div className="bar">
        <h1>{t("settings.title")}</h1>
        <button type="button" className="sp settings-action" onClick={onClose}>
          {t("common.close")}
        </button>
      </div>
      <div className="drawer-body">
        <section className="settings-group">
          <label className="field">
            <span className="label">{t("settings.name")}</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} onBlur={commitName} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
          </label>

          <div className="field">
            <label className="check">
              <input type="checkbox" checked={workspace.confidential} onChange={(e) => void save({ confidential: e.target.checked })} />
              <span>{t("settings.confidential")}</span>
            </label>
            <p className="help">{t("settings.confidentialHelp")}</p>
          </div>

          <fieldset className="field">
            <legend className="label">{t("settings.knowledgeLanguage")}</legend>
            {LANGS.map((l) => (
              <label key={l} className="check">
                <input type="radio" name="knowledgeLanguage" checked={workspace.knowledgeLanguage === l} onChange={() => void save({ knowledgeLanguage: l })} />
                <span>{t(`settings.lang.${l}`)}</span>
              </label>
            ))}
            <p className="help">{t("settings.knowledgeLanguageHelp")}</p>
          </fieldset>

          {error && <p className="error" role="alert">{error}</p>}
        </section>
        <CodeAndPlugins workspaceId={workspace.id} />
      </div>
    </aside>
  );
}
