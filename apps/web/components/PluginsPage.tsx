"use client";

import { useEffect, useState } from "react";
import { PLUGINS, type ExtensionRecord } from "@nema/shared";
import { listExtensions } from "@/lib/hub";
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

  useEffect(() => {
    let cancel = false;
    listExtensions()
      .then((rows) => {
        if (!cancel) setExtensions(rows);
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
