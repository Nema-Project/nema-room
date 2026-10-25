import type { AgentMessageMeta, KnowledgeLanguage, ReportMessageMeta, Thread, UserMessageMeta } from "@nema/shared";

export type { AgentMessageMeta, Entry, EntrySummary, Implementation, KnowledgeLanguage, MessageQuote, ReportCheck, ReportMessageMeta, Thread, ThreadOpenedBy, UpsertEntryInput, UserMessageMeta, WorkPackageMeta, WpTask } from "@nema/shared";

/** Wire shapes of apps/hub (JSON over REST/SSE). Kept here because the hub package is Node-only. */
export type Workspace = {
  id: string;
  name: string;
  confidential: boolean;
  knowledgeLanguage: KnowledgeLanguage;
  createdAt: string;
  archived: boolean;
};
export type WorkspaceView = Workspace & { openQuestions: number };

export type Message = {
  id: string;
  workspaceId: string;
  role: "user" | "agent" | "system" | "report";
  content: string;
  /** User messages may carry UserMessageMeta; agent messages carry AgentMessageMeta; report messages carry ReportMessageMeta. */
  meta: AgentMessageMeta | ReportMessageMeta | UserMessageMeta | null;
  taskId: string | null;
  createdAt: string;
  editedAt: string | null;
  threadId: string | null;
  seq: number;
};

export type Task = {
  id: string;
  workspaceId: string;
  messageId: string;
  status: "queued" | "running" | "done" | "failed";
  error: string | null;
};

export type HubEvent =
  | { type: "message.created"; message: Message }
  | { type: "message.updated"; message: Message }
  | { type: "task.updated"; task: Task }
  | { type: "thread.updated"; thread: Thread }
  | { type: "task.progress"; taskId: string; text: string }
  | { type: "knowledge.changed"; entryId: string }
  | { type: "daemon.status"; connected: boolean };

export type EntryListItem = import("@nema/shared").EntrySummary & { isNew: boolean };

export type HistoryItem = {
  version: number;
  commit: string;
  committedAt: string;
  op: "add" | "update" | "recover";
  reason: string;
  sourceMessages: string[];
  author: "agent" | "user" | "system";
  taskId?: string;
};

export type ParagraphBlame = { text: string; version: number; commit: string; reason: string; author: "agent" | "user" };

export type Repo = {
  id: string;
  workspaceId: string;
  path: string;
  gitCommonDir: string;
  label: string;
  mainBranch: string;
  hasOrigin: boolean;
  remoteUrl: string | null;
  /** The lowercased `owner/repo` of a github.com origin, or null when origin is not on GitHub. */
  githubTarget: string | null;
  lastMainSha: string | null;
  lastFetchAt: string | null;
  lastFetchError: string | null;
};

export type PluginFunctionView = {
  name: string;
  description: string;
  readOnly: boolean;
};

export type PluginCatalogItem = {
  id: string;
  displayName: string;
  dataFlow: "local" | "external";
  functions: PluginFunctionView[];
  installed: boolean;
  detail: string;
  /** Only for plugins that need a login (GitHub): whether its token is saved. */
  loggedIn?: boolean;
};

export type WorkspacePlugin = {
  plugin: {
    id: string;
    displayName: string;
    dataFlow: "local" | "external";
    functions: PluginFunctionView[];
  };
  enabled: boolean;
  disabledFunctions: string[];
  settings?: Record<string, unknown>;
};

/** A work package as the hub serves it: its entry plus the spec and plan Markdown (null until written). */
export type WorkPackage = { entry: import("@nema/shared").Entry; spec: string | null; plan: string | null };
