"use client";

import { ATTACHMENT_LIMITS, type AttachmentKind } from "@nema/shared";
import { formatBytes, isDeliverable, type CapabilityState, type Notice, type TrayItem } from "@/lib/attachments";
import { useT } from "@/lib/i18n";

const LIMIT: Record<AttachmentKind, number> = {
  image: ATTACHMENT_LIMITS.imageBytes,
  pdf: ATTACHMENT_LIMITS.pdfBytes,
  text: ATTACHMENT_LIMITS.textBytes,
};

/** Files picked for the next message: previews, upload state, and why one cannot go to the agent. */
export function AttachmentTray({
  items,
  caps,
  notices,
  onRemove,
  onRetry,
}: {
  items: readonly TrayItem[];
  caps: CapabilityState;
  notices: readonly Notice[];
  onRemove: (key: string) => void;
  onRetry: (key: string) => void;
}) {
  const t = useT();
  if (items.length === 0 && notices.length === 0) return null;
  const limits = {
    image: formatBytes(LIMIT.image),
    pdf: formatBytes(LIMIT.pdf),
    text: formatBytes(LIMIT.text),
    count: ATTACHMENT_LIMITS.perTaskCount,
    total: formatBytes(ATTACHMENT_LIMITS.perTaskBytes),
  };
  return (
    <div className="att-tray">
      {notices.length > 0 && (
        <div className="att-notices" role="alert">
          {notices.map((n, i) => (
            <p key={`${n.name}:${i}`}>{t(`attach.reject.${n.reason}`, { name: n.name, ...limits })}</p>
          ))}
        </div>
      )}
      {items.length > 0 && (
        <ul className="att-items">
          {items.map((item) => {
            const support = caps.state === "ok" ? caps.caps[item.kind] : null;
            const blocked = caps.state === "ok" && !isDeliverable(caps.caps, item.kind);
            return (
              <li key={item.key} className={`att-item att-${item.state}${blocked ? " att-blocked" : ""}`}>
                {/* eslint-disable-next-line @next/next/no-img-element -- a local blob: preview, which next/image cannot load */}
                {item.previewUrl ? <img className="att-thumb" src={item.previewUrl} alt={item.name} /> : <span className="att-icon">{t(`attach.kind.${item.kind}`)}</span>}
                <span className="att-meta">
                  <span className="att-name">{item.name}</span>
                  <span className="att-size">{formatBytes(item.size)}</span>
                </span>
                {item.state === "uploading" && (
                  <span className="att-progress">
                    <progress aria-label={t("attach.uploadingName", { name: item.name })} />
                    {t("attach.uploading")}
                  </span>
                )}
                {item.state === "failed" && (
                  <>
                    <span className="att-error">{t("attach.uploadFailed", { message: item.error ?? "" })}</span>
                    <button type="button" className="att-retry" aria-label={t("attach.retryName", { name: item.name })} onClick={() => onRetry(item.key)}>
                      {t("attach.retry")}
                    </button>
                  </>
                )}
                <button type="button" className="att-remove" aria-label={t("attach.removeName", { name: item.name })} onClick={() => onRemove(item.key)}>
                  ×
                </button>
                {blocked && caps.state === "ok" && (
                  <p className="att-warn">
                    {t(support === "unsupported" ? "attach.unsupported" : "attach.unknown", {
                      adapter: caps.caps.adapter,
                      kind: t(`attach.kindName.${item.kind}`),
                      name: item.name,
                    })}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {items.length > 0 && caps.state === "unavailable" && <p className="att-note">{t("attach.capsUnavailable")}</p>}
    </div>
  );
}
