import { z } from "zod";
import { AttachmentRefSchema } from "./attachments.js";

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
  }),
  z.object({
    type: z.literal("task.event"),
    taskId: z.string(),
    event: z.object({ type: z.enum(["progress", "agent_message", "tool_call"]), text: z.string() }),
  }),
  z.object({ type: z.literal("task.finished"), taskId: z.string(), ok: z.literal(true), reply: z.string() }),
  z.object({ type: z.literal("task.finished"), taskId: z.string(), ok: z.literal(false), error: z.string() }),
  z.object({ type: z.literal("rpc.response"), id: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.object({ type: z.literal("rpc.response"), id: z.string(), ok: z.literal(false), error: z.string() }),
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
    projectSkills: z.array(z.object({ repoId: z.string(), label: z.string(), path: z.string(), mainBranch: z.string() })).optional(),
    /** Skill ids this thread activated, newest first; the daemon preloads the current versions. Thread tasks only. */
    retainedSkills: z.array(z.string()).optional(),
    /** The Skill the user called with a leading `/skill-id`, and the rest of the line as its arguments. */
    manualSkill: z.object({ skillId: z.string(), arguments: z.string() }).optional(),
  }),
  z.object({ type: z.literal("rpc.request"), id: z.string(), method: z.string(), params: z.unknown() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type HubToDaemon = z.infer<typeof HubToDaemonSchema>;

export type TaskAssign = Extract<HubToDaemon, { type: "task.assign" }>;
export type TaskEvent = Extract<DaemonToHub, { type: "task.event" }>["event"];

export function parseDaemonToHub(raw: unknown): DaemonToHub {
  return DaemonToHubSchema.parse(raw);
}
export function parseHubToDaemon(raw: unknown): HubToDaemon {
  return HubToDaemonSchema.parse(raw);
}

/** Run limits of a work package generation task. Every other run keeps the daemon defaults. */
export const WORKPACKAGE_LIMITS = { maxModelCalls: 48, maxToolCalls: 120, timeoutMs: 1_200_000 } as const;
