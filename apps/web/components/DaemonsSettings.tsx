"use client";

import { useEffect, useState } from "react";
import { createDaemonRegistrationCode, HubError, listDaemons, revokeDaemon, type DaemonRegistrationCode, type RegisteredDaemon } from "@/lib/hub";
import { useLocale, useT } from "@/lib/i18n";

export function DaemonsSettings() {
  const t = useT();
  const [locale] = useLocale();
  const [daemons, setDaemons] = useState<RegisteredDaemon[] | null>(null);
  const [code, setCode] = useState<DaemonRegistrationCode | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [actionError, setActionError] = useState<"actionError" | "codeLimit" | null>(null);

  useEffect(() => {
    let live = true;
    Promise.resolve().then(listDaemons).then((rows) => {
      if (live) setDaemons(rows);
    }).catch(() => {
      if (live) setLoadError(true);
    });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!code) return;
    const timer = window.setTimeout(() => setCode(null), Math.max(0, Date.parse(code.expiresAt) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [code]);

  async function generate() {
    setBusy(true);
    setActionError(null);
    setCode(null);
    try {
      setCode(await createDaemonRegistrationCode());
    } catch (error) {
      setActionError(error instanceof HubError && error.status === 429 ? "codeLimit" : "actionError");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    setActionError(null);
    try {
      const { revokedAt } = await revokeDaemon(id);
      setDaemons((rows) => rows?.map((row) => row.id === id ? { ...row, revokedAt } : row) ?? null);
      setConfirmId(null);
    } catch {
      setActionError("actionError");
    } finally {
      setBusy(false);
    }
  }

  const formatTime = (value: string) => new Date(value).toLocaleString(locale);

  return (
    <section className="app-settings-section" aria-labelledby="daemon-settings-title">
      <h2 id="daemon-settings-title" className="label">{t("daemonsSettings.title")}</h2>
      <button type="button" disabled={busy} onClick={() => { void generate(); }}>{t("daemonsSettings.generate")}</button>
      {code && (
        <div aria-live="polite">
          <p><code>{code.code}</code></p>
          <p>{t("daemonsSettings.expires", { time: formatTime(code.expiresAt) })}</p>
          <p>{t("daemonsSettings.enterCode")} <code>nema daemon register --hub &lt;url&gt;</code></p>
        </div>
      )}
      {actionError && <p className="error" role="alert">{t(`daemonsSettings.${actionError}`)}</p>}
      {loadError && <p className="error" role="alert">{t("daemonsSettings.loadError")}</p>}
      {daemons?.length === 0 && <p>{t("daemonsSettings.empty")}</p>}
      {daemons && daemons.length > 0 && (
        <ul>
          {daemons.map(({ id, label, lastSeenAt, revokedAt }) => (
            <li key={id}>
              <strong>{label}</strong>
              <p>{t(revokedAt ? "daemonsSettings.revoked" : "daemonsSettings.registered")}</p>
              <p>{lastSeenAt ? t("daemonsSettings.lastSeen", { time: formatTime(lastSeenAt) }) : t("daemonsSettings.neverSeen")}</p>
              {!revokedAt && (confirmId === id ? (
                <>
                  <p>{t("daemonsSettings.confirm", { label })}</p>
                  <button type="button" disabled={busy} onClick={() => { void revoke(id); }}>{t("daemonsSettings.confirmRevoke")}</button>
                  <button type="button" disabled={busy} onClick={() => setConfirmId(null)}>{t("daemonsSettings.cancel")}</button>
                </>
              ) : (
                <button type="button" disabled={busy} onClick={() => setConfirmId(id)}>{t("daemonsSettings.revoke")}</button>
              ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
