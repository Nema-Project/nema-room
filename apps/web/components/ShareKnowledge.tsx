"use client";

import { useEffect, useRef, useState } from "react";
import { createShare, listShares, revokeShare, type KnowledgeShare } from "@/lib/hub";
import { useT } from "@/lib/i18n";

function failureText(error: unknown, disabled: string, down: string): string {
  if (typeof error === "object" && error !== null && "status" in error && (error as { status: unknown }).status === 403) return disabled;
  return down;
}

export function ShareKnowledge({ workspaceId, confidential, archived }: { workspaceId: string; confidential: boolean; archived: boolean }) {
  const t = useT();
  const [shares, setShares] = useState<KnowledgeShare[]>([]);
  const [note, setNote] = useState("");
  const [expires, setExpires] = useState("");
  const [freshUrl, setFreshUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const mutationEpoch = useRef(0);
  const [serverDisabled, setServerDisabled] = useState(false);
  const blocked = confidential || archived || serverDisabled;

  useEffect(() => {
    let cancelled = false;
    // A completed mutation makes any earlier list snapshot stale, including errors.
    const epoch = mutationEpoch.current;
    listShares(workspaceId).then(
      (result) => { if (!cancelled && epoch === mutationEpoch.current) setShares(result.shares); },
      (reason: unknown) => { if (!cancelled && epoch === mutationEpoch.current) setError(failureText(reason, t("share.disabled"), t("share.down"))); },
    );
    return () => { cancelled = true; };
  }, [workspaceId, t]);

  async function onCreate() {
    if (creatingRef.current || blocked) return;
    creatingRef.current = true;
    setCreating(true);
    try {
      setError(null);
      const body: { note?: string; expiresAt?: string | null } = {};
      const trimmed = note.trim();
      if (trimmed) body.note = trimmed;
      if (expires) {
        const parsed = new Date(`${expires}T23:59:59`);
        if (Number.isNaN(parsed.getTime())) {
          setError(t("share.down"));
          return;
        }
        body.expiresAt = parsed.toISOString();
      }
      const created = await createShare(workspaceId, body);
      mutationEpoch.current += 1;
      setFreshUrl(`${location.origin}/s/${created.token}`);
      setShares((current) => [{
        id: created.id,
        note: created.note,
        expiresAt: created.expiresAt,
        revokedAt: null,
        createdAt: created.createdAt,
      }, ...current.filter((share) => share.id !== created.id)]);
      setNote("");
      setExpires("");
    } catch (reason) {
      if (typeof reason === "object" && reason !== null && "status" in reason && reason.status === 403) {
        mutationEpoch.current += 1;
        setServerDisabled(true);
      }
      setError(failureText(reason, t("share.disabled"), t("share.down")));
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }

  async function onRevoke(shareId: string) {
    setError(null);
    try {
      const revoked = await revokeShare(workspaceId, shareId);
      mutationEpoch.current += 1;
      setShares((current) => current.map((share) => share.id === shareId ? revoked : share));
    } catch (reason) {
      if (typeof reason === "object" && reason !== null && "status" in reason && reason.status === 403) {
        mutationEpoch.current += 1;
        setServerDisabled(true);
      }
      setError(failureText(reason, t("share.disabled"), t("share.down")));
    }
  }

  async function onCopy() {
    if (!freshUrl) return;
    try {
      await navigator.clipboard.writeText(freshUrl);
    } catch {
      /* The readonly field keeps the link when the clipboard is unavailable. */
    }
  }

  return (
    <section className="settings-group">
      <h2>{t("share.heading")}</h2>
      <p className="help">{t("share.help")}</p>
      {confidential && <p className="help">{t("share.confidential")}</p>}
      {archived && !confidential && <p className="help">{t("share.archived")}</p>}
      <label className="field">
        <span className="label">{t("share.note")}</span>
        <input type="text" value={note} onChange={(event) => setNote(event.target.value)} disabled={blocked} />
      </label>
      <label className="field">
        <span className="label">{t("share.expires")}</span>
        <input type="date" value={expires} onChange={(event) => setExpires(event.target.value)} disabled={blocked} />
      </label>
      <button type="button" className="settings-action" onClick={() => void onCreate()} disabled={blocked || creating}>{t("share.create")}</button>
      {freshUrl && (
        <div className="field">
          <p className="help">{t("share.shownOnce")}</p>
          <input type="text" readOnly value={freshUrl} aria-label={t("share.heading")} />
          <button type="button" className="settings-action" onClick={() => void onCopy()}>{t("share.copy")}</button>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <ul>
        {shares.map((share) => (
          <li key={share.id}>
            <span>{t("share.identifier", { id: share.id.slice(-9) })}</span>{" "}
            <span>{t("share.createdAt")}: <time dateTime={share.createdAt}>{share.createdAt}</time></span>{" "}
            {share.note && <span>{share.note}</span>}
            {share.expiresAt && <span>{share.expiresAt}</span>}
            {share.revokedAt
              ? <span>{t("share.revoked")}</span>
              : <button type="button" className="settings-action" onClick={() => void onRevoke(share.id)}>{t("share.revoke")}</button>}
          </li>
        ))}
      </ul>
    </section>
  );
}
