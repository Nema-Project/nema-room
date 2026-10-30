import { useCallback, useEffect, useRef, useState } from "react";
import {
  ATTACHMENT_LIMITS,
  sniffAttachment,
  type AttachmentCapabilities,
  type AttachmentKind,
  type AttachmentView,
  type SniffResult,
} from "@nema/shared";
import { attachmentCapabilities, uploadAttachment } from "@/lib/hub";

/** The largest file any kind accepts. Anything bigger is refused before it is read into memory. */
export const MAX_ATTACHMENT_BYTES = Math.max(ATTACHMENT_LIMITS.imageBytes, ATTACHMENT_LIMITS.pdfBytes, ATTACHMENT_LIMITS.textBytes);

/**
 * The same check the hub makes, run in the browser so a file it would refuse is never uploaded.
 * The hub still decides; this only saves the round trip.
 */
export async function precheckFile(file: File): Promise<SniffResult> {
  if (file.size === 0) return { ok: false, reason: "empty" };
  if (file.size > MAX_ATTACHMENT_BYTES) return { ok: false, reason: "too_large" };
  return sniffAttachment(new Uint8Array(await file.arrayBuffer()), file.name);
}

/** D-2: only native support, or text support for text files, reaches the agent. */
export function isDeliverable(caps: AttachmentCapabilities, kind: AttachmentKind): boolean {
  const support = caps[kind];
  return support === "native" || (support === "text" && kind === "text");
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`;
}

export type CapabilityState =
  | { state: "loading" }
  /** The hub has no attachment route: the composer shows no attachment entry. */
  | { state: "absent" }
  /** The daemon is offline or answered badly: attachments are allowed and the daemon checks them. */
  | { state: "unavailable" }
  | { state: "ok"; caps: AttachmentCapabilities };

export type TrayItem = {
  /** Also the upload key: made once per picked file and reused on retries. */
  key: string;
  file: File;
  name: string;
  size: number;
  kind: AttachmentKind;
  /** blob: URL of an image preview, revoked when the item leaves the tray. */
  previewUrl: string | null;
  state: "uploading" | "ready" | "failed";
  view: AttachmentView | null;
  error: string | null;
};

/** Why a picked file was not added. Rendered as `attach.reject.<reason>`. */
export type Notice = { reason: Exclude<SniffResult, { ok: true }>["reason"] | "too_many" | "total_too_large"; name: string };

/** Why the message cannot be sent yet, or null when it can. */
export function trayBlocker(items: readonly TrayItem[], caps: CapabilityState): "uploading" | "failed" | "unsupported" | null {
  if (items.some((i) => i.state === "uploading")) return "uploading";
  if (items.some((i) => i.state === "failed")) return "failed";
  if (caps.state === "ok" && items.some((i) => !isDeliverable(caps.caps, i.kind))) return "unsupported";
  return null;
}

/** A v4 UUID. randomUUID needs a secure context, so plain-HTTP hosts fall back to getRandomValues. */
export function newUploadKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function previewFor(file: File, kind: AttachmentKind): string | null {
  if (kind !== "image" || typeof URL.createObjectURL !== "function") return null;
  return URL.createObjectURL(file);
}

function revoke(item: TrayItem) {
  if (item.previewUrl && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(item.previewUrl);
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The composer's attachment tray: capability lookup, pre-checks, uploads, retries, and cleanup. */
export function useAttachmentTray(workspaceId: string | undefined) {
  const [caps, setCaps] = useState<CapabilityState>({ state: workspaceId ? "loading" : "absent" });
  const [items, setItems] = useState<TrayItem[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const itemsRef = useRef<TrayItem[]>([]);
  const capsVersion = useRef(0);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const loadCaps = useCallback(async () => {
    if (!workspaceId) return;
    const mine = ++capsVersion.current;
    let next: CapabilityState;
    try {
      const found = await attachmentCapabilities();
      next = found ? { state: "ok", caps: found } : { state: "absent" };
    } catch {
      next = { state: "unavailable" };
    }
    if (mine === capsVersion.current) setCaps(next);
  }, [workspaceId]);

  useEffect(() => {
    void loadCaps();
  }, [loadCaps]);

  // Attachments are staged in one workspace; switching workspaces starts an empty tray.
  useEffect(() => {
    return () => {
      for (const item of itemsRef.current) revoke(item);
      itemsRef.current = [];
      setItems([]);
      setNotices([]);
    };
  }, [workspaceId]);

  const upload = useCallback(
    async (item: TrayItem) => {
      if (!workspaceId) return;
      const update = (patch: Partial<TrayItem>) => setItems((cur) => cur.map((i) => (i.key === item.key ? { ...i, ...patch } : i)));
      update({ state: "uploading", error: null });
      try {
        const view = await uploadAttachment(workspaceId, item.file, item.key);
        update({ state: "ready", view, name: view.name, kind: view.kind, size: view.size });
      } catch (e) {
        update({ state: "failed", error: message(e) });
      }
    },
    [workspaceId],
  );

  const add = useCallback(
    async (files: readonly File[]) => {
      if (!workspaceId || files.length === 0) return;
      void loadCaps(); // the adapter may have changed since the composer opened
      const rejected: Notice[] = [];
      const accepted: TrayItem[] = [];
      let count = itemsRef.current.length;
      let total = itemsRef.current.reduce((sum, i) => sum + i.size, 0);
      for (const file of files) {
        const checked = await precheckFile(file);
        if (!checked.ok) {
          rejected.push({ reason: checked.reason, name: file.name });
          continue;
        }
        if (count + 1 > ATTACHMENT_LIMITS.perTaskCount) {
          rejected.push({ reason: "too_many", name: file.name });
          continue;
        }
        if (total + file.size > ATTACHMENT_LIMITS.perTaskBytes) {
          rejected.push({ reason: "total_too_large", name: file.name });
          continue;
        }
        count += 1;
        total += file.size;
        accepted.push({
          key: newUploadKey(), file, name: file.name, size: file.size, kind: checked.kind, previewUrl: previewFor(file, checked.kind),
          state: "uploading", view: null, error: null,
        });
      }
      setNotices(rejected);
      if (accepted.length === 0) return;
      itemsRef.current = [...itemsRef.current, ...accepted];
      setItems((cur) => [...cur, ...accepted]);
      for (const item of accepted) void upload(item);
    },
    [workspaceId, loadCaps, upload],
  );

  const remove = useCallback((key: string) => {
    const item = itemsRef.current.find((i) => i.key === key);
    if (item) revoke(item);
    itemsRef.current = itemsRef.current.filter((i) => i.key !== key);
    setItems((cur) => cur.filter((i) => i.key !== key));
  }, []);

  const retry = useCallback(
    (key: string) => {
      const item = itemsRef.current.find((i) => i.key === key);
      if (item && item.state === "failed") void upload(item);
    },
    [upload],
  );

  /** Drop the items that went out with a sent message. */
  const clear = useCallback((keys: readonly string[]) => {
    const gone = new Set(keys);
    for (const item of itemsRef.current) if (gone.has(item.key)) revoke(item);
    itemsRef.current = itemsRef.current.filter((i) => !gone.has(i.key));
    setItems((cur) => cur.filter((i) => !gone.has(i.key)));
    setNotices([]);
  }, []);

  const ready = items.filter((i) => i.state === "ready" && i.view);
  return {
    caps,
    /** Whether the composer offers attachments at all. */
    enabled: Boolean(workspaceId) && (caps.state === "ok" || caps.state === "unavailable"),
    items,
    notices,
    blocker: trayBlocker(items, caps),
    ready: ready.map((i) => ({ key: i.key, id: i.view!.id })),
    add,
    remove,
    retry,
    clear,
  };
}
