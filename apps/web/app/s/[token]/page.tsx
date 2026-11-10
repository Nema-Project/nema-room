import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { ShareUnavailable, ShareView, type ShareListEntry } from "@/components/ShareView";
import { fetchShare } from "@/lib/shareHub";
import { SHARE_PEER_HEADER, sharePeerDecision } from "@/lib/sharePeer";

export const dynamic = "force-dynamic";

function isList(body: unknown): body is { workspaceName: string; entries: ShareListEntry[] } {
  if (!body || typeof body !== "object") return false;
  const value = body as { workspaceName?: unknown; entries?: unknown };
  return typeof value.workspaceName === "string" && Array.isArray(value.entries);
}

export default async function ShareListPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const headerList = await headers();
  if (sharePeerDecision(headerList.get(SHARE_PEER_HEADER), headerList) === "reject") notFound();
  const result = await fetchShare("list", token);
  if (result.status === 404) notFound();
  if (result.status !== 200 || !isList(result.body)) return <ShareUnavailable temporary />;
  return <ShareView token={token} workspaceName={result.body.workspaceName} entries={result.body.entries} />;
}
