"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import type { SkillSourcePreview } from "@nema/shared";
import { resolveExtensionSource } from "@/lib/hub";
import { useT } from "@/lib/i18n";

/**
 * Paste a GitHub or skills.sh source, see what it pins to, then pick a skill to install.
 *
 * The preview is the daemon's answer: the commit, the license and every skill with its target folder
 * or the reason it cannot be installed. Installing sends that same source, commit and folder back, so
 * what gets installed is what was shown, not whatever the branch points to by then.
 */
export function SkillInstallPanel({
  onInstall,
  busy,
  status,
}: {
  onInstall: (request: { source: string; commit: string; path: string }, id: string) => void;
  /** An install request for this id is in flight, so its button waits for the answer. */
  busy: (id: string) => boolean;
  /** The current install line for a skill id, or null when nothing has been started for it. */
  status: (id: string) => ReactNode;
}) {
  const t = useT();
  const [source, setSource] = useState("");
  const [preview, setPreview] = useState<{ source: string; result: SkillSourcePreview } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = source.trim();
    if (!trimmed || loading) return;
    setLoading(true);
    setError(null);
    // The old preview stops being installable the moment another read starts.
    setPreview(null);
    resolveExtensionSource(trimmed)
      .then((result) => setPreview({ source: trimmed, result }))
      .catch((e: unknown) => {
        setPreview(null);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setLoading(false));
  };

  return (
    <section className="plugin-block skill-install" role="region" aria-label={t("extensions.add.title")}>
      <h3>{t("extensions.add.title")}</h3>
      <form className="field" onSubmit={submit}>
        <label>
          <span className="label">{t("extensions.add.label")}</span>
          <input type="text" value={source} placeholder={t("extensions.add.placeholder")} onChange={(e) => {
              setSource(e.target.value);
              // A preview belongs to the text it was read from; editing the text withdraws it.
              setPreview(null);
            }} disabled={loading} />
        </label>
        <button type="submit" className="sp" disabled={loading || !source.trim()}>
          {loading ? t("extensions.add.previewing") : t("extensions.add.preview")}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      {preview && (
        <div className="skill-preview">
          <p className="kmeta">
            <span title={preview.result.commit}>{t("extensions.add.commit", { commit: preview.result.commit.slice(0, 7) })}</span>
            {" · "}
            <span>{preview.result.license ? t("extensions.add.license", { license: preview.result.license }) : t("extensions.add.no-license")}</span>
            {" · "}
            <span>{preview.result.repository}</span>
          </p>
          {preview.result.truncated && <p className="plugin-note">{t("extensions.add.truncated")}</p>}
          <ul>
            {preview.result.skills.map((skill) => {
              const line = skill.id ? status(skill.id) : null;
              return (
                <li key={skill.path}>
                  <h4>{skill.name}</h4>
                  {skill.description && <p>{skill.description}</p>}
                  <p className="kmeta">{skill.path}</p>
                  {skill.problem ? (
                    <p className="plugin-note">{t(`extensions.problem.${skill.problem}`)}</p>
                  ) : skill.installed ? (
                    <p className="kmeta">{t("extensions.add.installed")}</p>
                  ) : (
                    <>
                      {skill.target && <p className="kmeta">{t("extensions.add.target", { target: skill.target })}</p>}
                      {line ?? (
                        <button
                          type="button"
                          className="sp"
                          disabled={busy(skill.id!)}
                          onClick={() => onInstall({ source: preview.source, commit: preview.result.commit, path: skill.path }, skill.id!)}
                        >
                          {t("extensions.add.install")}
                        </button>
                      )}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
