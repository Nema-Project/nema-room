"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SkillInstallJob, SkillInstallOffer } from "@nema/shared";
import { cancelExtensionInstall, getExtensionInstall, installExtension } from "@/lib/hub";
import { useT } from "@/lib/i18n";

/**
 * A skill the agent offered in its reply. The card shows the preview the daemon pinned and installs
 * nothing on its own: pressing Install is the user's confirmation, and it sends exactly the offered
 * source, commit and folder to the same install service the Plugins page uses.
 */
export function SkillOfferCard({ offer, pollMs = 1000 }: { offer: SkillInstallOffer; pollMs?: number }) {
  const t = useT();
  const [job, setJob] = useState<SkillInstallJob | null>(null);
  // Set when the install on this card was started here; an earlier one reads "Already installed".
  const [startedHere, setStartedHere] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const open = useRef(true);
  // Each follow chain has a number; starting a new one (or cancelling) silences the old one.
  const chain = useRef(0);

  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);

  const follow = useCallback(
    (next: SkillInstallJob) => {
      const mine = ++chain.current;
      setJob(next);
      if (next.state !== "running") return;
      const poll = () =>
        setTimeout(() => {
          if (!open.current || chain.current !== mine) return;
          getExtensionInstall(offer.id)
            .then((latest) => {
              if (!open.current || chain.current !== mine) return;
              setJob(latest);
              if (latest.state === "running") poll();
            })
            .catch((e: unknown) => {
              if (!open.current || chain.current !== mine) return;
              setError(e instanceof Error ? e.message : String(e));
              poll();
            });
        }, pollMs);
      poll();
    },
    [offer.id, pollMs],
  );

  // What the daemon already knows about this id: a finished install, one still running, or nothing.
  useEffect(() => {
    let live = true;
    getExtensionInstall(offer.id)
      .then((known) => {
        if (live) follow(known);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [offer.id, follow]);

  const run = (request: () => Promise<SkillInstallJob>, here: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    void request()
      .then((next) => {
        if (!open.current) return;
        if (here) setStartedHere(true);
        follow(next);
      })
      .catch((e: unknown) => {
        if (open.current) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        inFlight.current = false;
        if (open.current) setBusy(false);
      });
  };

  const install = () => run(() => installExtension({ source: offer.source, commit: offer.commit, path: offer.path }), true);
  const cancel = () => {
    chain.current += 1;
    run(() => cancelExtensionInstall(offer.id), false);
  };

  const state = job?.state ?? null;
  let line: string | null = null;
  if (state === "running") line = t("extensions.job.running", { done: job!.done, total: job!.total });
  else if (state === "installed") line = t(startedHere ? "extensions.job.installed" : "extensions.add.installed");
  else if (state === "failed") line = t("extensions.job.failed", { error: job!.error ?? "" });
  else if (state === "cancelled" && startedHere) line = t("extensions.job.cancelled");

  return (
    <section className="skill-offer" aria-label={t("chat.skillOffer.title", { name: offer.name })}>
      <h4>{t("chat.skillOffer.title", { name: offer.name })}</h4>
      {offer.description && <p>{offer.description}</p>}
      <p className="kmeta">{offer.repository}</p>
      <p className="kmeta">
        {t("extensions.add.commit", { commit: offer.commit.slice(0, 7) })}
        {offer.license && ` · ${t("extensions.add.license", { license: offer.license })}`}
      </p>
      <p className="kmeta">
        <code>{offer.path}</code> · {t("extensions.add.target", { target: offer.target })}
      </p>
      <p className="note">{t("chat.skillOffer.note")}</p>
      <div className="actions">
        {(state === null || state === "failed" || state === "cancelled") && (
          <button type="button" className="primary" onClick={install} disabled={busy}>
            {t("extensions.add.install")}
          </button>
        )}
        {state === "running" && (
          <button type="button" onClick={cancel} disabled={busy}>
            {t("extensions.action.cancel-install")}
          </button>
        )}
        {line && <span role="status">{line}</span>}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
