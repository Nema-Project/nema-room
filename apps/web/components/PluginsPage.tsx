"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PLUGINS, type ExtensionRecord, type SkillInstallJob } from "@nema/shared";
import {
  cancelExtensionInstall,
  getExtensionInstall,
  installExtension,
  listExtensions,
  removeExtension,
  retryExtensionInstall,
  setExtensionUse,
} from "@/lib/hub";
import { useT } from "@/lib/i18n";
import { SkillInstallPanel } from "./SkillInstallPanel";

/** Where an install was started, so its progress line shows next to that button and nowhere else. */
type TrackedJob = SkillInstallJob & { origin: "panel" | "list" };

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

export function PluginsPage({ onClose, embedded = false, pollMs = 1000 }: { onClose?: () => void; embedded?: boolean; pollMs?: number }) {
  const t = useT();
  const [jobs, setJobs] = useState<Record<string, TrackedJob>>({});
  // One polling chain per id. Starting, cancelling or retrying bumps the id's generation, so an answer
  // from an older chain cannot overwrite a newer state.
  const generation = useRef(new Map<string, number>());
  // Closing the page stops every polling chain; the installs themselves keep running in the daemon.
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
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

  // Install, retry and cancel requests in flight, by id, so a second click cannot send a duplicate.
  // The ref answers "is one in flight?" synchronously, so two clicks in one tick still send one request;
  // the state drives the disabled buttons.
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const inFlight = useRef(new Set<string>());
  const hold = (id: string, request: () => Promise<unknown>) => {
    if (inFlight.current.has(id)) return;
    inFlight.current.add(id);
    setBusy((ids) => new Set(ids).add(id));
    void request().finally(() => {
      inFlight.current.delete(id);
      setBusy((ids) => {
        const rest = new Set(ids);
        rest.delete(id);
        return rest;
      });
    });
  };

  /**
   * Re-read the list. An answer is applied only if nothing else changed the list since this read
   * started (another refresh, a toggle, a removal); otherwise an old answer would put back old state.
   */
  const refresh = useCallback((): Promise<ExtensionRecord[] | null> => {
    const seen = applied.current;
    return listExtensions()
      .then((rows) => {
        if (applied.current !== seen) return null;
        applied.current += 1;
        setExtensions(rows);
        return rows;
      })
      .catch(() => null);
  }, []);

  /**
   * After a job stops, the daemon may still be rolling it back (a cancel is answered before the
   * cleanup is written), so keep re-reading for a while until the row is no longer `installing`.
   */
  const settle = useCallback(
    (id: string) => {
      const again = (attempt: number) => {
        void refresh().then((rows) => {
          if (!open.current || attempt >= 20) return;
          const row = rows?.find((item) => item.id === id);
          if (rows === null || row?.installState === "installing") setTimeout(() => again(attempt + 1), pollMs);
        });
      };
      again(0);
    },
    [pollMs, refresh],
  );

  const track = useCallback(
    (job: SkillInstallJob, origin: TrackedJob["origin"]) => {
      const mine = (generation.current.get(job.id) ?? 0) + 1;
      generation.current.set(job.id, mine);
      const current = () => open.current && generation.current.get(job.id) === mine;
      const show = (next: SkillInstallJob) => setJobs((all) => ({ ...all, [next.id]: { ...next, origin } }));
      show(job);
      if (job.state !== "running") {
        settle(job.id);
        return;
      }
      const poll = () => {
        setTimeout(() => {
          if (!current()) return;
          getExtensionInstall(job.id)
            .then((next) => {
              if (!current()) return;
              show(next);
              if (next.state === "running") poll();
              else settle(job.id);
            })
            .catch((e: unknown) => {
              if (!current()) return;
              // A status read can fail while the install is fine (a slow daemon); say so and keep asking.
              setActionError(e instanceof Error ? e.message : String(e));
              poll();
            });
        }, pollMs);
      };
      poll();
      void refresh();
    },
    [pollMs, refresh, settle],
  );

  const install = (request: { source: string; commit: string; path: string }, id: string) => {
    setActionError(null);
    hold(id, () =>
      installExtension(request)
        .then((job) => track(job, "panel"))
        .catch((e: unknown) => setActionError(e instanceof Error ? e.message : String(e))),
    );
  };

  const retry = (id: string) => {
    setActionError(null);
    hold(id, () =>
      retryExtensionInstall(id)
        .then((job) => track(job, "list"))
        .catch((e: unknown) => setActionError(e instanceof Error ? e.message : String(e))),
    );
  };

  const cancelInstall = (id: string) => {
    setActionError(null);
    const origin = jobs[id]?.origin ?? "list";
    hold(id, () => {
      // Stop listening to the running chain first; the cancel answer is the state to show.
      generation.current.set(id, (generation.current.get(id) ?? 0) + 1);
      return cancelExtensionInstall(id)
        .then((job) => track(job, origin))
        .catch((e: unknown) => setActionError(e instanceof Error ? e.message : String(e)));
    });
  };

  /** The progress line for one id where its install was started, or null. */
  const jobLine = (id: string, where: TrackedJob["origin"]) => {
    const job = jobs[id];
    if (!job || job.origin !== where) return null;
    if (job.state === "running") {
      return (
        <p className="plugin-note" role="status">
          {t("extensions.job.running", { done: job.done, total: job.total })}{" "}
          <button type="button" className="sp" onClick={() => cancelInstall(id)} disabled={busy.has(id)}>
            {t("extensions.action.cancel-install")}
          </button>
        </p>
      );
    }
    if (job.state === "failed") return <p className="plugin-note" role="status">{t("extensions.job.failed", { error: job.error ?? "" })}</p>;
    return <p className="plugin-note" role="status">{t(`extensions.job.${job.state}`)}</p>;
  };

  useEffect(() => {
    let cancel = false;
    const seen = applied.current;
    listExtensions()
      .then((rows) => {
        if (cancel || applied.current !== seen) return;
        setExtensions(rows);
        // An install started before this page opened is still the daemon's; follow it from here.
        for (const row of rows) {
          if (row.provision !== "managed" || row.installState !== "installing") continue;
          getExtensionInstall(row.id)
            .then((job) => {
              if (!cancel) track(job, "list");
            })
            .catch(() => {});
        }
      })
      .catch((e: unknown) => {
        if (!cancel) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancel = true;
    };
    // `track` only changes with `pollMs`, which a page never changes after it mounts.
  }, [track]);

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
        <SkillInstallPanel onInstall={install} busy={(id) => busy.has(id)} status={(id) => jobLine(id, "panel")} />
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
              {extension.provision === "managed" && extension.installState === "failed" && extension.error && <p className="plugin-note">{extension.error}</p>}
              {extension.provision === "managed" &&
                extension.provenance &&
                (extension.installState === "failed" || extension.installState === "absent") &&
                jobs[extension.id]?.state !== "running" && (
                  <button type="button" className="sp" onClick={() => retry(extension.id)} disabled={busy.has(extension.id)}>
                    {t("extensions.action.retry-install")}
                  </button>
                )}
              {jobLine(extension.id, "list")}
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
