import type { AgentMessageMeta, AttachmentView, CodeParams, CodedText, ComponentFailureReason, GraphifyError, Implementation, KnowledgeLanguage, ReportMessageMeta, ReportPassState, RepoIndexFailureMeta, SystemNoticeMeta, Thread, UserMessageMeta, WpTask } from "@nema/shared";

export type { AgentMessageMeta, Entry, EntrySummary, Implementation, KnowledgeLanguage, MessageMention, MessageQuote, ReportCheck, ReportMessageMeta, RouteDecision, Thread, ThreadOpenedBy, UpsertEntryInput, UserMessageMeta, WorkPackageMeta, WpTask } from "@nema/shared";

/** A requirement implementation as the hub returns it: plus each cited report's pass state, derived on read. */
export type ImplementationView = Implementation & { evidence: Implementation["evidence"] & { reports?: ReportPassState[] } };
/** A work package task as the hub returns it: plus whether its report's check passed, derived on read. */
export type WpTaskView = WpTask & { reportPassed?: boolean };
/** An entry as the hub's read endpoints return it, with the derived pass-state fields. */
export type EntryView = Omit<import("@nema/shared").Entry, "implementation" | "workpackage"> & {
  implementation?: ImplementationView;
  workpackage?: import("@nema/shared").WorkPackageMeta & { tasks: WpTaskView[] };
};
/** An entry summary as the list and timeline endpoints return it, with the derived pass-state field. */
export type EntrySummaryView = Omit<import("@nema/shared").EntrySummary, "implementation"> & { implementation?: ImplementationView };

/** Wire shapes of apps/hub (JSON over REST/SSE). Kept here because the hub package is Node-only. */
export type Workspace = {
  id: string;
  name: string;
  confidential: boolean;
  knowledgeLanguage: KnowledgeLanguage;
  createdAt: string;
  archived: boolean;
};
export type WorkspaceView = Workspace & { openQuestions: number; attention?: number };

export type Message = {
  id: string;
  workspaceId: string;
  role: "user" | "agent" | "system" | "report";
  /** Who wrote a user message (#163). Null for older messages and every non-user role; absent from older hubs. */
  authorUserId?: string | null;
  content: string;
  /** A system message may add `notice` (#299 batch 2) to any of these; see `SystemNoticeMeta`. */
  meta: AgentMessageMeta | ReportMessageMeta | UserMessageMeta | RepoIndexFailureMeta | SystemNoticeMeta | null;
  taskId: string | null;
  createdAt: string;
  editedAt: string | null;
  threadId: string | null;
  seq: number;
  /** Files attached to a user message. Absent from hubs and events that predate attachments. */
  attachments?: AttachmentView[];
};

/** Why a queued task is still waiting (D-6), derived live by the hub; absent when no daemon-side reason applies. */
export type WaitingReason =
  | { kind: "no-daemon-online" }
  | { kind: "no-member-daemon"; onlineDaemons: number }
  | { kind: "repo-not-held"; missingRepos: string[] };

export type Task = {
  id: string;
  workspaceId: string;
  messageId: string;
  threadId: string | null;
  status: "queued" | "running" | "done" | "failed";
  error: string | null;
  waitingReason?: WaitingReason | null;
};

export type HubEvent =
  | { type: "message.created"; message: Message }
  | { type: "message.updated"; message: Message }
  | { type: "task.updated"; task: Task }
  | { type: "thread.updated"; thread: Thread }
  /** `text` is the fallback; `code`, `params` and `items` let `progressText` localise it (#299 batch 1). */
  | { type: "task.progress"; taskId: string; threadId: string | null; text: string; code?: string; params?: CodeParams; items?: CodedText[] }
  | { type: "knowledge.changed"; entryId: string }
  | { type: "daemon.status"; connected: boolean }
  | { type: "repo.index"; repoId: string; label: string; status: "running" | "done" | "failed" };

export type EntryListItem = EntrySummaryView & { isNew: boolean };

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
  /** Whether this repository's committed `.agents/skills` / `.claude/skills` are given to agents. */
  trustSkills: boolean;
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
  graphifyError?: GraphifyError;
  /** Only for plugins that need a login (GitHub): whether its token is saved. */
  loggedIn?: boolean;
};

/** Mirrors the daemon's component status (apps/cli/src/components/types.ts and rpc.ts). */
export type ComponentName = "graphify";

export type { ComponentFailureReason } from "@nema/shared";

export type ComponentProgress = {
  phase: "download" | "verify" | "extract" | "self-check" | "activate";
  downloadedBytes: number;
  totalBytes: number;
  file: string | null;
};

export type ComponentStatus =
  | { state: "installed"; name: ComponentName; lockHash: string; version: { graphifyy: string; python: string }; path: string; launcher: string; lastFailure?: { reason: ComponentFailureReason; detail: string; at: string } }
  | { state: "not-installed"; name: ComponentName; lockHash: string }
  | { state: "lock-mismatch"; name: ComponentName; lockHash: string; installedLockHash: string }
  | { state: "failed"; name: ComponentName; lockHash: string | null; reason: ComponentFailureReason; detail: string; at: string | null; installedLockHash?: string }
  | { state: "installing"; name: ComponentName; lockHash: string; progress: ComponentProgress };

export type ComponentSetting<T> = { value: T; source: "env" | "config" | null; config: T };

export type ComponentView = {
  name: ComponentName;
  status: ComponentStatus;
  /** What a confirmed install downloads: the lock's summed sizes, the store directory and the hosts it contacts. */
  offer: { lockHash: string; totalBytes: number; location: string; hosts: string[] } | null;
  offerError?: string;
  /** Set only on a cancel answer: whether the attempt it stopped really was cancelled (false when it had already completed). */
  cancelled?: boolean;
  settings: {
    pythonMirror: ComponentSetting<string | null>;
    pypiBase: ComponentSetting<string | null>;
    offline: ComponentSetting<boolean>;
  };
};

export type AgentCliStatus = {
  id: "codex" | "claude-code";
  command: string;
  installed: boolean;
  version: string | null;
  installUrl: string;
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
export type WorkPackage = { entry: EntryView; spec: string | null; plan: string | null };
