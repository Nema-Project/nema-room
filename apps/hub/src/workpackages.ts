import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { z, ZodError } from "zod";
import { KnowledgeStore, UpsertRejected, git } from "@nema/knowledge";
import { kindFromId, reportPassed, type Entry, type Implementation, type ReportCheck, type ReportMessageMeta, type UpsertEntryInput, type WpTask } from "@nema/shared";
import type { DaemonRpc } from "./daemonRpc.js";
import type { HubCallOutcome } from "./diagrams.js";
import type { Db } from "./db/db.js";
import type { EventBus } from "./events.js";
import { indexEntry } from "./entryIndex.js";
import { postSystemTask, type Message } from "./messages.js";
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

/** The note and commit reason when every task of a package has a passing git check. Not acceptance. */
export function commitsCheckedNote(wpId: string): string {
  return `开发包 ${wpId} 的提交已核对`;
}

/**
 * One reportEvidence group per passing report behind the tasks, in task order, when every task has a git check:
 * verified, not by the user, not inferred, and its report's stored check passed. Otherwise null.
 */
async function gitCheckedGroups(db: Db, workspaceId: string, tasks: WpTask[]): Promise<{ reportMessageId: string; commits: string[] }[] | null> {
  const groups: { reportMessageId: string; commits: string[] }[] = [];
  for (const t of tasks) {
    if (t.status !== "verified" || t.confirmedBy === "user" || t.inferred || !t.reportMessageId) return null;
    const meta = await reportMeta(db, workspaceId, t.reportMessageId);
    if (!meta?.check || !reportPassed(meta.check)) return null;
    if (!groups.some((g) => g.reportMessageId === t.reportMessageId)) groups.push({ reportMessageId: t.reportMessageId, commits: [...meta.report.commits] });
  }
  return groups.length > 0 ? groups : null;
}

// Progress edits read and rewrite the whole task list, so they run one at a time.
let progressQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = progressQueue.then(fn, fn);
  progressQueue = run.catch(() => undefined);
  return run;
}

/**
 * Saves a new task list and derives the package status. When every task is verified by its own passing
 * check, the requirements are marked commits-checked first; the package becomes done only once every
 * requirement write landed, so a failed write keeps it open and the next report on the package retries.
 */
async function saveProgress(
  deps: { db: Db; dataDir: string; events: EventBus; ownedHelpers?: OwnedHelperScope },
  workspaceId: string,
  wp: Entry,
  tasks: WpTask[],
  reason: string,
  author: "user" | "system",
): Promise<Entry> {
  const store = new KnowledgeStore(repoPath(deps.dataDir, workspaceId), deps.ownedHelpers);
  let status: Entry["status"] = wp.status;
  const allVerified = tasks.length > 0 && tasks.every((t) => t.status === "verified");
  if (allVerified && status !== "done") {
    status = (await markRequirementsChecked(deps, store, workspaceId, wp, tasks)) ? "done" : "in_progress";
  } else if (status === "approved" && tasks.some((t) => t.status !== "pending")) status = "in_progress";
  const changed = status !== wp.status || !isDeepStrictEqual(tasks, wp.workpackage!.tasks);
  if (!changed) return wp;
  const entry = await store.setWorkPackageMeta(wp.id, { tasks, ...(status !== wp.status ? { status } : {}) }, reason, { author });
  await userAfter(deps, workspaceId, entry);
  return entry;
}

/**
 * Marks the package's requirements commits-checked when every task has a passing git check. A package done
 * through user confirmations or inferred tasks says nothing about its requirements' commits, so nothing is
 * written. Returns false when a requirement write failed and should be retried.
 */
async function markRequirementsChecked(
  deps: { db: Db; dataDir: string; events: EventBus; ownedHelpers?: OwnedHelperScope },
  store: KnowledgeStore,
  workspaceId: string,
  wp: Entry,
  tasks: WpTask[],
): Promise<boolean> {
  const groups = await gitCheckedGroups(deps.db, workspaceId, tasks);
  if (!groups) return true;
  const commits: string[] = [];
  for (const group of groups) for (const c of group.commits) if (!commits.includes(c)) commits.push(c);
  const note = commitsCheckedNote(wp.id);
  let complete = true;
  for (const reqId of wp.workpackage!.requirements) {
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
          reason: note,
          implementation: {
            status: "verified",
            evidence: { reportMessageId: groups.at(-1)!.reportMessageId, commits, inferred: false, note, confirmedBy: null, acceptanceReview: null, reportEvidence: groups },
          },
        },
        { author: "system" },
        // Judged under the repo lock: a user acceptance that landed meanwhile is never replaced.
        ({ existing, input }) => guardStoredImplementation(deps.db, workspaceId, existing, input),
      );
      await userAfter(deps, workspaceId, updated.entry);
    } catch (e) {
      if (e instanceof UpsertRejected) continue;
      complete = false;
      console.error(`work package: marking ${reqId} verified failed`, e);
    }
  }
  return complete;
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
      if (!task) return;
      if (task.status === "verified") {
        // Every task verified but the package still open: a requirement write failed earlier; try again.
        if (wp.workpackage.tasks.every((t) => t.status === "verified")) {
          await saveProgress({ db, dataDir, events, ownedHelpers }, workspaceId, wp, wp.workpackage.tasks, `上报 ${reportMessage.id} → 重试开发包 ${wp.id} 的需求标记`, "system");
        }
        return;
      }
      const touched = new Set(check.touchedFiles);
      let next: "verified" | "mismatch" | "reported";
      if (!check.commitsExist || !check.filesOk) next = "mismatch";
      else if (check.onMain === "not-yet") next = "reported";
      else next = reportPassed(check) && task.files.some((f) => touched.has(f.path)) ? "verified" : "mismatch";
      if (next === task.status && task.reportMessageId === reportMessage.id && !task.inferred) return;
      const tasks = wp.workpackage.tasks.map((t) => (t.n === task.n ? { ...t, status: next, inferred: false, reportMessageId: reportMessage.id } : t));
      await saveProgress({ db, dataDir, events, ownedHelpers }, workspaceId, wp, tasks, `上报 ${reportMessage.id} → 任务 ${task.n}：${next}`, "system");
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
    return saveProgress(deps, workspaceId, wp, tasks, `用户确认任务 ${n} 已完成`, "user");
  });
}

/** Thrown by the review guard when the mark is already set, so `upsert` stops before writing. */
class ReviewAlreadyNeeded extends Error {}

function commitsAlign(a: string[], b: string[]): boolean {
  return a.every((x) => b.some((y) => sameCommit(x, y))) && b.every((y) => a.some((x) => sameCommit(x, y)));
}

/** Whether a user acceptance that cites `messageId` no longer matches the report's new check. */
function linkedCheckChanged(impl: Implementation, messageId: string, previous: ReportCheck | null, next: ReportCheck, reportCommits: string[]): boolean {
  const ev = impl.evidence;
  if (impl.status !== "verified" || ev.confirmedBy !== "user") return false;
  const group = (ev.reportEvidence ?? []).find((g) => g.reportMessageId === messageId);
  if (!group && ev.reportMessageId !== messageId) return false;
  const passedBefore = previous !== null && reportPassed(previous);
  const passedNow = reportPassed(next);
  if (passedBefore !== passedNow) return true;
  // Still failing: there is no passing commit set to compare, so nothing changed for the acceptance.
  if (!passedNow) return false;
  // A rollup accepted several reports; this report only answers for its own group.
  const accepted = group ? group.commits : ev.commits;
  return !commitsAlign(reportCommits, accepted);
}

/**
 * Marks `acceptanceReview` on every user-accepted requirement that cites this report when its check changes:
 * pass became fail (or back), or the passing commits no longer line up with the accepted ones. Only
 * `acceptanceReview` changes; the acceptance itself stays. A mark that is already set writes nothing.
 * Called before the report's meta moves on, so a failure leaves an extra mark rather than a lost one.
 */
export async function noteLinkedCheckChanged(
  deps: { db: Db; dataDir?: string; events: EventBus; ownedHelpers?: OwnedHelperScope },
  workspaceId: string,
  messageId: string,
  previous: ReportCheck | null,
  next: ReportCheck,
  reportCommits: string[],
): Promise<void> {
  if (!deps.dataDir) return;
  const store = new KnowledgeStore(repoPath(deps.dataDir, workspaceId), deps.ownedHelpers);
  const candidates = (await store.listEntries()).filter((e) => e.kind === "requirement" && e.implementation && linkedCheckChanged(e.implementation, messageId, previous, next, reportCommits));
  for (const candidate of candidates) {
    try {
      const { entry } = await store.upsert(
        { id: candidate.id, kind: candidate.kind, title: candidate.title, body: candidate.body, sourceMessages: [], reason: `上报 ${messageId} 的核对已变，验收需要复审` },
        { author: "system" },
        ({ existing, input }) => {
          const impl = existing?.implementation;
          if (!existing || !impl || !linkedCheckChanged(impl, messageId, previous, next, reportCommits)) throw new ReviewAlreadyNeeded();
          if (impl.evidence.acceptanceReview?.needed) throw new ReviewAlreadyNeeded();
          return {
            ...input,
            title: existing.title,
            body: existing.body,
            implementation: { ...impl, evidence: { ...impl.evidence, acceptanceReview: { needed: true, at: new Date().toISOString(), reason: "linked_check_changed" } } },
          };
        },
      );
      await userAfter(deps, workspaceId, entry);
    } catch (error) {
      if (error instanceof ReviewAlreadyNeeded) continue;
      throw error;
    }
  }
}

export const VERIFIED_NEEDS_REPORT = "实现状态 verified 需要一条核实通过的上报作为证据（evidence.reportMessageId）。";
export const INFERRED_NOT_VERIFIED = "代码推断的实现只能由用户确认为 verified。";
export const CONFIRMED_BY_USER_ONLY = "confirmedBy 只能由用户确认设置。";
export const REPORT_EVIDENCE_PROVENANCE = "reportEvidence 只能引用本 workspace 的上报，以及该上报里的提交。";
export const AGENT_REWRITES_USER_ACCEPTANCE = "已有用户确认的实现不能由 Agent 改写。";

/** Same commit when one sha is a prefix of the other (reports may use abbreviated shas). */
export function sameCommit(a: string, b: string): boolean {
  return a !== "" && b !== "" && (a.startsWith(b) || b.startsWith(a));
}

async function reportMeta(db: Db, workspaceId: string, messageId: string): Promise<ReportMessageMeta | null> {
  const rows = await db.query<{ meta: ReportMessageMeta | null }>(
    `select meta from messages where id = $1 and workspace_id = $2 and role = 'report'`,
    [messageId, workspaceId],
  );
  return rows[0]?.meta ?? null;
}

/** Every reportEvidence group cites a report message in this workspace and only commits that report lists. */
async function reportEvidenceCitesReports(db: Db, workspaceId: string, groups: Implementation["evidence"]["reportEvidence"]): Promise<boolean> {
  for (const group of groups ?? []) {
    const reported = (await reportMeta(db, workspaceId, group.reportMessageId))?.report.commits;
    if (!reported) return false;
    if (!group.commits.every((sha) => reported.some((r) => sameCommit(r, sha)))) return false;
  }
  return true;
}

/**
 * Why the Agent (or a package rollup) may not save this implementation, or null when it may. `verified` needs
 * passing reports of this workspace: with `reportEvidence`, every cited commit must sit in a group whose
 * report passed; without it, every commit must be one of the single `reportMessageId` report's commits.
 */
export async function implementationRefusal(db: Db, workspaceId: string, impl: Implementation): Promise<string | null> {
  const ev = impl.evidence;
  if (ev.confirmedBy !== null) return CONFIRMED_BY_USER_ONLY;
  if (!(await reportEvidenceCitesReports(db, workspaceId, ev.reportEvidence ?? null))) return REPORT_EVIDENCE_PROVENANCE;
  if (impl.status !== "verified") return null;
  if (ev.inferred) return INFERRED_NOT_VERIFIED;
  const groups = ev.reportEvidence ?? [];
  if (groups.length > 0) {
    const passed: string[][] = [];
    for (const group of groups) {
      const meta = await reportMeta(db, workspaceId, group.reportMessageId);
      if (meta?.check && reportPassed(meta.check)) passed.push(group.commits);
    }
    const covered = ev.commits.every((sha) => passed.some((commits) => commits.some((c) => sameCommit(c, sha))));
    return covered ? null : VERIFIED_NEEDS_REPORT;
  }
  if (ev.reportMessageId === null) return VERIFIED_NEEDS_REPORT;
  const meta = await reportMeta(db, workspaceId, ev.reportMessageId);
  if (!meta?.check || !reportPassed(meta.check)) return VERIFIED_NEEDS_REPORT;
  const reported = meta.report.commits;
  if (!ev.commits.every((sha) => reported.some((r) => sameCommit(r, sha)))) return VERIFIED_NEEDS_REPORT;
  return null;
}

/** The fields a user acceptance protects; equal on all of them means the Agent only repeated it. */
function sameProtectedImplementation(a: Implementation, b: Implementation): boolean {
  const pick = (impl: Implementation) => ({
    status: impl.status,
    confirmedBy: impl.evidence.confirmedBy,
    reportMessageId: impl.evidence.reportMessageId,
    reportEvidence: impl.evidence.reportEvidence ?? null,
    commits: impl.evidence.commits,
    note: impl.evidence.note,
    inferred: impl.evidence.inferred,
    acceptanceReview: impl.evidence.acceptanceReview ?? null,
  });
  return isDeepStrictEqual(pick(a), pick(b));
}

/**
 * The implementation rules, run inside `upsert`'s repo lock against the entry read there. A user-accepted
 * implementation is kept: repeating it unchanged drops the field from the write; any other change is 409.
 * Otherwise `implementationRefusal` decides. Throws {@link UpsertRejected}; must not call back into the store.
 */
export async function guardStoredImplementation(db: Db, workspaceId: string, existing: Entry | null, input: UpsertEntryInput): Promise<UpsertEntryInput> {
  const next = input.implementation;
  if (next === undefined) return input;
  const stored = existing?.implementation;
  if (stored?.evidence.confirmedBy === "user") {
    const parsed = { ...next, evidence: { ...next.evidence, acceptanceReview: next.evidence.acceptanceReview ?? null, reportEvidence: next.evidence.reportEvidence ?? null } } as Implementation;
    if (sameProtectedImplementation(stored, parsed)) {
      const { implementation: _kept, ...rest } = input;
      return rest as UpsertEntryInput;
    }
    if (next.evidence.confirmedBy !== null) throw new UpsertRejected(409, CONFIRMED_BY_USER_ONLY);
    throw new UpsertRejected(409, AGENT_REWRITES_USER_ACCEPTANCE);
  }
  const refused = await implementationRefusal(db, workspaceId, next as Implementation);
  if (refused) throw new UpsertRejected(409, refused);
  return input;
}
