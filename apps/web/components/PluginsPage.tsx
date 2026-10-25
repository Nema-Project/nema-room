"use client";

import { useEffect, useState } from "react";
import { listPlugins } from "@/lib/hub";
import { useT } from "@/lib/i18n";
import type { PluginCatalogItem } from "@/lib/types";

export function PluginsPage({ onClose }: { onClose?: () => void }) {
  const t = useT();
  const [plugins, setPlugins] = useState<PluginCatalogItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    listPlugins()
      .then((rows) => {
        if (!cancel) setPlugins(rows);
      })
      .catch((e: unknown) => {
        if (!cancel) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancel = true;
    };
  }, []);

  return (
    <div className="plugins-page" role="region" aria-label={t("plugins.nav")}>
      <div className="bar">
        <h1>{t("plugins.nav")}</h1>
        {onClose && (
          <button type="button" className="sp link" onClick={onClose}>
            {t("common.close")}
          </button>
        )}
      </div>
      <div className="drawer-body">
        {error && <p className="error">{error}</p>}
        {plugins === null && !error && <p className="kmeta">{t("common.loading")}</p>}
        {plugins?.map((plugin) => (
          <section key={plugin.id} className="plugin-block">
            <h2>{plugin.displayName}</h2>
            <span className={plugin.dataFlow === "external" ? "tag red" : "tag"}>
              {t(plugin.dataFlow === "external" ? "plugins.external" : "plugins.local")}
            </span>
            {plugin.id !== "github" && (
              <p className="kmeta">
                {plugin.installed ? t("plugins.installed") : t("plugins.notInstalled")}
                {plugin.detail ? ` ${plugin.detail}` : ""}
              </p>
            )}
            <ul>
              {plugin.functions.map((fn) => (
                <li key={fn.name}>
                  <span className="kid">{fn.name}</span>
                  <span>{fn.description}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
