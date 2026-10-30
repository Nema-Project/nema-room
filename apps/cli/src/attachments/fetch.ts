import { createHash } from "node:crypto";
import type { AttachmentCapabilities, AttachmentRef, TaskAssign } from "@nema/shared";
import { RoomClient } from "../room/client.js";
import { refusal } from "./capabilities.js";

export type LoadedAttachment = AttachmentRef & { bytes: Buffer };

function failure(ref: AttachmentRef, status: number, error: string): Error {
  if (status === 404) return new Error(`附件「${ref.name}」不在本次任务的附件范围内，无法读取`);
  if (status === 410) return new Error(`附件「${ref.name}」已被删除或文件已丢失，任务没有继续`);
  return new Error(`无法读取附件「${ref.name}」：${error}`);
}

/**
 * Fetches each attachment of the task with the run token, in order, and checks it against the hub's
 * record. Errors name the file, never its content. Stops at the first failure.
 */
export async function fetchAttachments(client: RoomClient, refs: readonly AttachmentRef[]): Promise<LoadedAttachment[]> {
  const loaded: LoadedAttachment[] = [];
  for (const ref of refs) {
    const r = await client.fetchAttachment(ref.id, ref.size);
    if (!r.ok) throw failure(ref, r.status, r.error);
    if (r.bytes.length !== ref.size) throw new Error(`附件「${ref.name}」的大小与记录不符（${r.bytes.length} ≠ ${ref.size} 字节）`);
    const digest = createHash("sha256").update(r.bytes).digest("hex");
    if (digest !== ref.sha256) throw new Error(`附件「${ref.name}」的内容与记录不符（sha256 不一致）`);
    loaded.push({ ...ref, bytes: r.bytes });
  }
  return loaded;
}

/**
 * What an adapter does first with a task's attachments: refuse (D-2 A) before any network or launch when
 * a kind is not deliverable, otherwise fetch and verify them. No attachments is `[]` with no hub call.
 */
export async function loadTaskAttachments(
  task: Pick<TaskAssign, "attachments" | "hubUrl" | "runToken">,
  caps: AttachmentCapabilities,
  signal?: AbortSignal,
): Promise<{ ok: true; attachments: LoadedAttachment[] } | { ok: false; error: string }> {
  const refs = task.attachments ?? [];
  if (refs.length === 0) return { ok: true, attachments: [] };
  const refused = refusal(caps, refs);
  if (refused) return { ok: false, error: refused };
  try {
    return { ok: true, attachments: await fetchAttachments(new RoomClient(task.hubUrl, task.runToken, signal), refs) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
