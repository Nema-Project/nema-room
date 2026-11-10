import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { ShareUnavailable, ShareView, type ShareEntryView, type ShareListEntry } from "@/components/ShareView";
import { fetchShare } from "@/lib/shareHub";
import { SHARE_PEER_HEADER, sharePeerDecision } from "@/lib/sharePeer";

export const dynamic = "force-dynamic";

function isEntry(body: unknown): body is ShareEntryView {
  if (!body || typeof body !== "object") return false;
  const value = body as { id?: unknown; title?: unknown; body?: unknown };
  return typeof value.id === "string" && typeof value.title === "string" && typeof value.body === "string";
}

export default async function ShareEntryPage({ params }: { params: Promise<{ token: string; eid: string }> }) {
  const { token, eid } = await params;
  const headerList = await headers();
  if (sharePeerDecision(headerList.get(SHARE_PEER_HEADER), headerList) === "reject") notFound();
  const [list, entry] = await Promise.all([fetchShare("list", token), fetchShare("entry", token, eid)]);
  if (list.status === 404 || entry.status === 404) notFound();
  if (list.status !== 200 || entry.status !== 200 || !isEntry(entry.body)) return <ShareUnavailable temporary />;
  const listed = list.body as { workspaceName?: unknown; entries?: ShareListEntry[] };
  const entries = Array.isArray(listed.entries) ? listed.entries : [entry.body];
  const workspaceName = typeof listed.workspaceName === "string" ? listed.workspaceName : "";
  return <ShareView token={token} workspaceName={workspaceName} entries={entries} entry={{ ...entry.body, quotes: entry.body.quotes ?? [] }} />;
}
