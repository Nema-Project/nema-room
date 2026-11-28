import { z } from "zod";
import { AttachmentRefSchema } from "./attachments.js";
import { RouteDecisionSchema, type RouteDecision } from "./route.js";
import type { CodeParams, CodedText } from "./errorCode.js";

const DaemonToHubSchema = z.union([
  z.object({
    type: z.literal("hello"),
    token: z.string(),
    version: z.string(),
    adapters: z.array(z.string()),
    /** sha256 hex of ~/.nema/report-token, sent when that file exists. */
    reportTokenHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    /** Optional abilities, e.g. "attachments". Older daemons send none. */
    features: z.array(z.string()).optional(),
    /**
     * Normalized remote URLs this daemon holds (D-6): the `remote_url` of every repo in its local index,
     * through `normalizeRemoteUrl`. Older daemons send none and are treated as holding nothing.
     */
    heldRepos: z.array(z.string()).optional(),
  }),
  /**
   * Refresh of the hello `heldRepos` set, sent after `repos.sync` changes what this daemon watches (D-6).
   * Same shape as the hello field, so the hub replaces the connection's held set wholesale.
   */
  z.object({
    type: z.literal("holdings"),
    heldRepos: z.array(z.string()),
  }),
  z.object({
    type: z.literal("task.event"),
    taskId: z.string(),
    /**
     * `text` is the fallback line. `code`, `params` and `items` let the UI show it in the user's language
     * (#299 batch 1); all optional and unvalidated here, so an older daemon's text-only event and a field this
     * hub cannot read both cost only the translation, never the event. The hub sanitises them before relaying.
     */
    event: z.object({
      type: z.enum(["progress", "agent_message", "tool_call"]),
      text: z.string(),
      code: z.unknown().optional(),
      params: z.unknown().optional(),
      items: z.unknown().optional(),
    }),
  }),
  z.object({
    type: z.literal("task.finished"),
    taskId: z.string(),
    ok: z.literal(true),
    reply: z.string(),
    /**
     * Which account and model answered, and why (spec 2026-10-31 §4.6). Optional: an older daemon sends
     * none, and the hub then stores the message without a route line.
     *
     * Deliberately unvalidated *here*. The route is metadata about the reply; a route this hub cannot read
     * must cost the route line, not the reply. Validating it inside this schema would fail the whole
     * message and drop an answer the user is waiting for. It is still validated strictly by
     * `parseRouteDecision` at the point it is stored, so nothing unknown reaches `messages.meta`.
     */
    route: z.unknown().optional(),
  }),
  z.object({
    type: z.literal("task.finished"),
    taskId: z.string(),
    ok: z.literal(false),
    error: z.string(),
    /**
     * Which account and model were running when the task failed. A failed task has no reply to carry the
     * record, and "which account failed" is the next question, so the hub folds it into the failure line.
     * Unvalidated here for the same reason as the success branch: the error text must survive a route the
     * hub cannot read.
     */
    route: z.unknown().optional(),
  }),
  z.object({ type: z.literal("rpc.response"), id: z.string(), ok: z.literal(true), result: z.unknown() }),
  /*
   * `error` is the fallback text. `code` and `params` (#299 batch 1) let the UI localise it; optional, and
   * unvalidated here for the same reason as `graphifyError`: a field this hub cannot read must cost the
   * translation, not the error. The hub reads them with `readCoded`.
   */
  z.object({
    type: z.literal("rpc.response"), id: z.string(), ok: z.literal(false), error: z.string(),
    graphifyError: z.unknown().optional(), code: z.unknown().optional(), params: z.unknown().optional(),
  }),
  z.object({ type: z.literal("repo.moved"), repoId: z.string(), mainRef: z.string(), from: z.string().nullable(), to: z.string() }),
  z.object({ type: z.literal("repo.fetched"), repoId: z.string(), ok: z.boolean(), error: z.string().optional(), at: z.string() }),
]);
export type DaemonToHub = z.infer<typeof DaemonToHubSchema>;

const HubToDaemonSchema = z.discriminatedUnion("type", [
  // workspaceIds: every workspace that still exists, so the daemon can remove the isolation dirs
  // (`~/.nema/ws/<id>`) of workspaces deleted while it was offline. Optional for older hubs.
  z.object({ type: z.literal("welcome"), workspaceIds: z.array(z.string()).optional() }),
  // Sent to a connected daemon when a workspace is deleted, so it removes that workspace's isolation dir.
  z.object({ type: z.literal("workspace.deleted"), workspaceId: z.string() }),
  z.object({
    type: z.literal("task.assign"),
    taskId: z.string(),
    workspaceId: z.string(),
    adapter: z.string().min(1),
    confidential: z.boolean(),
    prompt: z.string(),
    runToken: z.string(),
    hubUrl: z.string(),
    pluginTools: z.array(z.object({ name: z.string(), description: z.string(), parameters: z.record(z.string(), z.unknown()) })),
    /** The task's delivery set; the daemon fetches the bytes from the Room API with runToken. */
    attachments: z.array(AttachmentRefSchema).optional(),
    limits: z.object({ maxModelCalls: z.number().int().min(1), maxToolCalls: z.number().int().min(1), timeoutMs: z.number().int().min(1) }).optional(),
    /** Bound repos whose Skills the user trusts; the daemon reads them at the main commit. Optional for older hubs. */
    projectSkills: z.array(z.object({ repoId: z.string(), label: z.string(), path: z.string(), mainBranch: z.string(), gitCommonDir: z.string().optional() })).optional(),
    /** Skill ids this thread activated, newest first; the daemon preloads the current versions. Thread tasks only. */
    retainedSkills: z.array(z.string()).optional(),
    /** The Skill the user called with a leading `/skill-id`, and the rest of the line as its arguments. */
    manualSkill: z.object({ skillId: z.string(), arguments: z.string() }).optional(),
    /**
     * The account this message asked for (spec 2026-10-31 §5.4). The hub carries it down; the daemon decides
     * what it means, because accounts exist only on the daemon's machine.
     *
     * Validated by shape here even though the hub cannot know whether the account exists: the id names a
     * directory under the daemon's `secrets/accounts/`, and an arbitrary string must never get that far.
     */
    accountId: z.string().regex(/^acct_[a-z0-9]{10}$/).optional(),
    /** Present only when the task may be routed automatically. S4 implements it; S3 refuses it. */
    routing: z.literal("auto").optional(),
    /** The thread this task belongs to; the main chat has none. The daemon looks up thread bindings by it. */
    threadId: z.string().min(1).optional(),
  }),
  z.object({ type: z.literal("rpc.request"), id: z.string(), method: z.string(), params: z.unknown() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type HubToDaemon = z.infer<typeof HubToDaemonSchema>;

/** The hub's `error` text for a revoked daemon credential; the daemon stops reconnecting on exactly this text. */
export const DAEMON_CREDENTIAL_REVOKED_MESSAGE = "Daemon credential has been revoked. Register this daemon again.";

/*
 * Texts one side produces and the other side matches to decide behavior (#299 batch 0). Both sides import
 * them from here, so translating the text later cannot silently break the match. Daemons and hubs already
 * released send the current wording, so a later translation must keep accepting it.
 */

/** Prefix of the daemon's RPC error for a method it does not know; the hub reads it as "older daemon". */
export const UNKNOWN_RPC_METHOD_PREFIX = "未知方法 ";

export function unknownRpcMethodError(method: string): string {
  return `${UNKNOWN_RPC_METHOD_PREFIX}${method}`;
}

export function isUnknownRpcMethodError(message: string): boolean {
  return message.startsWith(UNKNOWN_RPC_METHOD_PREFIX);
}

/** The daemon's refusal of a mirror URL (component settings); the hub answers it with 400, not 502. */
export const MIRROR_URL_ERROR = "镜像地址只允许 http(s) URL，且不能带账号、查询串或片段";

/** Phrase every hub version-skew refusal contains; the daemon stops reconnecting when it sees it. */
export const VERSION_SKEW_MARKER = "版本不一致";

/** The npm spec the skew refusal names, e.g. `@nema-project/nema@1.2.3`. */
export function nemaCliSpec(version: string): string {
  return `@nema-project/nema@${version}`;
}

const NEMA_CLI_SPEC = /@nema-project\/nema@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/;

/**
 * Reads a hub `error` message as a version-skew refusal. Null when it is not one; otherwise the CLI version
 * the hub asks for, or null when the message names none.
 */
export function parseVersionSkew(message: string): { installVersion: string | null } | null {
  if (!message.includes(VERSION_SKEW_MARKER)) return null;
  return { installVersion: NEMA_CLI_SPEC.exec(message)?.[1] ?? null };
}

export type TaskAssign = Extract<HubToDaemon, { type: "task.assign" }>;
/**
 * What a daemon adapter emits. Stricter than the wire schema, which accepts any `code`/`params`/`items` so an
 * odd field never drops the line: a producer here must send a code string, flat params and coded items.
 */
export type TaskEvent = {
  type: Extract<DaemonToHub, { type: "task.event" }>["event"]["type"];
  text: string;
  code?: string;
  params?: CodeParams;
  items?: CodedText[];
};

export function parseDaemonToHub(raw: unknown): DaemonToHub {
  return DaemonToHubSchema.parse(raw);
}
export function parseHubToDaemon(raw: unknown): HubToDaemon {
  return HubToDaemonSchema.parse(raw);
}

/**
 * A route decision from the wire, or `undefined` when there is none or it is not one this hub understands.
 *
 * Separate from the message schema on purpose (see `task.finished`). A daemon that sends a reason code
 * from a newer protocol still gets its reply stored; only the route line is lost, because a record the hub
 * cannot read must not be written to `messages.meta` and shown to the user as if it were understood.
 */
export function parseRouteDecision(raw: unknown): RouteDecision | undefined {
  if (raw === undefined) return undefined;
  const parsed = RouteDecisionSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** Run limits of a work package generation task. Every other run keeps the daemon defaults. */
export const WORKPACKAGE_LIMITS = { maxModelCalls: 48, maxToolCalls: 120, timeoutMs: 1_200_000 } as const;
