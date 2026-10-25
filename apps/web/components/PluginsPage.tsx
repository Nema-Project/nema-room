"use client";

import { useEffect, useState } from "react";
import { PLUGINS, type ExtensionRecord } from "@nema/shared";
import { listExtensions } from "@/lib/hub";
import { useT } from "@/lib/i18n";

export function PluginsPage({ onClose }: { onClose?: () => void }) {
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
    <div className="plugins-page" role="region" aria-label={t("plugins.title")}>
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
              <h2>{extension.name}</h2>
              {plugin && (
                <span className={plugin.dataFlow === "external" ? "tag red" : "tag"}>
                  {t(plugin.dataFlow === "external" ? "plugins.external" : "plugins.local")}
                </span>
              )}
              <p className="kmeta">{t(`extensions.provision.${extension.provision}`)}</p>
              <p className="kmeta">{t(`extensions.install.${extension.installState}`)}</p>
              <p className="kmeta">{t(`extensions.use.${extension.useState}`)}</p>
              {extension.error === "bundled-runtime-missing" && <p className="kmeta">{t("extensions.error.bundled-runtime-missing")}</p>}
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
