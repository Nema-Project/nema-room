export type ThreadWindowHost = { open: (workspaceId: string, threadId: string, messageId?: string) => void };

export function threadUrl(workspaceId: string, threadId: string, messageId?: string) {
  const path = `/w/${encodeURIComponent(workspaceId)}/t/${encodeURIComponent(threadId)}`;
  return messageId ? `${path}?messageId=${encodeURIComponent(messageId)}` : path;
}

export function mainMessageUrl(workspaceId: string, messageId: string) {
  return `/w/${encodeURIComponent(workspaceId)}#workspace=${encodeURIComponent(workspaceId)}&message=${encodeURIComponent(messageId)}`;
}

export function openThread(workspaceId: string, threadId: string, host: ThreadWindowHost, messageId?: string) {
  if (typeof window !== "undefined" && "nemaWindowControls" in window) window.open(threadUrl(workspaceId, threadId, messageId), "_blank");
  else if (messageId) host.open(workspaceId, threadId, messageId);
  else host.open(workspaceId, threadId);
}
