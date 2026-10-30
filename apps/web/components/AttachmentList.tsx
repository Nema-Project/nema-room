"use client";

import { useEffect, useRef, useState } from "react";
import type { AttachmentView } from "@nema/shared";
import { formatBytes } from "@/lib/attachments";
import { formatDay, formatTime } from "@/lib/format";
import { deleteAttachment, fetchAttachmentBlob, getMessage } from "@/lib/hub";
import { useLocale, useT } from "@/lib/i18n";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const viewable = (a: AttachmentView) => a.status === "attached" || a.status === "staged";

/**
 * The hub answers 410 when the bytes are gone: deleted (possibly by another window, or by a delete whose
 * file removal failed after the tombstone was committed) or missing on disk. The card follows suit
 * instead of offering a download that cannot work.
 */
function goneAs(a: AttachmentView, e: unknown): AttachmentView | null {
  if ((e as { status?: unknown } | null)?.status !== 410) return null;
  return /deleted/i.test(message(e)) ? { ...a, status: "deleted" } : { ...a, status: "missing" };
}

/**
 * The hub's own record of this attachment, read from its message. Used after a 410 (for the real
 * deletion time) and after a failed delete (the tombstone may be committed even though the request
 * failed while removing the file). Null when it cannot be read.
 */
async function hubView(workspaceId: string, a: AttachmentView): Promise<AttachmentView | null> {
  if (!a.messageId) return null;
  try {
    const m = await getMessage(workspaceId, a.messageId);
    return m.attachments?.find((x) => x.id === a.id) ?? null;
  } catch {
    return null;
  }
}

/** A 410 answer: show the guess at once, then the hub's record (with its deletion time) once read. */
function reportGone(workspaceId: string, guess: AttachmentView, report: (next: AttachmentView) => void) {
  report(guess);
  void hubView(workspaceId, guess).then((v) => {
    if (v && (v.status === "deleted" || v.status === "missing")) report(v);
  });
}

/** Save the attachment's bytes under its name. The hub URL is fetched, never linked. */
async function download(workspaceId: string, a: AttachmentView) {
  const url = URL.createObjectURL(await fetchAttachmentBlob(workspaceId, a.id));
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = a.name;
    link.click();
  } finally {
    // Some browsers read the URL after the click returns; give them time before letting go of it.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

/** An image attachment's thumbnail, loaded through fetch so the hub address never lands in <img src>. */
function Thumbnail({ workspaceId, attachment, onGone }: { workspaceId: string; attachment: AttachmentView; onGone: (next: AttachmentView) => void }) {
  const t = useT();
  const [state, setState] = useState<{ url: string | null; error: string | null }>({ url: null, error: null });
  // A long chat mounts every message; fetch a thumbnail only once it comes near the viewport.
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  const placeholder = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (near || !placeholder.current) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setNear(true);
        io.disconnect();
      }
    }, { rootMargin: "200px" });
    io.observe(placeholder.current);
    return () => io.disconnect();
  }, [near]);
  const goneRef = useRef(onGone);
  useEffect(() => { goneRef.current = onGone; });
  useEffect(() => {
    if (!near) return;
    let url: string | null = null;
    let live = true;
    fetchAttachmentBlob(workspaceId, attachment.id).then(
      (blob) => {
        if (!live) return;
        url = URL.createObjectURL(blob);
        setState({ url, error: null });
      },
      (e) => {
        if (!live) return;
        const gone = goneAs(attachment, e);
        if (gone) reportGone(workspaceId, gone, (v) => goneRef.current(v));
        else setState({ url: null, error: message(e) });
      },
    );
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch per attachment, not per re-render of its view
  }, [workspaceId, attachment.id, near]);
  if (state.error) return <span className="att-error">{t("attach.loadFailed", { message: state.error })}</span>;
  if (!state.url) return <span ref={placeholder} className="att-icon">{t("attach.kind.image")}</span>;
  // eslint-disable-next-line @next/next/no-img-element -- a local blob: URL, which next/image cannot load
  return <img className="att-thumb" src={state.url} alt={attachment.name} />;
}

function Attachment({
  workspaceId,
  attachment: a,
  canDelete,
  onChange,
}: {
  workspaceId: string;
  attachment: AttachmentView;
  canDelete: boolean;
  /** `publish` is false for a local guess from a 410, which only changes this card. */
  onChange: (next: AttachmentView, publish: boolean) => void;
}) {
  const t = useT();
  const [locale] = useLocale();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      onChange(await deleteAttachment(workspaceId, a.id), true);
      setConfirming(false);
    } catch (e) {
      // The hub commits the tombstone before removing the file; if only the removal failed, the
      // attachment is deleted all the same, so show and publish that instead of an error.
      const v = await hubView(workspaceId, a);
      if (v?.status === "deleted") {
        onChange(v, true);
        setConfirming(false);
        return;
      }
      setError(t("attach.deleteFailed", { message: message(e) }));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setError(null);
    try {
      await download(workspaceId, a);
    } catch (e) {
      const gone = goneAs(a, e);
      if (gone) reportGone(workspaceId, gone, (v) => onChange(v, false));
      else setError(t("attach.loadFailed", { message: message(e) }));
    }
  }

  const meta = `${a.mime} · ${formatBytes(a.size)}`;
  if (a.status === "deleted") {
    const at = a.deletedAt ? new Date(a.deletedAt) : null;
    return (
      <li className="att-card att-gone">
        <b>{t("attach.deleted")}</b>
        <span className="att-name">{a.name}</span>
        <span className="att-size">{meta}</span>
        {at && a.deletedAt && <time dateTime={a.deletedAt}>{`${formatDay(at, locale)} ${formatTime(at, locale)}`}</time>}
        <code className="att-sha" title={a.sha256}>sha256 {a.sha256.slice(0, 12)}</code>
      </li>
    );
  }
  return (
    <li className={a.status === "missing" ? "att-card att-gone" : "att-card"}>
      {a.kind === "image" && viewable(a) ? <Thumbnail workspaceId={workspaceId} attachment={a} onGone={(next) => onChange(next, false)} /> : <span className="att-icon">{t(`attach.kind.${a.kind}`)}</span>}
      <span className="att-meta">
        <span className="att-name">{a.name}</span>
        <span className="att-size">{meta}</span>
        {a.status === "missing" && <b>{t("attach.missing")}</b>}
      </span>
      {viewable(a) && (
        <button type="button" className="quiet" aria-label={t("attach.downloadName", { name: a.name })} onClick={() => void save()}>
          {t("attach.download")}
        </button>
      )}
      {canDelete && !confirming && (
        <button type="button" className="quiet" aria-label={t("attach.deleteName", { name: a.name })} onClick={() => { setError(null); setConfirming(true); }}>
          {t("attach.delete")}
        </button>
      )}
      {confirming && (
        <span className="att-confirm">
          <span>{t("attach.deleteNote", { name: a.name })}</span>
          <button type="button" className="primary" disabled={busy} onClick={() => void remove()}>{t("attach.deleteConfirm")}</button>
          <button type="button" disabled={busy} onClick={() => setConfirming(false)}>{t("attach.deleteCancel")}</button>
        </span>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </li>
  );
}

/**
 * A message's attachments: image thumbnails, file cards with download, and tombstones for deleted
 * files (D-4). Deleting asks first, because what an agent or model already received stays there.
 */
export function AttachmentList({
  workspaceId,
  attachments,
  canDelete = false,
  onChange,
}: {
  workspaceId: string;
  attachments: readonly AttachmentView[];
  canDelete?: boolean;
  /**
   * Called with the tombstone the hub returned for one deleted attachment. Only that one view is
   * reported, so the owner merges it into its newest state rather than into a list captured when the
   * delete started.
   */
  onChange?: (next: AttachmentView) => void;
}) {
  const [replaced, setReplaced] = useState<ReadonlyMap<string, AttachmentView>>(new Map());
  if (attachments.length === 0) return null;
  const shown = attachments.map((a) => {
    const r = replaced.get(a.id);
    // A newer copy from the hub (an event or reload) wins over the local replacement.
    return r && a.status !== "deleted" ? r : a;
  });
  return (
    <ul className="att-list">
      {shown.map((a) => (
        <Attachment
          key={a.id}
          workspaceId={workspaceId}
          attachment={a}
          canDelete={canDelete && a.status !== "deleted"}
          onChange={(next, publish) => {
            setReplaced((cur) => new Map(cur).set(next.id, next));
            if (publish) onChange?.(next);
          }}
        />
      ))}
    </ul>
  );
}
