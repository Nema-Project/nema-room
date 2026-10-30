import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z, ZodError } from "zod";
import { KnowledgeStore, git } from "@nema/knowledge";
import { kindFromId, reportPassed, type Entry, type ReportMessageMeta, type WpTask } from "@nema/shared";
import type { DaemonRpc } from "./daemonRpc.js";
import type { HubCallOutcome } from "./diagrams.js";
import type { Db } from "./db/db.js";
import type { EventBus } from "./events.js";
import { indexEntry } from "./entryIndex.js";
import { getMessage, postSystemTask, type Message } from "./messages.js";
import { workspacePluginState } from "./plugins.js";
import { listRepos } from "./repos.js";
import { getTask, recordTaskChange, toUiTask } from "./tasks.js";
import { repoPath } from "./workspaces.js";
import { checkSpec, parsePlan } from "./wpFormat.js";
import type { OwnedHelperScope } from "@nema/shared/ownedHelper";

export type WorkPackageDeps = { db: Db; dataDir: string; events: EventBus; daemon: DaemonRpc; ownedHelpers?: OwnedHelperScope };

const WP_ID = /^W-[1-9]\d*$/;
const ID = z.string().regex(WP_ID);

const Id = z.object({ id: z.string() }).strict();
const Save = z.object({ id: z.string(), markdown: z.string() }).strict();
const Block = z.object({ id: z.string(), questionId: z.string() }).strict();
const Request = z
  .object({ requirements: z.array(z.string().regex(/^R-[1-9]\d*$/)).min(1), title: z.string().min(1).max(200).optional() })
  .strict();
const Inferred = z
  .object({ id: z.string(), task: z.number().int().min(1), commits: z.array(z.string()).min(1) })
  .strict();

let cachedDir: string | undefined;

/** `vendor/superpowers-rules`: `NEMA_SUPERPOWERS_RULES_DIR`, else the nearest ancestor that has it. */
export function rulesDir(): string {
  const fromEnv = process.env.NEMA_SUPERPOWERS_RULES_DIR;
  if (fromEnv) return fromEnv;
  if (cachedDir) return cachedDir;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(dir, "vendor", "superpowers-rules");
    if (existsSync(path.join(candidate, "spec-rules.md"))) return (cachedDir = candidate);
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("vendored superpowers rules not found (vendor/superpowers-rules)");
    dir = parent;
  }
}

export function workPackageRules(): { spec: string; plan: string } {
  const dir = rulesDir();
  return {
    spec: readFileSync(path.join(dir, "spec-rules.md"), "utf8"),
    plan: readFileSync(path.join(dir, "plan-rules.md"), "utf8"),
  };
}

function issues(e: ZodError): string {
  return e.issues.map((i) => `${i.path.join(".") || "(args)"}: ${i.message}`).join("; ");
}

const notFound = (id: string): HubCallOutcome => ({ status: 404, error: `找不到开发包 ${id}` });
const refused = (error: string): HubCallOutcome => ({ status: 200, result: { ok: false, error }, ok: false });

/** Answer a `workpackage__*` function. Status and task progress stay hub-side: only `mark_task_inferred` touches a task. */
export async function callWorkPackageFunction(
  deps: WorkPackageDeps,
  auth: { taskId: string; workspaceId: string },
  name: string,
  args: unknown,
): Promise<HubCallOutcome> {
  const store = new KnowledgeStore(repoPath(deps.dataDir, auth.workspaceId), deps.ownedHelpers);
  const idOf = (a: unknown): string => (a && typeof a === "object" && typeof (a as { id?: unknown }).id === "string" ? (a as { id: string }).id : "");
  switch (name) {
    case "workpackage__request":
      return request(deps, auth, args);
    case "workpackage__read": {
      const parsed = Id.safeParse(args);
      if (!parsed.success) return { status: 400, error: `参数无效：${issues(parsed.error)}` };
      const wp = await store.readWorkPackage(parsed.data.id);
      if (!wp) return notFound(parsed.data.id);
      return { status: 200, result: { ...wp, rules: workPackageRules() }, ok: true };
    }
    case "workpackage__save_spec":
    case "workpackage__save_plan":
    case "workpackage__block":
    case "workpackage__mark_task_inferred": {
      const schema = name === "workpackage__block" ? Block : name === "workpackage__mark_task_inferred" ? Inferred : Save;
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        const id = idOf(args);
        // A missing or unknown package is a 404 before argument problems are reported.
        if (id !== "" && (kindFromId(id) !== "workpackage" || (await store.get(id)) === null)) return notFound(id);
        return { status: 400, error: `参数无效：${issues(parsed.error)}` };
      }
      const data = parsed.data as { id: string };
      const existing = kindFromId(data.id) === "workpackage" ? await store.get(data.id) : null;
      if (!existing?.workpackage) return notFound(data.id);
      if (name === "workpackage__save_spec") return saveSpec(deps, store, auth, existing, (data as z.infer<typeof Save>).markdown);
      if (name === "workpackage__save_plan") return savePlan(deps, store, auth, existing, (data as z.infer<typeof Save>).markdown);
      if (name === "workpackage__block") return block(deps, store, auth, existing, (data as z.infer<typeof Block>).questionId);
      return markInferred(deps, store, auth, existing, data as z.infer<typeof Inferred>);
    }
    default:
      return { status: 404, error: `未知函数 ${name}` };
  }
}

export class WorkPackageError extends Error {
  constructor(
    public status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "WorkPackageError";
  }
}

function generationContent(id: string, requirements: string[]): string {
  return `为 ${id} 生成开发包，覆盖 ${requirements.join("、")}。`;
}

/** The W-n a generation system message names. */
export function workPackageIdOf(content: string): string | null {
  return /为 (W-[1-9]\d*) 生成开发包/.exec(content)?.[1] ?? null;
}

/**
 * Creates a `draft` package for the chosen requirements and queues its generation task.
 * Throws WorkPackageError (400 / 409) when the request cannot be served.
 */
export async function requestWorkPackage(
  db: Db,
  dataDir: string,
  events: EventBus,
  workspaceId: string,
  input: { requirements: string[]; title?: string },
  sourceMessageId?: string,
  ownedHelpers?: OwnedHelperScope,
): Promise<{ entry: Entry }> {
  const plugin = (await workspacePluginState(db, workspaceId)).find((p) => p.plugin.id === "superpowers");
  if (!plugin?.enabled) throw new WorkPackageError(409, "superpowers 插件已关闭");
  const requirements = [...new Set(input.requirements)];
  if (requirements.length === 0) throw new WorkPackageError(400, "请至少选择一条需求");
  const store = new KnowledgeStore(repoPath(dataDir, workspaceId), ownedHelpers);
  const titles: string[] = [];
  for (const id of requirements) {
    const req = kindFromId(id) === "requirement" ? await store.get(id) : null;
    if (!req || req.status !== "active") throw new WorkPackageError(400, `${id} 不是有效的需求`);
    titles.push(req.title);
  }
  const repos = await listRepos(db, workspaceId);
  if (repos.length === 0) throw new WorkPackageError(409, "请先绑定代码仓库");
  const entry = await store.createWorkPackage(
    {
      title: input.title ?? titles[0]!,
      requirements,
      repos: repos.map((r) => r.id),
      reason: `发起开发包：${input.title ?? titles[0]!}`,
      sourceMessages: sourceMessageId ? [sourceMessageId] : [],
    },
    { author: sourceMessageId ? "agent" : "user" },
  );
  await indexEntry(db, workspaceId, entry, ownedHelpers).catch((e) => console.error(`work package: indexing ${entry.id} failed`, e));
  events.emit(workspaceId, { type: "knowledge.changed", entryId: entry.id });
  await queueGeneration(db, events, workspaceId, entry.id, requirements);
  return { entry };
}

async function queueGeneration(db: Db, events: EventBus, workspaceId: string, id: string, requirements: string[]): Promise<void> {
  const { message, task } = await postSystemTask(db, workspaceId, generationContent(id, requirements), { kind: "workpackage" });
  events.emit(workspaceId, { type: "message.created", message });
  events.emit(workspaceId, { type: "task.updated", task: toUiTask(task) });
}

/**
 * After an entry write: a resolved question that a draft package waits on unblocks it, and its generation
 * is queued once. Never throws: the write that triggered it is already committed.
 */
export async function retryBlockedPackages(db: Db, dataDir: string, events: EventBus, workspaceId: string, entry: Entry, author: "agent" | "user", ownedHelpers?: OwnedHelperScope): Promise<void> {
  if (entry.kind !== "question" || entry.status !== "resolved") return;
  try {
    const store = new KnowledgeStore(repoPath(dataDir, workspaceId), ownedHelpers);
    for (const summary of (await store.list()).filter((e) => e.kind === "workpackage" && e.status === "draft")) {
      const wp = await store.get(summary.id);
      if (!wp?.workpackage || wp.workpackage.blockedOn !== entry.id) continue;
      const cleared = await store.setWorkPackageMeta(wp.id, { blockedOn: null }, `问题 ${entry.id} 已解决，重新生成开发包 ${wp.id}`, { author });
      await indexEntry(db, workspaceId, cleared, ownedHelpers).catch((e) => console.error(`work package: indexing ${cleared.id} failed`, e));
      events.emit(workspaceId, { type: "knowledge.changed", entryId: cleared.id });
      await queueGeneration(db, events, workspaceId, wp.id, wp.workpackage.requirements);
    }
  } catch (e) {
    console.error(`work package: re-queue after ${entry.id} failed`, e);
  }
}

async function request(deps: WorkPackageDeps, auth: { taskId: string; workspaceId: string }, args: unknown): Promise<HubCallOutcome> {
  const parsed = Request.safeParse(args);
  if (!parsed.success) return { status: 400, error: `参数无效：${issues(parsed.error)}` };
  try {
    const task = await getTask(deps.db, auth.taskId);
    const { entry } = await requestWorkPackage(deps.db, deps.dataDir, deps.events, auth.workspaceId, parsed.data, task?.messageId, deps.ownedHelpers);
    return { status: 200, result: { ok: true, id: entry.id }, ok: true };
  } catch (e) {
    if (e instanceof WorkPackageError) return refused(e.message);
    throw e;
  }
}

async function afterWrite(deps: WorkPackageDeps, auth: { taskId: string; workspaceId: string }, entry: Entry, op: "add" | "update", commit: string): Promise<void> {
  // The commit is durable; failures below must not make the Agent retry.
  try {
    await indexEntry(deps.db, auth.workspaceId, entry, deps.ownedHelpers);
    await recordTaskChange(deps.db, auth.taskId, { entryId: entry.id, kind: entry.kind, title: entry.title, op });
    deps.events.emit(auth.workspaceId, { type: "knowledge.changed", entryId: entry.id });
  } catch (e) {
    console.error(`work package: post-commit bookkeeping failed for ${entry.id} (commit ${commit})`, e);
  }
}

async function sourceMessages(deps: WorkPackageDeps, taskId: string): Promise<string[]> {
  const task = await getTask(deps.db, taskId);
  return task ? [task.messageId] : [];
}

async function saveSpec(deps: WorkPackageDeps, store: KnowledgeStore, auth: { taskId: string; workspaceId: string }, existing: Entry, markdown: string): Promise<HubCallOutcome> {
  const checked = checkSpec(markdown);
  if (!checked.ok) return refused(checked.error);
  const entry = await store.writeWorkPackageDoc(existing.id, "spec", markdown, {}, `写开发包 spec：${existing.title}`, await sourceMessages(deps, auth.taskId), { author: "agent", taskId: auth.taskId });
  await afterWrite(deps, auth, entry, "update", "spec");
  return { status: 200, result: { ok: true }, ok: true };
}

/** Parse a plan and check its modified files exist on main. `error` is the text to return to the author. */
async function checkPlan(deps: { db: Db; daemon: DaemonRpc }, workspaceId: string, markdown: string) {
  const repos = await listRepos(deps.db, workspaceId);
  const parsed = parsePlan(markdown, repos.map((r) => r.label));
  if (!parsed.ok) return { ok: false as const, error: parsed.error };
  const missing: string[] = [];
  for (const repo of repos) {
    const paths = [...new Set(parsed.tasks.flatMap((t) => t.files.filter((f) => f.op === "modify" && f.repo === repo.label).map((f) => f.path)))];
    if (paths.length === 0) continue;
    const result = await deps.daemon.call("repo.exists", {
      workspaceId: repo.workspaceId,
      repoId: repo.id,
      path: repo.path,
      mainBranch: repo.mainBranch,
      paths,
    });
    const list = (result as { missing?: unknown } | null)?.missing;
    if (!Array.isArray(list) || !list.every((p) => typeof p === "string")) throw new Error("invalid repo.exists result");
    missing.push(...list.map((p) => `- 修改：${repo.label}:${p}`));
  }
  if (missing.length > 0) return { ok: false as const, error: `以下文件在主分支上不存在（新文件请写「新建」）：\n${missing.join("\n")}` };
  const tasks = parsed.tasks.map((t) => ({ ...t, status: "pending" as const, inferred: false, reportMessageId: null, confirmedBy: null }));
  return { ok: true as const, tasks };
}

async function savePlan(deps: WorkPackageDeps, store: KnowledgeStore, auth: { taskId: string; workspaceId: string }, existing: Entry, markdown: string): Promise<HubCallOutcome> {
  const checked = await checkPlan(deps, auth.workspaceId, markdown);
  if (!checked.ok) return refused(checked.error);
  const entry = await store.writeWorkPackageDoc(existing.id, "plan", markdown, { tasks: checked.tasks }, `写开发包 plan：${existing.title}`, await sourceMessages(deps, auth.taskId), { author: "agent", taskId: auth.taskId });
  await afterWrite(deps, auth, entry, "update", "plan");
  return { status: 200, result: { ok: true }, ok: true };
}

async function userPackage(store: KnowledgeStore, id: string): Promise<Entry> {
  const entry = kindFromId(id) === "workpackage" ? await store.get(id) : null;
  if (!entry?.workpackage) throw new WorkPackageError(404, `找不到开发包 ${id}`);
  return entry;
}

async function userAfter(deps: { db: Db; events: EventBus; ownedHelpers?: OwnedHelperScope }, workspaceId: string, entry: Entry): Promise<void> {
  await indexEntry(deps.db, workspaceId, entry, deps.ownedHelpers).catch((e) => console.error(`work package: indexing ${entry.id} failed`, e));
  deps.events.emit(workspaceId, { type: "knowledge.changed", entryId: entry.id });
}

/** The user saves a spec or plan by hand. Any save resets the package to `draft`. */
export async function userSaveWorkPackageDoc(
  deps: { db: Db; dataDir: string; events: EventBus; daemon: DaemonRpc; ownedHelpers?: OwnedHelperScope },
  workspaceId: string,
  id: string,
  which: "spec" | "plan",
  markdown: string,
): Promise<Entry> {
  const store = new KnowledgeStore(repoPath(deps.dataDir, workspaceId), deps.ownedHelpers);
  const existing = await userPackage(store, id);
  let update: { tasks?: WpTask[] } = {};
  if (which === "plan") {
    const checked = await checkPlan(deps, workspaceId, markdown);
    if (!checked.ok) throw new WorkPackageError(400, checked.error);
    update = { tasks: checked.tasks };
  }
  const entry = await store.writeWorkPackageDoc(id, which, markdown, update, `用户修改开发包 ${which}：${existing.title}`, [], { author: "user" });
  await userAfter(deps, workspaceId, entry);
  return entry;
}

export async function approveWorkPackage(deps: { db: Db; dataDir: string; events: EventBus; ownedHelpers?: OwnedHelperScope }, workspaceId: string, id: string): Promise<Entry> {
  const store = new KnowledgeStore(repoPath(deps.dataDir, workspaceId), deps.ownedHelpers);
  const wp = await store.readWorkPackage(id);
  if (!wp) throw new WorkPackageError(404, `找不到开发包 ${id}`);
  if (wp.entry.status !== "draft") throw new WorkPackageError(409, "只有草稿状态的开发包可以批准");
  if (wp.spec === null || wp.plan === null) throw new WorkPackageError(409, "开发包还没有 spec 和 plan");
  const head = (await git(repoPath(deps.dataDir, workspaceId), ["rev-parse", "HEAD"], deps.ownedHelpers)).trim();
  const entry = await store.setWorkPackageMeta(id, { status: "approved", approvedAt: new Date().toISOString(), approvedCommit: head }, `用户批准开发包 ${id}`, { author: "user" });
  await userAfter(deps, workspaceId, entry);
  return entry;
}

export async function dropWorkPackage(deps: { db: Db; dataDir: string; events: EventBus; ownedHelpers?: OwnedHelperScope }, workspaceId: string, id: string): Promise<Entry> {
  const store = new KnowledgeStore(repoPath(deps.dataDir, workspaceId), deps.ownedHelpers);
  await userPackage(store, id);
  const entry = await store.setWorkPackageMeta(id, { status: "dropped" }, `用户放弃开发包 ${id}`, { author: "user" });
  await userAfter(deps, workspaceId, entry);
  return entry;
}

export async function regenerateWorkPackage(deps: { db: Db; dataDir: string; events: EventBus; ownedHelpers?: OwnedHelperScope }, workspaceId: string, id: string): Promise<void> {
  const store = new KnowledgeStore(repoPath(deps.dataDir, workspaceId), deps.ownedHelpers);
  const entry = await userPackage(store, id);
  if (entry.status === "done") throw new WorkPackageError(409, "已完成的开发包不能重新生成");
  await queueGeneration(deps.db, deps.events, workspaceId, id, entry.workpackage!.requirements);
}

async function block(deps: WorkPackageDeps, store: KnowledgeStore, auth: { taskId: string; workspaceId: string }, existing: Entry, questionId: string): Promise<HubCallOutcome> {
  const question = kindFromId(questionId) === "question" ? await store.get(questionId) : null;
  if (!question || question.status !== "open") return refused(`${questionId} 不是本 workspace 中未解决的问题`);
  const entry = await store.setWorkPackageMeta(existing.id, { blockedOn: questionId }, `开发包 ${existing.id} 等待问题 ${questionId}`, { author: "agent", taskId: auth.taskId });
  await afterWrite(deps, auth, entry, "update", "block");
  return { status: 200, result: { ok: true }, ok: true };
}

async function markInferred(deps: WorkPackageDeps, store: KnowledgeStore, auth: { taskId: string; workspaceId: string }, existing: Entry, input: z.infer<typeof Inferred>): Promise<HubCallOutcome> {
  const wp = existing.workpackage!;
  const task = wp.tasks.find((t) => t.n === input.task);
  if (!task) return refused(`${existing.id} 没有任务 ${input.task}`);
  if (task.status !== "pending") return refused(`任务 ${input.task} 不是 pending，不能标为推断`);
  const tasks = wp.tasks.map((t) => (t.n === input.task ? { ...t, status: "reported" as const, inferred: true, reportMessageId: null } : t));
  const entry = await store.setWorkPackageMeta(existing.id, { tasks }, `代码推断任务 ${input.task} 已完成（${input.commits.join(", ")}）`, { author: "agent", taskId: auth.taskId });
  await afterWrite(deps, auth, entry, "update", "inferred");
  return { status: 200, result: { ok: true }, ok: true };
}

// Progress edits read and rewrite the whole task list, so they run one at a time.
let progressQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = progressQueue.then(fn, fn);
  progressQueue = run.catch(() => undefined);
  return run;
}

/** Saves a new task list, derives the package status, and when every task is verified marks the requirements verified. */
async function saveProgress(
  deps: { db: Db; dataDir: string; events: EventBus; ownedHelpers?: OwnedHelperScope },
  workspaceId: string,
  wp: Entry,
  tasks: WpTask[],
  reason: string,
  author: "user" | "system",
  lastReportMessageId: string | null,
): Promise<Entry> {
  const store = new KnowledgeStore(repoPath(deps.dataDir, workspaceId), deps.ownedHelpers);
  let status: Entry["status"] = wp.status;
  const allVerified = tasks.length > 0 && tasks.every((t) => t.status === "verified");
  if (allVerified && status !== "done") status = "done";
  else if (status === "approved" && tasks.some((t) => t.status !== "pending")) status = "in_progress";
  const entry = await store.setWorkPackageMeta(wp.id, { tasks, ...(status !== wp.status ? { status } : {}) }, reason, { author });
  await userAfter(deps, workspaceId, entry);
  if (status === "done" && wp.status !== "done") {
    const commits = new Set<string>();
    for (const t of tasks) {
      const m = t.reportMessageId ? await getMessage(deps.db, t.reportMessageId) : null;
      for (const c of (m?.meta as ReportMessageMeta | null)?.report?.commits ?? []) commits.add(c);
    }
    for (const reqId of entry.workpackage!.requirements) {
      try {
        const req = await store.get(reqId);
        if (!req || req.implementation?.status === "verified") continue;
        const updated = await store.upsert(
          {
            id: reqId,
            kind: req.kind,
            title: req.title,
            body: req.body,
            status: req.status,
            related: req.related,
            sourceMessages: [],
            reason: `开发包 ${wp.id} 全部任务已核实`,
            implementation: {
              status: "verified",
              evidence: { reportMessageId: lastReportMessageId, commits: [...commits], inferred: false, note: `开发包 ${wp.id} 全部任务已核实`, confirmedBy: null, acceptanceReview: null, reportEvidence: null },
            },
          },
          { author: "system" },
        );
        await userAfter(deps, workspaceId, updated.entry);
      } catch (e) {
        console.error(`work package: marking ${reqId} verified failed`, e);
      }
    }
  }
  return entry;
}

/**
 * After a report's check is stored: sets the status of the work package task the report names, from the check.
 * Does nothing unless the report names exactly one approved or in-progress `W-n` and an existing task.
 * Never throws: the report itself is already stored.
 */
export async function applyReportToWorkPackage(db: Db, dataDir: string, events: EventBus, workspaceId: string, reportMessage: Pick<Message, "id" | "meta">, ownedHelpers?: OwnedHelperScope): Promise<void> {
  try {
    const meta = reportMessage.meta as ReportMessageMeta | null;
    const report = meta?.report;
    const check = meta?.check;
    if (!report || !check || report.task === undefined) return;
    const ids = report.entries.filter((e) => kindFromId(e) === "workpackage");
    if (ids.length !== 1) return;
    await serialized(async () => {
      const store = new KnowledgeStore(repoPath(dataDir, workspaceId), ownedHelpers);
      const wp = await store.get(ids[0]!);
      if (!wp?.workpackage || (wp.status !== "approved" && wp.status !== "in_progress")) return;
      const task = wp.workpackage.tasks.find((t) => t.n === report.task);
      if (!task || task.status === "verified") return;
      const touched = new Set(check.touchedFiles);
      let next: "verified" | "mismatch" | "reported";
      if (!check.commitsExist || !check.filesOk) next = "mismatch";
      else if (check.onMain === "not-yet") next = "reported";
      else next = reportPassed(check) && task.files.some((f) => touched.has(f.path)) ? "verified" : "mismatch";
      if (next === task.status && task.reportMessageId === reportMessage.id && !task.inferred) return;
      const tasks = wp.workpackage.tasks.map((t) => (t.n === task.n ? { ...t, status: next, inferred: false, reportMessageId: reportMessage.id } : t));
      await saveProgress({ db, dataDir, events, ownedHelpers }, workspaceId, wp, tasks, `上报 ${reportMessage.id} → 任务 ${task.n}：${next}`, "system", reportMessage.id);
    });
  } catch (e) {
    console.error(`work package: applying report ${reportMessage.id} failed`, e);
  }
}

/** The user confirms a `reported` (including inferred) or `mismatch` task as done. */
export async function confirmWorkPackageTask(deps: { db: Db; dataDir: string; events: EventBus; ownedHelpers?: OwnedHelperScope }, workspaceId: string, id: string, n: number): Promise<Entry> {
  return serialized(async () => {
    const store = new KnowledgeStore(repoPath(deps.dataDir, workspaceId), deps.ownedHelpers);
    const wp = await userPackage(store, id);
    const task = wp.workpackage!.tasks.find((t) => t.n === n);
    if (!task) throw new WorkPackageError(404, `${id} 没有任务 ${n}`);
    if (task.status !== "reported" && task.status !== "mismatch") throw new WorkPackageError(409, "只有已上报或不符的任务可以确认");
    const tasks = wp.workpackage!.tasks.map((t) => (t.n === n ? { ...t, status: "verified" as const, confirmedBy: "user" as const } : t));
    return saveProgress(deps, workspaceId, wp, tasks, `用户确认任务 ${n} 已完成`, "user", task.reportMessageId);
  });
}
