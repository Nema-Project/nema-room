import type {
  EntryListItem,
  Entry,
  EntrySummary,
  HistoryItem,
  Message,
  ParagraphBlame,
  PluginCatalogItem,
  Repo,
  Task,
  UpsertEntryInput,
  Workspace,
  WorkspacePlugin,
  WorkPackage,
  WorkspaceView,
} from "./types";

/** Set at build time for the managed local desktop build; its UI and API share one origin. */
export const LOCAL_HUB_MODE = process.env.NEXT_PUBLIC_NEMA_LOCAL === "1";
export const HUB_URL = LOCAL_HUB_MODE ? "" : process.env.NEXT_PUBLIC_HUB_URL ?? "http://127.0.0.1:4400";
const BASE = LOCAL_HUB_MODE ? "/api" : `${HUB_URL}/api`;

export class HubError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: { method: string; body?: unknown }): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: init?.method ?? "GET",
    headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  if (!res.ok) {
    let message = `hub request failed (${res.status})`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) message = j.error;
    } catch {
      /* non-JSON error body */
    }
    throw new HubError(res.status, message);
  }
  return (await res.json()) as T;
}

const w = (id: string) => `/workspaces/${encodeURIComponent(id)}`;
const e = (id: string, eid: string) => `${w(id)}/entries/${encodeURIComponent(eid)}`;

export const getDaemonStatus = () => request<{ connected: boolean }>("/daemon/status");
export const listWorkspaces = () => request<WorkspaceView[]>("/workspaces");
export const createWorkspace = (name: string) => request<Workspace>("/workspaces", { method: "POST", body: { name } });
export const updateWorkspace = (id: string, patch: Partial<Pick<Workspace, "name" | "confidential" | "knowledgeLanguage">>) =>
  request<Workspace>(w(id), { method: "PATCH", body: patch });
export const archiveWorkspace = (id: string, archived: boolean) => request<Workspace>(w(id), { method: "PATCH", body: { archived } });
export const deleteWorkspace = (id: string) => request<void>(w(id), { method: "DELETE" });
export const listMessages = (id: string) => request<Message[]>(`${w(id)}/messages`);
export const postMessage = (id: string, content: string) =>
  request<{ message: Message; task: Task }>(`${w(id)}/messages`, { method: "POST", body: { content } });
export const getActiveTask = (id: string) => request<{ running: Task | null }>(`${w(id)}/tasks/active`);
export const listEntries = (id: string) => request<EntryListItem[]>(`${w(id)}/entries`);
export const getEntry = (id: string, eid: string) => request<Entry>(e(id, eid));
export const putEntry = (id: string, eid: string, input: Omit<UpsertEntryInput, "id">) =>
  request<Entry>(e(id, eid), { method: "PUT", body: input });
export const confirmEntry = (id: string, eid: string) => request<Entry>(`${e(id, eid)}/confirm`, { method: "POST", body: {} });
/** The user's own confirm that a reported or mismatched requirement is implemented; the hub sets it to verified. */
export const confirmImplementation = (id: string, eid: string) =>
  request<Entry>(`${e(id, eid)}/implementation/confirm`, { method: "POST", body: {} });
export const getHistory = (id: string, eid: string) => request<HistoryItem[]>(`${e(id, eid)}/history`);
export const getVersion = (id: string, eid: string, commit: string) => request<Entry>(`${e(id, eid)}/versions/${encodeURIComponent(commit)}`);
export const getWhy = (id: string, eid: string) => request<ParagraphBlame[]>(`${e(id, eid)}/why`);
export const getTimeline = (id: string) => request<EntrySummary[]>(`${w(id)}/timeline`);
/** The hub renders a diagram's stored spec as standalone HTML; it is opened in its own window. */
export const diagramHtmlUrl = (id: string, gid: string) => `${BASE}${w(id)}/diagrams/${encodeURIComponent(gid)}.html`;
export const updateDiagram = (id: string, gid: string) =>
  request<{ message: Message; task: Task }>(`${w(id)}/diagrams/${encodeURIComponent(gid)}/update`, { method: "POST", body: {} });
export const eventsUrl = (id: string) => `${BASE}${w(id)}/events`;

export const listPlugins = () => request<PluginCatalogItem[]>("/plugins");
export const listRepos = (id: string) => request<Repo[]>(`${w(id)}/repos`);
export const bindRepo = (id: string, body: { path: string; label: string; mainBranch?: string }) =>
  request<Repo>(`${w(id)}/repos`, { method: "POST", body });
export const updateRepo = (id: string, repoId: string, patch: { label?: string; mainBranch?: string }) =>
  request<Repo>(`${w(id)}/repos/${encodeURIComponent(repoId)}`, { method: "PATCH", body: patch });
export const unbindRepo = (id: string, repoId: string) => request<void>(`${w(id)}/repos/${encodeURIComponent(repoId)}`, { method: "DELETE" });
export const listWorkspacePlugins = (id: string) => request<WorkspacePlugin[]>(`${w(id)}/plugins`);
export const updateWorkspacePlugin = (id: string, pluginId: string, patch: { enabled?: boolean; disabledFunctions?: string[]; settings?: Record<string, unknown> }) =>
  request<WorkspacePlugin>(`${w(id)}/plugins/${encodeURIComponent(pluginId)}`, { method: "PATCH", body: patch });

const wp = (id: string, wid: string) => `${w(id)}/workpackages/${encodeURIComponent(wid)}`;
export const requestWorkPackage = (id: string, requirements: string[]) =>
  request<Entry>(`${w(id)}/workpackages`, { method: "POST", body: { requirements } });
export const getWorkPackage = (id: string, wid: string) => request<WorkPackage>(wp(id, wid));
export const approveWorkPackage = (id: string, wid: string) => request<Entry>(`${wp(id, wid)}/approve`, { method: "POST", body: {} });
export const saveWorkPackageDoc = (id: string, wid: string, which: "spec" | "plan", markdown: string) =>
  request<Entry>(`${wp(id, wid)}/${which}`, { method: "PUT", body: { markdown } });
export const regenerateWorkPackage = (id: string, wid: string) => request<{ ok: true }>(`${wp(id, wid)}/regenerate`, { method: "POST", body: {} });
export const dropWorkPackage = (id: string, wid: string) => request<Entry>(`${wp(id, wid)}/drop`, { method: "POST", body: {} });
export const confirmWorkPackageTask = (id: string, wid: string, n: number) =>
  request<Entry>(`${wp(id, wid)}/tasks/${n}/confirm`, { method: "POST", body: {} });
