import type { GetServerSidePropsContext, GetServerSidePropsResult } from "next";
import type { ShareEntryView, ShareListEntry } from "@/components/ShareView";
import { fetchShare } from "./shareHub";
import { SHARE_PEER_HEADER, headersForSharePage, sharePagePeerDecision } from "./sharePeer";

export type SharePageProps = {
  token: string;
  workspaceName: string;
  entries: ShareListEntry[];
  entry?: ShareEntryView;
  temporary?: boolean;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSummary(value: unknown): value is ShareListEntry {
  if (!record(value) || typeof value.id !== "string" || typeof value.title !== "string") return false;
  for (const key of ["status", "implementationStatus"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") return false;
  }
  if (value.basis != null && typeof value.basis !== "string") return false;
  if (value.confirmedAt != null && typeof value.confirmedAt !== "string") return false;
  for (const key of ["implementationAccepted", "implementationInferred"]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") return false;
  }
  if (value.workpackage !== undefined) {
    const wp = value.workpackage;
    if (!record(wp) || (wp.blockedOn !== null && typeof wp.blockedOn !== "string") || typeof wp.taskCount !== "number") return false;
    if (wp.tasks !== undefined && (!Array.isArray(wp.tasks) || !wp.tasks.every((task: unknown) =>
      record(task) && typeof task.n === "number" && typeof task.title === "string" &&
      typeof task.status === "string" && typeof task.inferred === "boolean"))) return false;
  }
  return true;
}

function isList(value: unknown): value is { workspaceName: string; entries: ShareListEntry[] } {
  return record(value) && typeof value.workspaceName === "string" && Array.isArray(value.entries) && value.entries.every(isSummary);
}

function isEntry(value: unknown): value is ShareEntryView {
  if (!record(value)) return false;
  const quotes = value.quotes;
  return isSummary(value) && typeof value.body === "string" &&
    Array.isArray(quotes) && quotes.every((quote: unknown) => record(quote) && typeof quote.text === "string");
}

/** Pages Router owns the response status before SSR starts; no streamed 200 error page. */
export async function loadSharePage(context: GetServerSidePropsContext): Promise<GetServerSidePropsResult<SharePageProps>> {
  const { req, res, params } = context;
  res.setHeader("Cache-Control", "no-store");
  const peer = req.headers[SHARE_PEER_HEADER];
  if (Array.isArray(peer) || sharePagePeerDecision(peer, headersForSharePage(req.headers), req.socket.remoteAddress) === "reject") return { notFound: true };
  const token = typeof params?.token === "string" ? params.token : "";
  const eid = typeof params?.eid === "string" ? params.eid : undefined;
  const [list, entry] = await Promise.all([fetchShare("list", token), eid ? fetchShare("entry", token, eid) : undefined]);
  if (list.status === 404 || entry?.status === 404) return { notFound: true };
  if (list.status !== 200 || !isList(list.body) || (entry && (entry.status !== 200 || !isEntry(entry.body)))) {
    res.statusCode = 503;
    return { props: { token, workspaceName: "", entries: [], temporary: true } };
  }
  return { props: { token, ...list.body, ...(entry ? { entry: entry.body as ShareEntryView } : {}) } };
}
