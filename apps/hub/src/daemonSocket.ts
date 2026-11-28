import type http from "node:http";
import { nanoid } from "nanoid";
import { WebSocketServer, type VerifyClientCallbackAsync, type WebSocket } from "ws";
import { createHostAllowed } from "./hostAllowlist.js";
import { KnowledgeStore } from "@nema/knowledge";
import { AttachmentRefSchema, DAEMON_CREDENTIAL_REVOKED_MESSAGE, WORKPACKAGE_LIMITS, normalizeRemoteUrl, parseDaemonToHub, parseManualSkill, parseRouteDecision, readCoded, readCodedTexts, type AgentMessageMeta, type DaemonStatusSnapshot, type RouteDecision, type AttachmentRef, type Entry, type HubToDaemon, type PluginToolSpec, type UserMessageMeta } from "@nema/shared";
import { createConnectionRpc, DAEMON_DISCONNECTED, DAEMON_NOT_CONNECTED, DaemonRpcError, withDaemonTarget, type ConnectionRpc, type DaemonResponder, type DaemonRpc, type DaemonTarget } from "./daemonRpc.js";
import { markDaemonSeen, revokeDaemon, verifyDaemonCredential, type RevokeRegisteredDaemon } from "./daemons.js";
import type { Db } from "./db/db.js";
import type { EventBus } from "./events.js";
import { chooseAskedQuestion, timeline } from "./entryIndex.js";
import { addMessage, deliverySet, getLastAskedQuestion, getMessage, listMessageVersions, listPromptMessages, listRecentMessages, messageExcerpt, type Message } from "./messages.js";
import { associateQuestion, conversationOf, ensureThread, getThread } from "./threads.js";
import { resolveMentions } from "./mentions.js";
import { listMembers } from "./members.js";
import { retainedSkills } from "./skillActivations.js";
import { announceInterrupted } from "./interrupts.js";
import { enabledPluginTools, grillState } from "./plugins.js";
import { recheckReports, registerReportToken } from "./reports.js";
import { buildPrompt, namedAnswerId, type WorkPackagePromptInput } from "./prompt.js";
import { onRepoMoved } from "./diagrams.js";
import { workPackageIdOf, workPackageRules } from "./workpackages.js";
import { applyRepoFetched, applyRepoMoved, listRepos, syncBoundRepos, trustedSkillRepos } from "./repos.js";
import { claimNextTask, computeWaitingReason, finishTask, getDaemonOwner, getTask, interruptRunning, listQueuedTasks, listTaskChanges, requeueDaemonTasks, resolveUiTask, type OnlineDaemon, type Task, type UiTask, type WaitingReason } from "./tasks.js";
import { getWorkspace, listWorkspaces, repoPath } from "./workspaces.js";
import type { OwnedHelperScope } from "@nema/shared/ownedHelper";
import { MIN_DAEMON_VERSION, compareVersions, versionSkewMessage } from "./hubVersion.js";
import { clearSkillOffers, listSkillOffers } from "./skillOffers.js";

type ProjectSkillRepo = Awaited<ReturnType<typeof trustedSkillRepos>>[number];
type BuiltTask = {
  prompt: string;
  confidential: boolean;
  attachments: AttachmentRef[];
  retainedSkills: string[];
  projectSkills: ProjectSkillRepo[];
  manualSkill: { skillId: string; arguments: string } | null;
  /**
   * The thread this task belongs to, when it is a thread task. The daemon looks up thread bindings by it;
   * hub knows it already (it fetched `conversationThread`) and the daemon could only guess it from prompt text.
   */
  threadId: string | null;
};

export type DaemonSocketDeps = { db: Db; dataDir: string; events: EventBus; daemonToken: string; hubUrl: string; ownedHelpers?: OwnedHelperScope; releaseVersion?: string; remoteAuth?: boolean;
  /**
   * #167 task 13: the hub's public origin as its remote daemons must reach it
   * (NEMA_HUB_PUBLIC_URL, e.g. `https://hub.example.lan`). A TLS-terminating reverse proxy
   * leaves the hub's own socket plain HTTP, so inferring the scheme from the upgrade would
   * hand daemons an `http://` URL whose room and attachment calls then go plaintext or fail.
   * When set, remote daemons get this origin instead of the upgrade-derived one; the local
   * daemon keeps `hubUrl` and this is never consulted. Forwarding headers are not trusted.
   */
  publicHubUrl?: string;
  /**
   * #167 task 15 F-1: the Host allowlist from NEMA_HUB_ALLOWED_HOSTS, the same list the HTTP guard uses.
   * While `remoteAuth` is on, a `/daemon` upgrade whose Host is neither loopback on the listening port nor
   * listed is refused with 403 before any hello. Without `remoteAuth` it is ignored and any Host may connect.
   */
  allowedHosts?: string[] };

type Conn = {
  ws: WebSocket;
  daemonId: string;
  /**
   * Minted for every accepted connection (#302 task 4), so a registered daemon reconnecting under its stable
   * `daemonId` is still told apart from its previous socket.
   */
  connectionId: string;
  /** Set when a hello of the same registered daemon retires this socket; that hello publishes the status instead. */
  replaced: boolean;
  /** The hub URL this daemon's task.assign carries: the hub's own loopback URL, or for a remote daemon the address it reached. */
  hubUrl: string;
  closed: Promise<void>;
  /** The running task as the UI sees it, cached so progress events carry its conversation without a DB read. */
  assigned: { task: UiTask; runToken: string } | null;
  rpc: ConnectionRpc;
  /** hello.features; "attachments" means the daemon fetches task.assign.attachments. */
  features: ReadonlySet<string>;
  /** A registered daemon (remote auth): its id is a `daemons` row with an owner. Local daemons are not. */
  registered: boolean;
  /** The `daemons.owner_user_id` of a registered daemon; null for a local daemon (member of every workspace). */
  ownerUserId: string | null;
  /** Normalized remote URLs this daemon reported holding (D-6); empty for daemons that report none. */
  heldRepos: Set<string>;
};

type TaskReplyRouting = {
  task: Task;
  taskMessage: Message;
  changes: AgentMessageMeta["changes"];
  touched: Entry[];
  askedQuestion: Entry | null;
  replyThread: string | null;
  createThread: boolean;
};

export const NO_ATTACHMENT_SUPPORT_MESSAGE = "当前 daemon 不支持附件，请升级 CLI";
/** An older daemon would drop `accountId` from `task.assign` and run the task on its default account. */
export const NO_ACCOUNT_SUPPORT_MESSAGE = "当前 daemon 不支持按账户运行任务，请升级 CLI 后再指定账户";

export const OLD_CLI_MESSAGE = "nema CLI 版本过旧，请运行 npm run build -w apps/cli 并重启 nema daemon";
/** Distinct from the credential refusals: the daemon's credential was not judged, so it should simply retry. */
export const REMOTE_HELLO_FAILED_MESSAGE = "The hub hit an internal error while accepting this daemon. The daemon will retry.";
/** A registered daemon's stale socket that ignores the close handshake is terminated after this long. */
const REPLACED_CLOSE_TIMEOUT_MS = 1_000;

/**
 * Normalizes NEMA_HUB_PUBLIC_URL to an origin (`https://hub.example.lan`, optional port kept).
 * Undefined or blank stays undefined (the upgrade-derived URL is used). Anything that is not
 * exactly an http(s) origin — a path, query, fragment, or another scheme — is a deployer error
 * and throws, so a mistyped value fails startup instead of silently handing daemons a bad URL.
 */
export function parsePublicHubUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`NEMA_HUB_PUBLIC_URL must be an http(s) origin, got ${JSON.stringify(value)}`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`NEMA_HUB_PUBLIC_URL must be an http(s) origin without a path, got ${JSON.stringify(value)}`);
  }
  return url.origin;
}

/**
 * The URL a remote daemon reached this hub at, from the WebSocket upgrade's Host header. Another machine
 * cannot use the hub's loopback URL for room calls or attachment downloads. Null when Host is not a bare host[:port].
 * Behind a TLS-terminating proxy the scheme here is `http` (the hub's own socket is plain), so a configured
 * public URL (parsePublicHubUrl) takes precedence for remote daemons; see DaemonSocketDeps.publicHubUrl.
 */
function hubUrlFromUpgrade(req: http.IncomingMessage | undefined): string | null {
  const host = req?.headers.host?.trim();
  if (!host || /[/\\@?#\s]/.test(host)) return null;
  const scheme = (req?.socket as { encrypted?: boolean } | undefined)?.encrypted ? "https" : "http";
  try {
    return new URL(`${scheme}://${host}`).origin;
  } catch {
    return null;
  }
}

/**
 * The remote form's `/daemon` upgrade check: the same Host predicate as the HTTP guard (createHostAllowed),
 * against the port the server actually listens on. A refused upgrade is answered `403 Forbidden` and never
 * reaches hello, matching the HTTP guard's 403; the refusal is logged with the offending Host, JSON-quoted.
 */
function daemonUpgradeHostCheck(
  server: http.Server,
  opts: { allowedHosts?: string[]; remoteAuth?: boolean },
): VerifyClientCallbackAsync {
  // The two-argument form: a synchronous `false` would make ws answer 401, which reads as an auth failure.
  return ({ req }, done) => {
    const address = server.address();
    const host = req.headers.host;
    const ok = typeof address === "object" && address !== null && host !== undefined
      && createHostAllowed(address.port, opts)(host);
    if (ok) return done(true);
    console.warn(`daemon upgrade refused: forbidden host ${JSON.stringify(host ?? null)}`);
    done(false, 403, "forbidden host");
  };
}

export function attachDaemonSocket(server: http.Server, deps: DaemonSocketDeps): {
  /** Any daemon online; with an id, that daemon online. */
  isConnected(daemonId?: string): boolean;
  /** Ids of the daemons online, oldest connection first. */
  connectedDaemonIds(): string[];
  /** The online daemons as the waiting-reason derivation sees them, in acceptance order. */
  connectionSnapshot(): OnlineDaemon[];
  /** Why a queued task is still waiting, or null when no daemon-side reason applies. */
  waitingReasonFor(task: Task): Promise<WaitingReason | null>;
  /** The current connection (see `currentConnection`), read from the table now; what `daemon.status` publishes. */
  statusSnapshot(): DaemonStatusSnapshot;
  rpc: DaemonRpc;
  revokeRegisteredDaemon: RevokeRegisteredDaemon;
  close(): Promise<void>;
} {
  const { db, dataDir, events } = deps;
  const wss = new WebSocketServer({
    server,
    path: "/daemon",
    // #167 task 15 F-1: the remote form applies the HTTP guard's Host allowlist to this upgrade too.
    // Without it a DNS-rebinding page could still open /daemon; the local form keeps accepting any Host.
    ...(deps.remoteAuth ? { verifyClient: daemonUpgradeHostCheck(server, { allowedHosts: deps.allowedHosts, remoteAuth: deps.remoteAuth }) } : {}),
  });
  /**
   * The connection table (#167): every accepted daemon by its id, in acceptance order. A hello adds its
   * connection and leaves the others alone; a close removes only its own. The only replacement left is a
   * registered daemon reconnecting under its own stable id while its stale socket is still open.
   */
  const connections = new Map<string, Conn>();
  const isOpen = (conn: Conn): boolean => conn.ws.readyState === conn.ws.OPEN;
  const isListed = (conn: Conn): boolean => connections.get(conn.daemonId) === conn;
  const openConnections = (): Conn[] => [...connections.values()].filter(isOpen);
  /** The newest of `open`: who answers a call without a target (`chooseConnection` rule 4). */
  const newestOf = (open: Conn[]): Conn | undefined => open[open.length - 1];
  /**
   * The current connection (#302 task 4): the one a call without a target lands on. The status snapshot, the
   * `daemon.status` event and the readiness route's responder check all read it through this one function.
   */
  const currentConnection = (): Conn | undefined => newestOf(openConnections());
  const statusSnapshot = (): DaemonStatusSnapshot => {
    const conn = stopping ? undefined : currentConnection();
    return conn
      ? { connected: true, daemonId: conn.daemonId, connectionId: conn.connectionId }
      : { connected: false, daemonId: null, connectionId: null };
  };
  let published: DaemonStatusSnapshot = { connected: false, daemonId: null, connectionId: null };
  /**
   * Retired sockets of registered daemons in the middle of replacing their own connection: the retired socket
   * is closed and its successor is not listed yet. The replacement publishes the actual state when it ends,
   * whether the successor was listed or the hello failed (`publishStatus` below says what holds off meanwhile).
   */
  const retiring = new Set<Conn>();
  type Replacing = { happened: boolean; retired?: Conn };
  const endReplacement = (replacing: Replacing | undefined): void => {
    if (!replacing?.retired) return;
    retiring.delete(replacing.retired);
    delete replacing.retired;
  };
  /**
   * Publishes `daemon.status` when the current connection differs from the last one published. The value is
   * read from the table at publish time, never carried over from before an await, so an event never names a
   * connection that is already gone (spec D-4: only events consistent with the current state are published).
   *
   * While a replacement is in flight two changes are held back, because the successor is about to be listed and
   * would only undo them: going offline (the gap would read as a false `connected: false` blip), and moving off
   * a published connection that is the one being retired (a direct replacement reads as `true → true`). Any other
   * change is real and goes out now: when the published connection left for good and another one is open, that
   * one is current, as HTTP already reports.
   */
  const publishStatus = (): void => {
    if (stopping) return;
    const now = statusSnapshot();
    if (retiring.size > 0) {
      if (!now.connected) return;
      if ([...retiring].some((conn) => conn.connectionId === published.connectionId)) return;
    }
    if (now.connected === published.connected && now.daemonId === published.daemonId && now.connectionId === published.connectionId) return;
    published = now;
    events.emitGlobal({ type: "daemon.status", ...now });
  };
  /** A daemon's reported holdings, normalized; an entry that is not a remote URL is dropped. */
  const normalizeHeld = (held: readonly string[]): Set<string> =>
    new Set(held.map((r) => normalizeRemoteUrl(r)).filter((r): r is string => r !== null));
  let chain: Promise<void> = Promise.resolve();
  // A revocation and a remote hello must agree on which side of the revocation the socket became current.
  let registry: Promise<unknown> = Promise.resolve();
  const withRegistry = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = registry.then(operation);
    registry = next.catch(() => {});
    return next;
  };
  let moves: Promise<void> = Promise.resolve();
  let stopping = false;
  const pending = new Set<Promise<void>>();
  const track = (promise: Promise<void>): void => {
    pending.add(promise);
    void promise.then(() => pending.delete(promise), () => pending.delete(promise));
  };

  const send = (ws: WebSocket, m: HubToDaemon) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  };
  /** The online daemons as the waiting-reason derivation sees them, in acceptance order. */
  const connectionSnapshot = (): OnlineDaemon[] =>
    openConnections().map((conn) => ({ ownerUserId: conn.ownerUserId, heldRepos: conn.heldRepos }));
  /** Why a queued task is still waiting, for the UI; also exposed to the REST layer (see `waitingReasonFor`). */
  const waitingReasonFor = async (task: Task): Promise<WaitingReason | null> =>
    task.status === "queued" ? computeWaitingReason(db, task, connectionSnapshot()) : null;
  const emitTask = async (taskId: string, options?: { reasonOnly?: boolean }) => {
    const t = await getTask(db, taskId);
    if (t) {
      events.emit(t.workspaceId, {
        type: "task.updated",
        task: await resolveUiTask(db, t, await waitingReasonFor(t)),
        ...(options?.reasonOnly ? { reasonOnly: true as const } : {}),
      });
    }
  };
  /**
   * Republish the waiting reason for every still-queued task in the workspaces this connection may
   * serve. A holdings refresh can change why a task waits (or leave it waiting for a different repo)
   * without claiming it, and without this the UI keeps showing the reason computed before the refresh.
   * These are reason-only updates: they carry `reasonOnly` so the dispatch subscriber skips them —
   * the holdings handler already dispatched once before this runs, and one refresh must not fan out
   * into a full dispatch per queued task.
   */
  const emitQueuedWaitingReasons = async (conn: Conn): Promise<void> => {
    // Membership mirrors the claim predicate (D-6): a registered daemon serves only its owner's
    // workspaces; a local daemon (owner null) serves every workspace.
    const workspaceIds =
      conn.ownerUserId === null
        ? (await listWorkspaces(db)).map((w) => w.id)
        : (await db.query<{ workspace_id: string }>(
            `select workspace_id from workspace_members where user_id = $1 and removed_at is null`,
            [conn.ownerUserId],
          )).map((r) => r.workspace_id);
    for (const workspaceId of workspaceIds) {
      for (const task of await listQueuedTasks(db, workspaceId)) await emitTask(task.id, { reasonOnly: true });
    }
  };

  async function taskReplyRouting(taskId: string): Promise<TaskReplyRouting | null> {
    const task = await getTask(db, taskId);
    if (!task) return null;
    const taskMessage = await getMessage(db, task.messageId);
    if (!taskMessage) return null;
    const changes = (await listTaskChanges(db, taskId)) as AgentMessageMeta["changes"];
    const store = new KnowledgeStore(repoPath(dataDir, task.workspaceId), deps.ownedHelpers);
    const touched = (await Promise.all(
      [...new Set(changes.filter((change) => change.kind === "question").map((change) => change.entryId))]
        .map((id) => store.get(id)),
    )).filter((entry): entry is Entry => entry !== null);
    const grillOn = (await grillState(db, task.workspaceId)).enabled;
    const askedQuestion = grillOn ? chooseAskedQuestion(touched, null) : null;
    const existingThread = await conversationOf(db, taskMessage);
    const createThread = !existingThread && grillOn && askedQuestion !== null;
    return {
      task,
      taskMessage,
      changes,
      touched,
      askedQuestion,
      replyThread: existingThread ?? (createThread ? taskMessage.id : null),
      createThread,
    };
  }

  async function saveTaskOutcome(
    routing: TaskReplyRouting,
    expectedRunToken: string,
    result: { ok: true } | { ok: false; error: string },
    role: "agent" | "system",
    content: string,
    meta?: AgentMessageMeta,
  ): Promise<Message | null> {
    return db.tx(async (t) => {
      if (!(await finishTask(t, routing.task.id, result, expectedRunToken))) return null;
      // Read under the task row lock finishTask now holds: an offer still being written either
      // committed first and is read here, or waits and then sees the task finished and is refused.
      // A failed task's offers are not shown at all.
      const offers = await listSkillOffers(t, routing.task.id);
      if (meta && offers.length > 0) meta = { ...meta, skillOffers: offers };
      await clearSkillOffers(t, routing.task.id);
      if (routing.createThread && routing.askedQuestion) {
        await ensureThread(t, routing.taskMessage.id, routing.askedQuestion.title, "grill");
      }
      const message = await addMessage(t, routing.task.workspaceId, role, content, {
        taskId: routing.task.id,
        ...(meta ? { meta } : {}),
        threadId: routing.replyThread,
      });
      if (routing.replyThread) {
        for (const entry of routing.touched) {
          if (entry.kind === "question" && entry.status === "open") {
            await associateQuestion(t, routing.task.workspaceId, entry.id, routing.replyThread);
          }
        }
      }
      return message;
    });
  }

  /** Requeues a daemon's running tasks and announces each so UIs see them as queued again. */
  async function requeueAndEmit(daemonId: string): Promise<void> {
    const ids = (await db.query<{ id: string }>(`select id from tasks where daemon_id = $1 and status = 'running'`, [daemonId])).map((r) => r.id);
    await requeueDaemonTasks(db, daemonId);
    for (const id of ids) await emitTask(id);
  }

  async function buildTaskPrompt(task: Task): Promise<BuiltTask> {
    const workspace = await getWorkspace(db, task.workspaceId);
    if (!workspace) throw new Error("workspace not found");
    const userMessage = await getMessage(db, task.messageId);
    if (!userMessage) throw new Error("task message not found");
    const editing = task.kind === "edit";
    const conversationId = await conversationOf(db, userMessage);
    const contextLimit = conversationId ? 50 : 20;
    const before = editing
      ? await listRecentMessages(db, task.workspaceId, userMessage.id, contextLimit)
      : await listPromptMessages(db, task.workspaceId, userMessage.id, contextLimit);
    // A system-started task, a report, or an edit re-run is not the user's answer to the last follow-up question.
    // A message that names `回答 Q-n：` answers that question even when a newer follow-up exists.
    const named = !editing && userMessage.role === "user" ? namedAnswerId(userMessage.content) : null;
    const asked = named
      ? { id: named }
      : editing || userMessage.role === "system" || userMessage.role === "report"
        ? undefined
        : await getLastAskedQuestion(db, task.workspaceId, conversationId);
    const store = new KnowledgeStore(repoPath(dataDir, task.workspaceId), deps.ownedHelpers);
    const lastAskedQuestion = asked ? await store.get(asked.id) : null;
    let workpackage: WorkPackagePromptInput | undefined;
    if (task.kind === "workpackage") {
      const id = workPackageIdOf(userMessage.content);
      const wp = id ? await store.get(id) : null;
      if (!wp?.workpackage) throw new Error(`找不到开发包 ${id ?? "（未知）"}`);
      const repos = await listRepos(db, task.workspaceId);
      workpackage = {
        id: wp.id,
        requirements: wp.workpackage.requirements,
        repos: repos.map((r) => ({ id: r.id, label: r.label })),
        rules: workPackageRules(),
      };
    }
    const edit = editing
      ? {
          previousContent: (await listMessageVersions(db, userMessage.id)).at(-1)?.content ?? "",
          cited: await store.entriesCiting(userMessage.id),
        }
      : null;
    const userMeta = userMessage.role === "user" ? (userMessage.meta as UserMessageMeta | null) : null;
    const quoteId = userMeta?.quote?.messageId;
    const quotedMessage = quoteId ? await getMessage(db, quoteId) : null;
    const conversationThread = conversationId ? await getThread(db, conversationId) : null;
    const conversationAnchor = conversationId ? await getMessage(db, conversationId) : null;
    // Every ref is checked against AttachmentRefSchema here as well as when it was read.
    const attachments = AttachmentRefSchema.array().parse(await deliverySet(db, task.id));
    // Mentions are read now, latest entries and the files as they are: only the current message's own mentions.
    const resolved = userMeta?.mentions?.length
      ? await resolveMentions(db, dataDir, task.workspaceId, userMeta.mentions, { ...(deps.ownedHelpers ? { ownedHelpers: deps.ownedHelpers } : {}) })
      : null;
    // The roster once per task: names for recent user messages, only shown with two or more active members.
    const roster = await listMembers(db, task.workspaceId);
    const authors = {
      names: new Map(roster.map((m) => [m.userId, m.displayName] as const)),
      multiMember: roster.filter((m) => m.removedAt === null).length >= 2,
    };
    const prompt = await buildPrompt({
      workspace,
      userMessage,
      recentMessages: before,
      entries: await timeline(db, dataDir, task.workspaceId, deps.ownedHelpers),
      lastAskedQuestion,
      priorChanges: await listTaskChanges(db, task.id),
      grill: await grillState(db, task.workspaceId),
      ...(workpackage ? { workpackage } : {}),
      ...(quotedMessage ? { quotedMessage } : {}),
      ...(edit ? { edit } : {}),
      ...(conversationThread && conversationAnchor ? { conversation: { thread: conversationThread, anchor: conversationAnchor, opened: conversationThread.openedBy } } : {}),
      deliveredAttachmentIds: attachments.map((a) => a.id),
      ...(resolved ? { mentions: resolved } : {}),
      authors,
    });
    // A thread's activated Skills come back on its next task; ids only, the daemon reads them again.
    const retained = conversationId ? await retainedSkills(db, conversationId) : [];
    // Only repositories the user trusts; the daemon reads their Skills at the main commit.
    const projectSkills = await trustedSkillRepos(db, task.workspaceId);
    // `/name …` at the start of the user's own message (its current text after an edit); the daemon resolves it.
    const manual = userMessage.role === "user" && task.kind !== "workpackage" ? parseManualSkill(userMessage.content) : null;
    return { prompt, confidential: workspace.confidential, attachments, retainedSkills: retained, projectSkills, manualSkill: manual, threadId: conversationId };
  }

  async function saveTaskFailure(taskId: string, error: string, expectedRunToken?: string, route?: RouteDecision): Promise<Message | null> {
    const routing = await taskReplyRouting(taskId);
    if (!routing) return null;
    const runToken = expectedRunToken ?? routing.task.runToken;
    if (!runToken) return null;
    // A failed task has no reply to hang the route on, so the account is named in the failure line itself
    // (spec §1.3) and the record is kept beside it, still without any credential.
    const account = route ? `（账户「${route.accountName}」· ${route.model}）` : "";
    return saveTaskOutcome(routing, runToken, { ok: false, error }, "system", "处理失败：" + error + account, route ? { route } as AgentMessageMeta : undefined);
  }

  /** Offers work to every idle connection in acceptance order; each runs one task at a time. */
  async function dispatchOnce(): Promise<void> {
    for (const conn of [...connections.values()]) {
      if (stopping) return;
      await dispatchTo(conn);
    }
  }

  async function dispatchTo(conn: Conn): Promise<void> {
    for (;;) {
      if (stopping) return;
      if (!isListed(conn) || conn.assigned || !isOpen(conn)) return;
      // The claim is filtered to what this connection may run (D-6): membership, held repos, one task per
      // workspace. A connection that qualifies for nothing claims nothing.
      const task = await claimNextTask(db, conn.daemonId, { heldRepos: conn.heldRepos });
      if (stopping) return;
      if (!task) return;
      if (!isListed(conn)) {
        await requeueAndEmit(conn.daemonId);
        return;
      }
      let built: BuiltTask;
      let uiTask: UiTask;
      let pluginTools: PluginToolSpec[] = [];
      try {
        built = await buildTaskPrompt(task);
        // An older daemon would drop the field and answer from the text alone; fail the task instead.
        if (built.attachments.length > 0 && !conn.features.has("attachments")) throw new Error(NO_ATTACHMENT_SUPPORT_MESSAGE);
        // Same hazard as an attachment, same answer: a daemon that does not know `accountId` parses the
        // message by dropping it, so the task would silently run on whichever account is the default on that
        // machine — the one thing the user did not choose. Failing here names the reason instead.
        if (task.accountId !== null && !conn.features.has("accounts")) throw new Error(NO_ACCOUNT_SUPPORT_MESSAGE);
        pluginTools = await enabledPluginTools(db, task.workspaceId);
        uiTask = await resolveUiTask(db, task);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        try {
          const msg = task.runToken ? await saveTaskFailure(task.id, error, task.runToken) : null;
          if (msg) {
            events.emit(task.workspaceId, { type: "message.created", message: msg });
            if (msg.threadId) {
              const thread = await getThread(db, msg.threadId);
              if (thread) events.emit(task.workspaceId, { type: "thread.updated", thread });
            }
            await emitTask(task.id);
          }
        } catch (e2) {
          console.error("[daemon] failed to record prompt failure", e2);
          await requeueAndEmit(conn.daemonId).catch(() => {});
          return;
        }
        continue;
      }
      if (stopping) return;
      if (!isListed(conn) || !isOpen(conn)) {
        await requeueAndEmit(conn.daemonId);
        return;
      }
      conn.assigned = { task: uiTask, runToken: task.runToken! };
      send(conn.ws, {
        type: "task.assign",
        taskId: task.id,
        workspaceId: task.workspaceId,
        adapter: "auto",
        confidential: built.confidential,
        prompt: built.prompt,
        runToken: task.runToken!,
        hubUrl: conn.hubUrl,
        pluginTools,
        ...(task.kind === "workpackage" ? { limits: { ...WORKPACKAGE_LIMITS } } : {}),
        ...(built.attachments.length > 0 ? { attachments: built.attachments } : {}),
        ...(built.retainedSkills.length > 0 ? { retainedSkills: built.retainedSkills } : {}),
        ...(built.projectSkills.length > 0 ? { projectSkills: built.projectSkills } : {}),
        ...(built.manualSkill ? { manualSkill: built.manualSkill } : {}),
        // The account choice and the routing allowance travel down as they were recorded; the daemon decides
        // what they mean, because accounts exist only on its machine (spec 2026-10-31 §5.4).
        ...(task.accountId ? { accountId: task.accountId } : {}),
        ...(task.routing ? { routing: "auto" as const } : {}),
        ...(built.threadId ? { threadId: built.threadId } : {}),
      });
      events.emit(task.workspaceId, { type: "task.updated", task: uiTask });
      return;
    }
  }

  // Dispatches are serialized so concurrent triggers never double-claim.
  const dispatch = (): Promise<void> => {
    chain = chain.then(dispatchOnce).catch((e) => console.error("[daemon] dispatch failed", e));
    track(chain);
    return chain;
  };

  async function onFinished(conn: Conn, m: Extract<ReturnType<typeof parseDaemonToHub>, { type: "task.finished" }>) {
    const a = conn.assigned;
    if (!a || a.task.id !== m.taskId) return;
    // The message schema accepts any `route` so that a route this hub cannot read cannot take the reply
    // down with it (see `parseRouteDecision`). Parsed here, at the only place it is stored: an unreadable
    // route is dropped as metadata and its account line is not shown, but the reply or error is still saved.
    const route = parseRouteDecision(m.route);
    let msg: Message | null;
    if (m.ok) {
      const routing = await taskReplyRouting(m.taskId);
      if (!routing) {
        conn.assigned = null;
        return;
      }
      const meta: AgentMessageMeta = {
        changes: routing.changes,
        askedQuestion: routing.askedQuestion ? { id: routing.askedQuestion.id, title: routing.askedQuestion.title, body: routing.askedQuestion.body } : null,
      };
      if (routing.task.kind === "edit") {
        const edited = await getMessage(db, routing.task.messageId);
        if (edited) meta.quote = { messageId: edited.id, role: edited.role, excerpt: messageExcerpt(edited.content) };
      }
      // An older daemon sends no route; the message is stored exactly as before.
      if (route) meta.route = route;
      msg = await saveTaskOutcome(routing, a.runToken, { ok: true }, "agent", m.reply, meta);
    } else {
      msg = await saveTaskFailure(m.taskId, m.error, a.runToken, route);
    }
    if (!msg) {
      conn.assigned = null;
      return;
    }
    conn.assigned = null;
    events.emit(a.task.workspaceId, { type: "message.created", message: msg });
    if (msg.threadId) {
      const thread = await getThread(db, msg.threadId);
      if (thread) events.emit(a.task.workspaceId, { type: "thread.updated", thread });
    }
    await emitTask(m.taskId);
    await dispatch();
  }

  wss.on("connection", (ws, req) => {
    let conn: Conn | null = null;
    // Only a remote daemon needs the address it connected to; the local daemon shares the hub's loopback.
    // A configured public origin wins over the upgrade-derived one: behind a TLS-terminating proxy the
    // upgrade would otherwise infer http:// and the daemon's room/attachment calls would go plaintext.
    const hubUrl = deps.remoteAuth ? (deps.publicHubUrl ?? hubUrlFromUpgrade(req)) : deps.hubUrl;
    // Per-connection serial handling keeps hello/finished ordering intact.
    let inbox: Promise<void> = Promise.resolve();
    // Messages waiting in `inbox` that have not started; and whether the one being handled is the hello.
    let queued = 0;
    let inHello = false;

    let finishClose!: () => void;
    const closed = new Promise<void>((resolve) => { finishClose = resolve; });
    const reject = (message: string) => {
      send(ws, { type: "error", message });
      ws.close();
    };

    /**
     * `replacing.happened` is set once this hello retires a previous socket of the same registered daemon;
     * `replacing.retired` holds that socket until the successor is listed or the hello gives up (`endReplacement`).
     */
    const hello = async (m: Extract<ReturnType<typeof parseDaemonToHub>, { type: "hello" }>, replacing?: Replacing) => {
      if (stopping || ws.readyState !== ws.OPEN) return;
      let registeredId: string | undefined;
      if (deps.remoteAuth) {
        const verified = await verifyDaemonCredential(db, m.token);
        if (!verified.ok) return reject(verified.error);
        registeredId = verified.id;
      } else if (m.token !== deps.daemonToken) {
        return reject("daemon token 无效");
      }
      // D-9: below the minimum compatible version the daemon is refused with an upgrade pointer.
      // At or above the floor it is admitted whatever the hub version is; protocol drift is caught by
      // the features checks at dispatch time, not by guessing from the version. A missing heldRepos
      // report (an older daemon) is not a version refusal: it only means an empty held set (D-6).
      if (deps.releaseVersion && compareVersions(m.version, MIN_DAEMON_VERSION) < 0) {
        return reject(versionSkewMessage(deps.releaseVersion));
      }
      // Older CLIs silently drop adapter:"auto" assignments.
      if (!m.adapters.some((a) => a === "codex-direct" || a === "codex-cli")) return reject(OLD_CLI_MESSAGE);
      if (!hubUrl) return reject("The hub could not tell which address this daemon connected to. Connect with a hub URL of the form http://host:port.");

      if (registeredId) {
        // The same daemon reconnecting while its stale socket is still listed: one id holds one table entry,
        // so retire that socket and await its task cleanup before assigning under the same stable ID.
        // This never touches another daemon's connection.
        const previous = connections.get(registeredId);
        if (previous) {
          // Its close stays quiet about the status: this hello publishes it, whatever the outcome (#302 task 4),
          // so a direct replacement reads as `true → true` with a new connectionId rather than a false blip.
          // Until then another close publishes only a real change (see `publishStatus`): with the retired socket
          // gone and the successor not yet listed, it must not publish a false `connected: false`.
          previous.replaced = true;
          if (replacing && !replacing.retired) {
            replacing.happened = true;
            replacing.retired = previous;
            retiring.add(previous);
          }
          previous.ws.close();
          // A peer that never answers the close frame must not hold this hello, or the registry lock, open.
          let timer: NodeJS.Timeout | undefined;
          const timedOut = await Promise.race([
            previous.closed.then(() => false),
            new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), REPLACED_CLOSE_TIMEOUT_MS); }),
          ]);
          clearTimeout(timer);
          if (timedOut) {
            previous.ws.terminate();
            // terminate() emits close, so the old socket's usual cleanup still runs before this ID is reused.
            await previous.closed;
          }
        }
        if (stopping || ws.readyState !== ws.OPEN) return;
        await markDaemonSeen(db, registeredId);
      }
      if (m.reportTokenHash) await registerReportToken(db, m.reportTokenHash);
      if (stopping || ws.readyState !== ws.OPEN) return;
      // A failed close cleanup can leave running tasks under this stable ID.
      const recovered = registeredId ? await interruptRunning(db, { daemonId: registeredId }) : null;
      if (stopping || ws.readyState !== ws.OPEN) {
        if (!stopping && recovered) await announceInterrupted(db, events, recovered);
        return;
      }
      const accepted: Conn = {
        ws,
        daemonId: registeredId ?? `d_${nanoid(10)}`,
        connectionId: `c_${nanoid(12)}`,
        replaced: false,
        hubUrl,
        closed,
        assigned: null,
        features: new Set(m.features ?? []),
        registered: registeredId !== undefined,
        // The credential was verified above, so a registered id has an owner here.
        ownerUserId: registeredId ? ((await getDaemonOwner(db, registeredId)) ?? null) : null,
        heldRepos: normalizeHeld(m.heldRepos ?? []),
        rpc: createConnectionRpc((id, method, params) => send(ws, { type: "rpc.request", id, method, params })),
      };
      conn = accepted;
      // Delete first so a re-listed id moves to the end: the table stays in acceptance order.
      connections.delete(accepted.daemonId);
      connections.set(accepted.daemonId, accepted);
      // Visible and published together: `statusSnapshot` (GET /api/daemon/status) reads this table from here on,
      // so the event goes out now too. A reader that adopted this connection over HTTP is then sure to hear of
      // its leaving, even when it closes before the hello finishes (its close publishes the change back).
      endReplacement(replacing);
      publishStatus();
      // Wait for any unsent claim of a closing socket to be requeued without counting an interruption.
      const pendingDispatch = chain;
      try {
        await pendingDispatch;
        if (stopping) return;
        // Orphans only: running tasks whose daemon has no listed connection (a close cleanup that failed).
        // Every listed daemon's tasks are left alone; with one daemon this is every task not its own, as before.
        await announceInterrupted(db, events, await interruptRunning(db, { exceptDaemonIds: [...connections.keys()] }));
        if (stopping || ws.readyState !== ws.OPEN) return;
        const workspaceIds = (await listWorkspaces(db)).map((w) => w.id);
        if (stopping || ws.readyState !== ws.OPEN) return;
        send(ws, { type: "welcome", workspaceIds });
        track(syncBoundRepos(db, accepted.rpc).catch((error) => { if (!stopping) console.error("[daemon] repos.sync failed", error); }));
        // Already published when listed; this only catches a change since (publishStatus skips an unchanged value).
        publishStatus();
      } finally {
        if (!stopping && recovered) await announceInterrupted(db, events, recovered);
      }
    };

    const handle = async (raw: string) => {
      if (stopping) return;
      let m;
      try {
        m = parseDaemonToHub(JSON.parse(raw));
      } catch {
        return;
      }
      if (!conn) {
        if (m.type !== "hello") return;
        inHello = true;
        try {
          if (deps.remoteAuth) {
            const replacing: Replacing = { happened: false };
            try {
              await withRegistry(() => hello(m, replacing));
            } catch (error) {
              // A database or dependency failure is not a credential decision; say so, and keep the cause.
              console.error("[daemon] remote hello failed", error);
              reject(REMOTE_HELLO_FAILED_MESSAGE);
            } finally {
              // The retired socket's close, and any close during the replacement, published nothing; whatever
              // happened to this hello (successor listed, refused or failed), say who is current now.
              endReplacement(replacing);
              if (replacing.happened) publishStatus();
            }
          } else {
            await hello(m);
          }
          if (conn && ws.readyState === ws.OPEN) await dispatch();
        } finally {
          inHello = false;
        }
        return;
      }
      if (ws.readyState !== ws.OPEN) return;
      if (m.type === "holdings") {
        // A repos.sync changed what this daemon watches: replace its held set wholesale. A repo newly
        // held may unblock a queued task, so offer work again.
        conn.heldRepos = normalizeHeld(m.heldRepos);
        await dispatch();
        await emitQueuedWaitingReasons(conn);
      } else if (m.type === "task.event") {
        const task = conn.assigned?.task;
        if (task?.id !== m.taskId) return;
        // The daemon's code fields are relayed only after sanitising: an older daemon sends none, and a
        // malformed one costs the translation, never the line (#299 batch 1).
        const items = readCodedTexts(m.event.items);
        events.emit(task.workspaceId, {
          type: "task.progress", taskId: m.taskId, threadId: task.threadId, text: m.event.text,
          ...readCoded(m.event.code, m.event.params),
          ...(items && items.length > 0 ? { items } : {}),
        });
      } else if (m.type === "task.finished") {
        await onFinished(conn, m);
      } else if (m.type === "rpc.response") {
        conn.rpc.onResponse(m);
      } else if (m.type === "repo.moved") {
        if (await applyRepoMoved(db, events, m)) {
          // Not awaited here: it waits on daemon RPC replies, which arrive through this same inbox.
          // Moves are chained so two quick moves of one repo settle in order.
          const move = { repoId: m.repoId, to: m.to };
          // The daemon that saw the move has the repo checked out: its follow-up calls go back to it.
          const reporter = withDaemonTarget(rpc, { daemonId: conn.daemonId });
          moves = moves
            .then(() => onRepoMoved(db, dataDir, reporter, events, move, deps.ownedHelpers))
            .catch((e) => { if (!stopping) console.error("[daemon] diagram staleness check failed", e); })
            .then(() => recheckReports({ db, events, daemon: reporter, dataDir, ownedHelpers: deps.ownedHelpers }, move.repoId))
            .catch((e) => { if (!stopping) console.error("[daemon] report re-check failed", e); });
          track(moves);
        }
      } else if (m.type === "repo.fetched") {
        await applyRepoFetched(db, m);
      }
    };

    /**
     * Settles an `rpc.response` at once when only this connection's hello is ahead of it in the inbox (#302 task 4).
     * The connection is listed, and its status published, before the hello finishes (dispatch, workspace list,
     * welcome); a caller that reacted to that event can get its reply before then, and queueing the reply behind
     * the hello would let the call time out although the daemon answered. Nothing else is overtaken: with any
     * other message waiting, the reply keeps its place in the queue.
     */
    const settleEarly = (raw: string): boolean => {
      if (!conn || !inHello || queued > 0 || stopping) return false;
      let m;
      try {
        m = parseDaemonToHub(JSON.parse(raw));
      } catch {
        return false;
      }
      if (m.type !== "rpc.response") return false;
      conn.rpc.onResponse(m);
      return true;
    };

    ws.on("message", (d) => {
      const raw = String(d);
      if (settleEarly(raw)) return;
      queued += 1;
      inbox = inbox.then(() => {
        queued -= 1;
        return handle(raw);
      }).catch((e) => console.error("[daemon] message failed", e));
      track(inbox);
    });
    ws.on("error", () => {});
    ws.on("close", () => {
      // A close settles this connection only: its own running task and pending calls. Other daemons'
      // connections and tasks are untouched.
      inbox = inbox.then(async () => {
        if (!conn || stopping) return;
        const assigned = conn.assigned;
        conn.assigned = null;
        conn.rpc.failAll(DAEMON_DISCONNECTED);
        // A claim that never reached task.assign is not an interruption.
        if (deps.remoteAuth) await chain;
        if (assigned) await announceInterrupted(db, events, await interruptRunning(db, { daemonId: conn.daemonId }));
        else await requeueAndEmit(conn.daemonId);
      }).catch((e) => console.error("[daemon] close failed", e)).finally(() => {
        if (conn && isListed(conn)) connections.delete(conn.daemonId);
        // The current connection may have changed: to an older one, or to none (connected: false, it turns off
        // only when no daemon is left online). A socket retired by its own daemon's new hello leaves it to that hello;
        // while a replacement is in flight `publishStatus` holds back only what the successor would undo.
        if (conn && !conn.replaced) publishStatus();
        finishClose();
      });
      track(inbox);
    });
  });

  const unsubscribe = events.subscribeAll((_ws, e) => {
    // A reason-only waiting-reason republish (holdings refresh) is UI news, not new work: the refresh
    // already dispatched once, so dispatching again per queued task would fan out into one full
    // dispatch per task. Every other queued task.updated still dispatches as before.
    if (e.type === "task.updated" && e.task.status === "queued" && !e.reasonOnly) void dispatch();
    else if (e.type === "thread.updated") {
      // An agent can turn its current main-chat message into an anchor while running. Any connection
      // may be running that message's task, so check each one's cached assignment.
      const thread = e.thread;
      for (const conn of connections.values()) {
        const assigned = conn.assigned;
        if (assigned && assigned.task.threadId === null && assigned.task.workspaceId === thread.workspaceId && assigned.task.messageId === thread.id) {
          assigned.task = { ...assigned.task, threadId: thread.id };
          events.emit(thread.workspaceId, { type: "task.updated", task: assigned.task });
        }
      }
    } else if (e.type === "workspace.deleted") {
      // Any connected daemon may hold isolation dirs or watched repos for the workspace: tell every one,
      // then push each the bound-repo list again (syncBoundRepos addresses all daemons).
      const open = openConnections();
      if (open.length === 0) return;
      for (const conn of open) send(conn.ws, { type: "workspace.deleted", workspaceId: e.workspaceId });
      track(syncBoundRepos(db, rpc).catch((error) => { if (!stopping) console.error("[daemon] repos.sync failed", error); }));
    }
  });

  /**
   * Picks the connection for a targeted call among two or more open ones. The rules, first match wins:
   * 1. `daemonId`: that daemon, when it is online (e.g. the daemon that reported a repo move).
   * 2. `taskId`: the daemon running that task (run-token calls: plugin calls, skill offers, hub functions).
   * 3. `workspaceId`: the newest registered daemon owned by one of the workspace's owners (repos, reports,
   *    work-package checks, the Skill catalog). Local daemons have no owner, so they never match here.
   *    When the workspace has bound repos, an owner daemon whose held set covers their normalized remotes
   *    wins over a newer owner daemon that holds none of them (D-6, #316: a repo call must reach the
   *    machine that has the repo checked out); with no holder online the newest owner still answers, so
   *    the call never fails for want of a holder.
   * 4. Otherwise the newest connection: the same daemon the single `current` slot used to hold. Calls that
   *    concern no workspace (components, extensions/MCP, plugins.status, the directory dialog, attachment
   *    capabilities) always land here.
   * No load or scoring: task 11 adds which daemon may run which task; this only chooses who answers a call.
   */
  async function chooseConnection(open: Conn[], target: DaemonTarget): Promise<Conn> {
    const listed = (id: string | null | undefined): Conn | undefined => (id ? open.find((conn) => conn.daemonId === id) : undefined);
    const pinned = listed(target.daemonId);
    if (pinned) return pinned;
    if (target.taskId) {
      const [row] = await db.query<{ daemon_id: string | null }>(`select daemon_id from tasks where id = $1 and status = 'running'`, [target.taskId]);
      const runner = listed(row?.daemon_id);
      if (runner) return runner;
    }
    const registered = open.filter((conn) => conn.registered);
    if (target.workspaceId && registered.length > 0) {
      const owned = new Set((await db.query<{ id: string }>(
        `select d.id from daemons d
         join workspace_members m on m.user_id = d.owner_user_id
         where d.id = any($1::text[]) and d.revoked_at is null
           and m.workspace_id = $2 and m.role = 'owner' and m.removed_at is null`,
        [registered.map((conn) => conn.daemonId), target.workspaceId],
      )).map((row) => row.id));
      // Newest first: the same order the single `current` slot used to hold.
      const owners = [...registered].reverse().filter((conn) => owned.has(conn.daemonId));
      if (owners.length > 0) {
        const bound = await db.query<{ remote_url: string | null }>(
          `select remote_url from workspace_repos where workspace_id = $1`,
          [target.workspaceId],
        );
        const required = bound
          .map((r) => normalizeRemoteUrl(r.remote_url))
          .filter((r): r is string => r !== null);
        const holder = required.length > 0 ? owners.find((conn) => required.every((r) => conn.heldRepos.has(r))) : undefined;
        return holder ?? owners[0]!;
      }
    }
    return newestOf(open)!;
  }

  /** The `DaemonRpc` facade every hub module calls (`deps.daemon`); see `chooseConnection` for the rules. */
  const rpc: DaemonRpc = {
    async call(method, params, timeoutMs, target) {
      const open = openConnections();
      if (open.length === 0) throw new DaemonRpcError(DAEMON_NOT_CONNECTED);
      // One daemon: it answers every call, whatever the target, exactly as before the connection table.
      if (open.length === 1) return callOn(open[0]!, method, params, timeoutMs, target);
      if (target?.all) {
        try {
          return await Promise.any(open.map((conn) => conn.rpc.call(method, params, timeoutMs)));
        } catch (error) {
          if (error instanceof AggregateError) throw error.errors[0];
          throw error;
        }
      }
      const conn = await chooseConnection(open, target ?? {});
      if (!isOpen(conn)) throw new DaemonRpcError(DAEMON_DISCONNECTED);
      return callOn(conn, method, params, timeoutMs, target);
    },
  };
  /** Sends one call on `conn`, first telling `target.onResponder` which connection it went to (#302 task 5). */
  function callOn(conn: Conn, method: string, params: unknown, timeoutMs: number | undefined, target: DaemonTarget | undefined): Promise<unknown> {
    // An `all` call has no single responder, even when only one connection happens to be open.
    if (target?.onResponder && !target.all) {
      target.onResponder({ daemonId: conn.daemonId, connectionId: conn.connectionId, registered: conn.registered, ownerUserId: conn.ownerUserId });
    }
    return conn.rpc.call(method, params, timeoutMs);
  }

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      stopping = true;
      unsubscribe();
      for (const conn of connections.values()) conn.rpc.failAll("hub shutting down");
      for (const client of wss.clients) {
        if (client.readyState === client.OPEN || client.readyState === client.CONNECTING) client.close(1001, "hub shutting down");
      }
      const timeout = setTimeout(() => {
        for (const client of wss.clients) client.terminate();
      }, 1_000);
      timeout.unref?.();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      clearTimeout(timeout);
      while (pending.size > 0) await Promise.all([...pending]);
      await Promise.all([chain, moves]);
    })();
    return closePromise;
  };
  wss.on("connection", (ws) => {
    if (stopping) ws.close(1001, "hub shutting down");
  });
  const revokeRegisteredDaemon: RevokeRegisteredDaemon = (id, actor) => withRegistry(async () => {
    const result = await revokeDaemon(db, id, actor);
    // Only the revoked daemon's connection closes; its close cleanup requeues its own task.
    const target = connections.get(id);
    if (typeof result !== "string" && target) {
      send(target.ws, { type: "error", message: DAEMON_CREDENTIAL_REVOKED_MESSAGE });
      const { ws } = target;
      ws.close();
      // A revoked client cannot hold task cleanup open by ignoring the close frame.
      const timeout = setTimeout(() => ws.terminate(), 1_000);
      timeout.unref();
      ws.once("close", () => clearTimeout(timeout));
    }
    return result;
  });
  const isConnected = (daemonId?: string): boolean => {
    if (stopping) return false;
    if (daemonId === undefined) return openConnections().length > 0;
    const conn = connections.get(daemonId);
    return conn !== undefined && isOpen(conn);
  };
  const connectedDaemonIds = (): string[] => (stopping ? [] : openConnections().map((conn) => conn.daemonId));
  return { isConnected, connectedDaemonIds, connectionSnapshot, waitingReasonFor, statusSnapshot, rpc, revokeRegisteredDaemon, close };
}
