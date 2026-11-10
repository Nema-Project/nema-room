"use client";

import { useParams, useSearchParams } from "next/navigation";
import { ThreadView } from "@/components/ThreadView";

export default function ThreadPage() {
  const params = useParams<{ id: string; tid: string }>();
  const search = useSearchParams();
  return <ThreadView key={`${params.id}:${params.tid}`} workspaceId={params.id} threadId={params.tid} focusMessageId={search.get("messageId") ?? undefined} />;
}
