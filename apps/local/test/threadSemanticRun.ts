import { execFile, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KnowledgeStore } from "@nema/knowledge";
import { saveConfig } from "@nema/cli/config";
import { startDaemon } from "@nema/cli/daemon/setup";
import { defaultCodexHome, saveClaudeToken } from "@nema/cli/localSettings";
import { createLocalDb } from "@nema/hub/db/local";
import { startHub } from "@nema/hub/lifecycle";
import { getTask, listTaskChanges } from "@nema/hub/tasks";
import { repoPath } from "@nema/hub/workspaces";
import {
  acceptanceWorkspacePlan,
  activeRedisDecisionId,
  BRAINSTORM_CLOSING,
  classifyRunError,
  credentialPreflight,
  evaluateSemantic,
  type EntryView,
  type KnowledgeSnap,
  type SemanticInput,
} from "../src/semanticAcceptance.js";

const MEMO = "只读 memo 检查：请把这段记录总结成三点，不要写入需求、决策或问题：周一确认了登录流程，周二安排了原型评审，周三收集试用反馈。";
const CASUAL_1 = "给小工具加缓存，你觉得用 Redis 还是本地缓存？先帮我想想利弊。";
const CASUAL_2 = "如果以后要多实例部署，会有什么差别？";
const DECISION = "就这么定了：用 Redis";
const BRAINSTORM = "缓存可以有这几种做法：进程内 LRU、本机文件、Redis、不缓存。请比较利弊，先不要选定。";
const LOCAL_LRU = "缓存用本地 LRU";

type Db = Awaited<ReturnType<typeof createLocalDb>>;
type Target = { kind: "main" } | { kind: "thread"; id: string } | { kind: "new-thread" };
type TurnChange = { entry: string; kind: string; op: string };
type TurnLog = {
  label: string;
  userMessageId: string;
  threadId: string | null;
  taskId: string;
  reply: string;
  traces: string[];
  task_changes: TurnChange[];
  opened_by: string | null;
};
type Room = { id: string; repo: string };

function acceptanceCliEntry(): string {
  const here = fileURLToPath(import.meta.url);
  const candidates = [
    resolve(here, "../../../../cli/dist/index.js"),
    resolve(here, "../../../cli/dist/index.js"),
    resolve(here, "../../cli/dist/index.js"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("compiled CLI entry missing; run npm run typecheck");
  return realpathSync(found);
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token?.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function gitHead(repo: string): Promise<string> {
  return new Promise((resolveHead, reject) => {
    execFile("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim()));
      else resolveHead(stdout.trim());
    });
  });
}

function redact(message: string, paths: string[]): string {
  let out = message;
  for (const path of paths.filter(Boolean).sort((a, b) => b.length - a.length)) out = out.split(path).join("[path]");
  return out;
}

function asEntry(value: Record<string, unknown>): EntryView {
  const quotes = Array.isArray(value.quotes) ? value.quotes : [];
  return {
    id: String(value.id ?? ""),
    kind: String(value.kind ?? ""),
    title: String(value.title ?? ""),
    status: String(value.status ?? ""),
    basis: typeof value.basis === "string" ? value.basis : null,
    related: Array.isArray(value.related) ? value.related.map(String) : [],
    sourceMessages: Array.isArray(value.sourceMessages) ? value.sourceMessages.map(String) : [],
    quotes: quotes.flatMap((quote) => {
      if (!quote || typeof quote !== "object") return [];
      const row = quote as { messageId?: unknown; text?: unknown };
      return typeof row.messageId === "string" && typeof row.text === "string" ? [{ messageId: row.messageId, text: row.text }] : [];
    }),
    body: typeof value.body === "string" ? value.body : "",
  };
}

function asked(meta: unknown): boolean {
  return !!meta && typeof meta === "object" && typeof (meta as { askedQuestion?: unknown }).askedQuestion === "object" && (meta as { askedQuestion?: unknown }).askedQuestion !== null;
}

async function api<T>(origin: string, method: string, pathname: string, body?: unknown): Promise<T> {
  const response = await fetch(origin + pathname, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${method} ${pathname} failed: ${response.status}`);
  return await response.json() as T;
}

const sleep = (ms: number) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

// ponytail: 50ms after response headers before the next post, so the SSE callback can subscribe.
// A slower hub can drop the first progress line. Upgrade: store tool names on the task row.
async function openTrace(origin: string, workspaceId: string): Promise<{ texts(taskId: string): string[]; close(): void }> {
  const ac = new AbortController();
  const seen: { taskId: string; text: string }[] = [];
  const response = await fetch(`${origin}/api/workspaces/${workspaceId}/events`, {
    headers: { accept: "text/event-stream" },
    signal: ac.signal,
  });
  if (!response.ok || !response.body) throw new Error(`event stream failed: ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const pump = (async () => {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        let end: number;
        while ((end = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, end);
          buf = buf.slice(end + 2);
          const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
          if (!data) continue;
          try {
            const event = JSON.parse(data) as { type?: string; taskId?: string; text?: string };
            if (event.type === "task.progress" && event.taskId && typeof event.text === "string") seen.push({ taskId: event.taskId, text: event.text });
          } catch { /* ping frames are not JSON */ }
        }
      }
    } catch { /* closed */ }
  })();
  await sleep(50);
  return {
    texts: (taskId) => seen.filter((row) => row.taskId === taskId).map((row) => row.text),
    close() { ac.abort(); void pump; },
  };
}

async function knowledge(origin: string, workspaceId: string, repo: string): Promise<KnowledgeSnap> {
  const list = await api<Array<{ id: string }>>(origin, "GET", `/api/workspaces/${workspaceId}/entries`);
  const entries: EntryView[] = [];
  for (const item of list) entries.push(asEntry(await api<Record<string, unknown>>(origin, "GET", `/api/workspaces/${workspaceId}/entries/${encodeURIComponent(item.id)}`)));
  return { entries, head: await gitHead(repo) };
}

async function threadsIn(db: Db, workspaceId: string): Promise<{ id: string; openedBy: string }[]> {
  const rows = await db.query<{ id: string; opened_by: string }>(
    "select id, opened_by from threads where workspace_id = $1 order by created_at, id",
    [workspaceId],
  );
  return rows.map((row) => ({ id: row.id, openedBy: row.opened_by }));
}

async function threadOpenedBy(db: Db, workspaceId: string, threadId: string | null): Promise<string | null> {
  if (!threadId) return null;
  const rows = await db.query<{ opened_by: string }>("select opened_by from threads where workspace_id = $1 and id = $2", [workspaceId, threadId]);
  return rows[0]?.opened_by ?? null;
}

function followAnchor(anchorId: string, threads: { id: string }[]): Target {
  return threads.some((thread) => thread.id === anchorId) ? { kind: "thread", id: anchorId } : { kind: "main" };
}

async function seedRedisDecision(db: Db, repo: string, workspaceId: string): Promise<void> {
  const store = new KnowledgeStore(repo);
  const { entry } = await store.upsert({
    kind: "decision",
    title: "缓存用 Redis",
    body: "缓存用 Redis",
    status: "active",
    basis: "decided",
    reason: "acceptance seed",
    sourceMessages: [],
  }, { author: "system" });
  await db.query(
    `insert into entry_index(workspace_id, entry_id, kind, title, status, priority, business_date, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,clock_timestamp())`,
    [workspaceId, entry.id, entry.kind, entry.title, entry.status, entry.priority ?? null, entry.businessDate],
  );
}

async function waitTask(db: Db, taskId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let task = await getTask(db, taskId);
  while (task && (task.status === "queued" || task.status === "running")) {
    if (Date.now() > deadline) throw new Error("acceptance turn timed out");
    await sleep(250);
    task = await getTask(db, taskId);
  }
  if (!task) throw new Error("task disappeared");
  if (task.status === "failed") throw new Error(task.error ?? "task failed");
}

async function speak(db: Db, origin: string, workspaceId: string, trace: { texts(taskId: string): string[] }, label: string, content: string, target: Target, timeoutMs: number): Promise<TurnLog> {
  const path = target.kind === "main"
    ? `/api/workspaces/${workspaceId}/messages`
    : target.kind === "thread"
      ? `/api/workspaces/${workspaceId}/threads/${encodeURIComponent(target.id)}/messages`
      : `/api/workspaces/${workspaceId}/threads`;
  const posted = await api<{ message: { id: string }; task: { id: string }; thread?: { id: string } }>(origin, "POST", path, { content });
  await waitTask(db, posted.task.id, timeoutMs);
  await sleep(100);
  const rows = await db.query<{ thread_id: string | null }>("select thread_id from messages where id = $1", [posted.message.id]);
  const threadId = posted.thread?.id ?? rows[0]?.thread_id ?? (target.kind === "thread" ? target.id : null);
  const replies = await db.query<{ content: string }>(
    "select content from messages where workspace_id = $1 and role = 'agent' and seq > (select seq from messages where id = $2) order by seq desc limit 1",
    [workspaceId, posted.message.id],
  );
  const changes = await listTaskChanges(db, posted.task.id);
  return {
    label,
    userMessageId: posted.message.id,
    threadId,
    taskId: posted.task.id,
    reply: replies[0]?.content ?? "",
    traces: trace.texts(posted.task.id),
    task_changes: changes.map((change) => ({ entry: change.entryId, kind: change.kind, op: change.op })),
    opened_by: await threadOpenedBy(db, workspaceId, threadId),
  };
}

async function askedInThread(db: Db, workspaceId: string, threadId: string): Promise<boolean> {
  const rows = await db.query<{ role: string; meta: unknown }>(
    "select role, meta from messages where workspace_id = $1 and (id = $2 or thread_id = $2)",
    [workspaceId, threadId],
  );
  return rows.some((row) => row.role === "agent" && asked(row.meta));
}

async function rmRetry(target: string): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try { await rm(target, { recursive: true, force: true }); return; }
    catch (error) { last = error; await sleep(200); }
  }
  throw last;
}

async function runRoom(origin: string, room: Room, body: (trace: { texts(taskId: string): string[] }) => Promise<void>): Promise<void> {
  const trace = await openTrace(origin, room.id);
  try { await body(trace); }
  finally { trace.close(); }
}

async function script(db: Db, origin: string, rooms: { memo: Room; design: Room; brainstorm: Room; conflict: Room }, timeoutMs: number): Promise<{ input: SemanticInput; turns: TurnLog[] }> {
  const turns: TurnLog[] = [];
  let memoTurn!: TurnLog;
  let memoBefore!: KnowledgeSnap;
  let memoAfter!: KnowledgeSnap;
  await runRoom(origin, rooms.memo, async (trace) => {
    memoBefore = await knowledge(origin, rooms.memo.id, rooms.memo.repo);
    memoTurn = await speak(db, origin, rooms.memo.id, trace, "memo", MEMO, { kind: "main" }, timeoutMs);
    turns.push(memoTurn);
    memoAfter = await knowledge(origin, rooms.memo.id, rooms.memo.repo);
  });

  let casual1!: TurnLog;
  let casual2!: TurnLog;
  let decision!: TurnLog;
  let designThreads: { id: string; openedBy: string }[] = [];
  let inAgentThread = false;
  let decisionsAdded: EntryView[] = [];
  await runRoom(origin, rooms.design, async (trace) => {
    casual1 = await speak(db, origin, rooms.design.id, trace, "casual-1", CASUAL_1, { kind: "main" }, timeoutMs);
    turns.push(casual1);
    let threads = await threadsIn(db, rooms.design.id);
    casual2 = await speak(db, origin, rooms.design.id, trace, "casual-2", CASUAL_2, followAnchor(casual1.userMessageId, threads), timeoutMs);
    turns.push(casual2);
    threads = await threadsIn(db, rooms.design.id);
    const beforeDecision = await knowledge(origin, rooms.design.id, rooms.design.repo);
    decision = await speak(db, origin, rooms.design.id, trace, "decision", DECISION, followAnchor(casual1.userMessageId, threads), timeoutMs);
    turns.push(decision);
    designThreads = await threadsIn(db, rooms.design.id);
    const afterDecision = await knowledge(origin, rooms.design.id, rooms.design.repo);
    const decisionRow = await db.query<{ id: string; thread_id: string | null }>("select id, thread_id from messages where id = $1", [decision.userMessageId]);
    const agent = designThreads.find((thread) => thread.id === casual1.userMessageId && thread.openedBy === "agent");
    inAgentThread = !!agent && (decisionRow[0]?.thread_id === agent.id || decisionRow[0]?.id === agent.id);
    const beforeIds = new Set(beforeDecision.entries.map((entry) => entry.id));
    decisionsAdded = afterDecision.entries.filter((entry) => entry.kind === "decision" && !beforeIds.has(entry.id));
  });

  let brainEnd!: TurnLog;
  let brainBefore!: KnowledgeSnap;
  let brainAfter!: KnowledgeSnap;
  await runRoom(origin, rooms.brainstorm, async (trace) => {
    brainBefore = await knowledge(origin, rooms.brainstorm.id, rooms.brainstorm.repo);
    const brainOpen = await speak(db, origin, rooms.brainstorm.id, trace, "brainstorm", BRAINSTORM, { kind: "new-thread" }, timeoutMs);
    turns.push(brainOpen);
    brainEnd = await speak(db, origin, rooms.brainstorm.id, trace, "brainstorm-end", BRAINSTORM_CLOSING, { kind: "thread", id: brainOpen.threadId ?? brainOpen.userMessageId }, timeoutMs);
    turns.push(brainEnd);
    brainAfter = await knowledge(origin, rooms.brainstorm.id, rooms.brainstorm.repo);
  });

  let conflictTurn!: TurnLog;
  let overrideTurn!: TurnLog;
  let redisId = "";
  let conflictDecisions: EntryView[] = [];
  let overrideDecisions: EntryView[] = [];
  let question: EntryView | null = null;
  let askedConflict = false;
  await runRoom(origin, rooms.conflict, async (trace) => {
    const seeded = await knowledge(origin, rooms.conflict.id, rooms.conflict.repo);
    redisId = activeRedisDecisionId(seeded.entries);
    if (redisId === "") throw new Error("acceptance seed did not leave one active Redis decision");
    const conflict = await speak(db, origin, rooms.conflict.id, trace, "conflict", LOCAL_LRU, { kind: "new-thread" }, timeoutMs);
    turns.push(conflict);
    conflictTurn = conflict;
    const threadB = conflict.threadId ?? conflict.userMessageId;
    const afterConflict = await knowledge(origin, rooms.conflict.id, rooms.conflict.repo);
    const addedQuestions = afterConflict.entries.filter((entry) => entry.kind === "question" && !seeded.entries.some((prev) => prev.id === entry.id));
    question = addedQuestions.length === 1 ? addedQuestions[0]! : null;
    conflictDecisions = afterConflict.entries.filter((entry) => entry.kind === "decision");
    askedConflict = await askedInThread(db, rooms.conflict.id, threadB);
    const overrideText = `改用本地 LRU，推翻 ${redisId}`;
    overrideTurn = await speak(db, origin, rooms.conflict.id, trace, "override", overrideText, { kind: "thread", id: threadB }, timeoutMs);
    turns.push(overrideTurn);
    const afterOverride = await knowledge(origin, rooms.conflict.id, rooms.conflict.repo);
    overrideDecisions = afterOverride.entries.filter((entry) => entry.kind === "decision");
  });

  const input: SemanticInput = {
    memo: { reply: memoTurn.reply, before: memoBefore, after: memoAfter },
    design: {
      reply: decision.reply,
      anchorMessageId: casual1.userMessageId,
      threads: designThreads,
      firstTurnChanges: casual1.task_changes,
      secondTurnChanges: casual2.task_changes,
      finalMessageInAgentThread: inAgentThread,
      decisionsAdded,
      finalUserMessageId: decision.userMessageId,
    },
    brainstorm: { reply: brainEnd.reply, before: brainBefore, after: brainAfter },
    conflict: {
      redisId,
      decisions: conflictDecisions,
      question,
      userMessageId: conflictTurn.userMessageId,
      userMessageText: LOCAL_LRU,
      agentAskedInThreadB: askedConflict,
    },
    override: {
      redisId,
      decisions: overrideDecisions,
      overrideMessageId: overrideTurn.userMessageId,
    },
  };
  return { input, turns };
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  const adapter = typeof parsed.adapter === "string" ? parsed.adapter : "";
  const out = typeof parsed.out === "string" ? parsed.out : join(tmpdir(), `nema-thread-semantic-${adapter || "run"}.json`);
  const model = typeof parsed.model === "string" ? parsed.model : null;
  const timeoutMs = Number(process.env.NEMA_ACCEPTANCE_TURN_MS ?? 180_000);
  const cwd = process.cwd();
  const rel = relative(cwd, resolve(cwd, out));
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).stdout?.trim() || null;
  const write = (body: Record<string, unknown>, code: number): number => {
    writeFileSync(out, JSON.stringify(body, null, 2) + "\n");
    console.log(JSON.stringify({ status: body.status, semantic: body.semantic, adapter, commit }, null, 2));
    return code;
  };
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return write({ status: "blocked", semantic: "not-run", adapter, configuredModel: model, commit, blocker: "refusing to write acceptance output inside the repository", checks: [] }, 2);
  }

  const codexHome = defaultCodexHome();
  const claudeTokenFile = typeof parsed["claude-token-file"] === "string" ? parsed["claude-token-file"] : "";
  const secretPaths = [codexHome, claudeTokenFile];
  const preflight = credentialPreflight({ adapter, codexAuthFile: join(codexHome, "auth.json"), claudeTokenFile });
  if (!preflight.ok) return write({ status: "blocked", semantic: "not-run", adapter, configuredModel: model, commit, blocker: preflight.blocker, checks: [] }, 2);

  const home = await mkdtemp(join(tmpdir(), "nema-accept-"));
  secretPaths.push(home);
  const closers: Array<() => Promise<void>> = [];
  let phase: "startup" | "turn" = "startup";
  try {
    saveConfig(home, adapter === "codex-direct"
      ? { adapter: "codex-direct", authMode: "compat", ...(model ? { model } : {}) }
      : { adapter: "claude-code", ...(model ? { model } : {}) });
    if (adapter === "claude-code") {
      const token = readFileSync(claudeTokenFile, "utf8").trim();
      if (token === "" || /[\r\n]/.test(token)) throw new Error("Claude Code token file must be a single line");
      saveClaudeToken(home, token);
    }
    const dataDir = join(home, "data");
    const db = await createLocalDb(join(home, "db"));
    closers.push(() => db.close());
    const token = randomBytes(32).toString("hex");
    const hub = await startHub({ db, dataDir, nemaHome: home, daemonToken: token, port: 0, webOrigin: "http://127.0.0.1:3000" });
    closers.push(() => hub.close());
    const daemon = startDaemon({ hubUrl: hub.url, token, nemaHome: home, userCodexHome: codexHome, version: "0.0.0", cliEntry: acceptanceCliEntry() });
    closers.push(() => daemon.close());
    const connectedAt = Date.now() + 10_000;
    let connected = false;
    while (Date.now() < connectedAt) {
      const status = await api<{ connected: boolean }>(hub.url, "GET", "/api/daemon/status");
      if (status.connected) { connected = true; break; }
      await sleep(100);
    }
    if (!connected) throw new Error("daemon did not connect");
    const plan = acceptanceWorkspacePlan();
    const openRoom = async (name: string): Promise<Room> => {
      const workspace = await api<{ id: string }>(hub.url, "POST", "/api/workspaces", { name });
      return { id: workspace.id, repo: repoPath(dataDir, workspace.id) };
    };
    const rooms = {
      memo: await openRoom(plan.memo),
      design: await openRoom(plan.design),
      brainstorm: await openRoom(plan.brainstorm),
      conflict: await openRoom(plan.conflict),
    };
    await seedRedisDecision(db, rooms.conflict.repo, rooms.conflict.id);
    phase = "turn";
    const ran = await script(db, hub.url, rooms, timeoutMs);
    const evaluation = evaluateSemantic(ran.input);
    return write({
      status: evaluation.ok ? "passed" : "failed",
      semantic: "evaluated",
      adapter,
      configuredModel: model,
      commit,
      credentialSource: preflight.credentialSource,
      checks: evaluation.checks,
      turns: ran.turns,
    }, evaluation.ok ? 0 : 1);
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error), secretPaths);
    const kind = classifyRunError(message, phase);
    return write({ status: kind === "blocked" ? "blocked" : "failed", semantic: "not-run", adapter, configuredModel: model, commit, blocker: message, checks: [] }, kind === "blocked" ? 2 : 1);
  } finally {
    for (const close of closers.reverse()) await close().catch(() => {});
    await rmRetry(home).catch(() => {});
  }
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("threadSemanticRun.ts") || entry.endsWith("threadSemanticRun.js")) {
  main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
