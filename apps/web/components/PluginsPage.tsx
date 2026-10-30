"use client";

import { useEffect, useRef, useState } from "react";
import { PLUGINS, type ExtensionRecord } from "@nema/shared";
import { listExtensions, removeExtension, setExtensionUse } from "@/lib/hub";
import { useT } from "@/lib/i18n";

function chipTone(kind: "provision" | "install" | "use", extension: ExtensionRecord) {
  const broken = extension.availability !== "ready" || extension.error != null;
  if (kind === "provision") return extension.provision === "external" ? "status-bad" : "";
  if (kind === "install") {
    if (extension.installState === "failed") return "status-bad";
    if (extension.installState === "installed") return broken ? "status-bad" : "status-ok";
    return "";
  }
  if (extension.useState === "enabled") return broken ? "status-bad" : "status-ok";
  return "";
}

export function PluginsPage({ onClose, embedded = false }: { onClose?: () => void; embedded?: boolean }) {
  const t = useT();
  const [extensions, setExtensions] = useState<ExtensionRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One pending request per extension, not one for the whole page: turning GitHub off must not grey
  // out graphify's button.
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  // One row at a time can be asking "really?". Removal deletes files or drops a list entry, so the
  // first click only opens the question and the second one answers it.
  const [confirming, setConfirming] = useState<string | null>(null);
  // Every applied toggle bumps this. The initial list read only lands when nothing was toggled while
  // it was in flight, so a slow first load cannot put the old state back over a fresh answer.
  const applied = useRef(0);

  const toggle = (extension: ExtensionRecord) => {
    const id = extension.id;
    if (pending.has(id)) return;
    const next = extension.useState === "enabled" ? "disabled" : "enabled";
    setPending((ids) => new Set(ids).add(id));
    setActionError(null);
    setExtensionUse(id, next)
      .then((row) => {
        applied.current += 1;
        setExtensions((rows) => rows?.map((item) => (item.id === row.id ? row : item)) ?? null);
      })
      .catch((e: unknown) => setActionError(e instanceof Error ? e.message : String(e)))
      .finally(() =>
        setPending((ids) => {
          const rest = new Set(ids);
          rest.delete(id);
          return rest;
        }),
      );
  };

  const remove = (extension: ExtensionRecord) => {
    const id = extension.id;
    if (pending.has(id)) return;
    setPending((ids) => new Set(ids).add(id));
    setActionError(null);
    removeExtension(id)
      .then(() => {
        applied.current += 1;
        setConfirming((current) => (current === id ? null : current));
        setExtensions((rows) => rows?.filter((item) => item.id !== id) ?? null);
      })
      .catch((e: unknown) => {
        setActionError(e instanceof Error ? e.message : String(e));
        // The removal can have landed even though the answer did not: a lost reply, or another tab
        // that removed the row first. Ask again, and let a list that no longer has the row clear it.
        // A failed refresh stays quiet so it cannot replace the removal error with a lesser one.
        listExtensions()
          .then((rows) => {
            setExtensions(rows);
            setConfirming((current) => (current === id ? null : current));
          })
          .catch(() => {});
      })
      .finally(() =>
        setPending((ids) => {
          const rest = new Set(ids);
          rest.delete(id);
          return rest;
        }),
      );
  };

  useEffect(() => {
    let cancel = false;
    const seen = applied.current;
    listExtensions()
      .then((rows) => {
        if (!cancel && applied.current === seen) setExtensions(rows);
      })
      .catch((e: unknown) => {
        if (!cancel) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancel = true;
    };
  }, []);

  return (
    <div className={embedded ? "plugins-page embedded" : "plugins-page"} role="region" aria-label={t("plugins.title")}>
      <div className="bar">
        <h1>{t("plugins.title")}</h1>
        {onClose && (
          <button type="button" className="sp link" onClick={onClose}>
            {t("common.close")}
          </button>
        )}
      </div>
      <div className="drawer-body">
        {error && <p className="error">{error}</p>}
        {actionError && <p className="error">{actionError}</p>}
        {extensions === null && !error && <p className="kmeta">{t("common.loading")}</p>}
        {extensions?.map((extension) => {
          const plugin = PLUGINS.find((item) => item.id === extension.id);
          return (
            <section key={extension.id} className="plugin-block">
              <div className="plugin-facts">
                <h2>{extension.name}</h2>
                <p className="plugin-status">
                  <span className={["chip", chipTone("provision", extension)].filter(Boolean).join(" ")}>{t(`extensions.provision.${extension.provision}`)}</span>
                  <span className={["chip", chipTone("install", extension)].filter(Boolean).join(" ")}>{t(`extensions.install.${extension.installState}`)}</span>
                  <span className={["chip", chipTone("use", extension)].filter(Boolean).join(" ")}>{t(`extensions.use.${extension.useState}`)}</span>
                  {plugin?.dataFlow === "external" && <span className="tag red">{t("plugins.external")}</span>}
                </p>
              </div>
              <button type="button" className="sp" onClick={() => toggle(extension)} disabled={pending.has(extension.id)}>
                {extension.useState === "enabled" ? t("extensions.action.disable") : t("extensions.action.enable")}
              </button>
              {/* Bundled extensions ship inside the app, so there is nothing to delete: they only get the switch. */}
              {extension.provision !== "bundled" && (
                confirming === extension.id ? (
                  <>
                    <p className="plugin-note">
                      {t(extension.provision === "managed" ? "extensions.note.remove" : "extensions.note.detach")}
                    </p>
                    <button type="button" className="sp" onClick={() => remove(extension)} disabled={pending.has(extension.id)}>
                      {t(extension.provision === "managed" ? "extensions.action.confirm-remove" : "extensions.action.confirm-detach")}
                    </button>
                    <button type="button" className="sp" onClick={() => setConfirming(null)} disabled={pending.has(extension.id)}>
                      {t("extensions.action.cancel")}
                    </button>
                  </>
                ) : (
                  <button type="button" className="sp" onClick={() => { setActionError(null); setConfirming(extension.id); }} disabled={pending.has(extension.id)}>
                    {t(extension.provision === "managed" ? "extensions.action.remove" : "extensions.action.detach")}
                  </button>
                )
              )}
              {extension.error === "bundled-runtime-missing" && <p className="plugin-note">{t("extensions.error.bundled-runtime-missing")}</p>}
              {plugin && plugin.functions.length > 0 && (
                <ul>
                  {plugin.functions.map((fn) => (
                    <li key={fn.name}>
                      <span className="kid">{fn.name}</span>
                      <span>{fn.description}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
