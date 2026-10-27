# Room API 用户 basis 的服务端证据（#28）

日期：2026-10-27。实现计划：[2026-10-27-user-basis-evidence.md](../plans/2026-10-27-user-basis-evidence.md)。上游设计：[外部来源证据协议（CX-03）](2026-10-27-source-evidence-protocol-design.md)。Issue：[Nema-Project/nema-room#28](https://github.com/Nema-Project/nema-room/issues/28)。

**状态**：设计。本文件只收紧 Room API 的纯聊天路径。不建 `evidence_events`，不实现 CX-03。

**设计所对照的 HEAD**：`dce99af412e4c80547d144928a5378d65083f877`（`main`，Merge pull request #27）。CX-03 的 spec 和 plan 已在这棵树上，生产代码还没有 `sourceRefs`。

本次读过的代码：

- `apps/hub/src/roomApi.ts` 的 `POST /entries`：`sourceMessages` 必须是本 workspace 的消息；`basis` 必填；quote 可以是当前正文或 `message_versions` 的精确子串。已定决策保护只覆盖 `kind === "decision" && status === "active"`。`citesUser` 只看 `role === "user"`，不要求是当前任务的消息。检查在 `KnowledgeStore.upsert` 加锁之前。
- `packages/knowledge/src/git.ts`：`withRepoLock` 是进程内 Promise 队列。同一 `repoDir` 重入会立刻抛 `RepoLockReentryError`，而不是排到自己后面死锁。另一目录，或这次调用结束后的下一次调用，不受影响。
- `packages/knowledge/src/store.ts`：`upsert` 自己调用 `withRepoLock(this.repoDir)`。`writeAndCommit` 不加这把锁，注释写明只给已持锁的调用方。`get` 用的是文件路径上的另一把锁，和仓库锁不是同一把。
- `apps/hub/src/uiApi.ts`：`PUT` 忽略客户端的 `basis`，决策写成 `decided`，其他类型写成 `stated`。`confirm` 走 `KnowledgeStore.confirm`。这两条都不经过 Room。
- `apps/hub/src/prompt.ts`：prompt 已要求 `stated` / `decided` 只能表示用户说过或拍板的内容，系统任务和上报不能写成用户 basis。这只是提示，不是服务端检查。

## 意图

Agent 通过 Room API 写入 `basis: stated` 或 `basis: decided` 时，服务端要能证明当前任务的用户消息被引用了。今天这条证明只存在于 active 决策的改写和提升上，而且任意一条 user 消息都能过。新建条目、需求、以及从失效状态改回 active 的条目都不检查。CX-03 让外部摘录可以被读到之后，不带 `sourceRefs` 的请求会掉进这条缺口。本 issue 先把纯聊天路径补上，并给出一把锁内的写入接口，供 CX-03 计划任务 6 复用。

## 目标

- Room API 写入用户 basis，或把任一类型从 `INACTIVE_STATUSES`（`superseded`、`dropped`、`resolved`）改回 active，必须引用当前任务的 user 消息。
- 这条检查和 Git 写入发生在同一次 `withRepoLock(repoDir)` 里，用锁内读到的条目做判断。
- `upsert` 增加可选 guard。CX-03 任务 6 把外部证据检查写进同一个回调，不再另取一把仓库锁。
- 已有的 active 决策 409 文案、界面 `PUT` / `confirm`、`inferred` 的普通写入保持今天的结果。

## 非目标

- `evidence_events`、`sourceRefs`、`sourceSnapshot`、导入、界面 `promote_basis`。这些是 CX-03。
- 改 `basis` 的三个值，改 quote 的逐字规则，改 prompt 文本。
- 给 `withRepoLock` 做可重入或跨进程锁。同一仓库重入改为立刻抛错，锁本身仍不可重入。
- 收紧界面路径。用户在界面上的编辑和确认仍然直接写用户 basis。CX-03 再给那条路径加事件。
- 要求用户 basis 必须带 quote。逐字摘录是 CX-03 在「写入前或写入后有 `sourceRefs`」时的附加条件，不是本 issue 的条件。

## 反目标

做到了也算失败：

1. 只引用 agent、system、report，或另一条用户消息，就能通过 Room API 把条目写成 `stated` / `decided`。
2. 把失效条目改回 active 时不引用当前任务的用户消息。包括 `dropped` 的决策（界面撤回写成的状态）和 `superseded` 的需求。
3. 在仓库锁外面读条目、决定放行，然后再调用会自己加锁的 `upsert`。
4. guard 回调里再调用 `upsert` / `confirm` / `withdraw` / `writeDiagram`，或对同一 `repoDir` 调用 `withRepoLock`，导致死锁而不是立刻抛 `RepoLockReentryError`。
5. 改动让现有 active 决策八个测试、quote 逐字测试、界面 PUT / confirm 的断言失败。

## 约束

- 代码和注释用英文。hub 新的拒绝文案用中文。不新增依赖。
- 知识 Git 仍是条目正文的权威。本 issue 不改文件格式。
- 一个数据目录同时只跑一个 hub。`withRepoLock` 不跨进程。不要加文件锁或数据库租约。
- 持有某仓库的 `withRepoLock` 时，不得调用该仓库上会再次加锁的 `KnowledgeStore` 方法。

## 已定的做法

- 证据是 `sourceMessages` 含有当前任务的消息 id，且该消息 `role === "user"`、属于当前 workspace。不看 quote，不看 `message_versions`。【#28 决定】[推断]
- 当前任务来自 run token 的 `taskId`，再 `getTask` → `getMessage`。任务不存在、消息不存在、workspace 对不上，或角色不是 `user`，都算没有这条证据。【#28 决定】[推断]
- 下面任一情况需要这条证据，否则 409，HTTP 体为 `{ "error": "<下文原句>", "code": "user_basis_evidence" }`。文件不写：
  1. 新建，且请求的 basis 是 `stated` 或 `decided`。
  2. 更新，且请求在旧守卫调整之后的 basis 是 `stated` 或 `decided`，并且标题、正文、状态、basis 至少有一项和磁盘上不同。
  3. 磁盘上的 `status` 属于 `INACTIVE_STATUSES`（`superseded`、`dropped`、`resolved`），本次要写成的状态是 `active`。不限条目种类。basis 即使是 `inferred` 也要证据。请求省略 `status` 时沿用磁盘状态，不算复活。只改标题或正文、状态仍是失效状态时，不因这条复活规则拒绝；是否拒绝只看第 2 条。`question` 没有 `active`，改成 `active` 会在加锁前被 zod 拒绝（400），到不了这条。【#28 决定】[推断]
- 不需要这条证据：basis 为 `inferred` 且不是第 3 条；只改 `related`（以及不改标题、正文、状态、basis）；界面 `PUT` / `confirm`；hub 内部对 `KnowledgeStore.upsert` 的调用（不传 guard）。【#28 决定】[推断]
- active 决策的旧守卫原样保留，并且移进同一把锁，用锁内的 `existing`。改写或提升时，basis 必须是 `stated` / `decided`，且 `sourceMessages` 里至少一条 `role === "user"`。失败文案不变，响应里不加 `code`：`改写已定决策 <id> 需要用户消息作为依据（basis 为 stated 或 decided，且 sourceMessages 含用户消息）。若只是推断，请不要改它，改为新建一条 question 询问用户。` 不改写、且请求 basis 不是用户 basis 时，仍保存原来的 basis。旧守卫先跑。它已经 409 时，不再换成新文案。【#28 决定】[推断]
- 因此：active 决策的改写若只引用 agent 消息，仍是旧 409。若引用了用户消息但不是当前任务那条，旧守卫通过，新 409 拒绝。这是相对今天的收紧，现有「allows a decided rewrite citing a user message」用的就是当前任务的用户消息，断言不变。【#28 决定】[推断]
- 新 409 的原文只有这一句：`写入 stated 或 decided，或把已失效条目恢复为 active，需要引用当前任务的用户消息。` `code` 固定为 `user_basis_evidence`。缺少引用和引用了别的消息用同一句、同一个 code。【#28 决定】[推断]
- `upsert` 的第三个参数是可选 guard。它在 `withRepoLock(this.repoDir)` 内、读完目标条目并分配好 id 之后、`writeAndCommit` 之前运行。签名见下一节。CX-03 不另写一个不加锁的 Room 写入函数；任务 6 扩展这一个回调。导入路径仍然不能调用 `upsert`，那是 CX-03 任务 5 的 `writeImportedSource`，本 issue 不实现它。【#28 决定】[推断]

## 锁内接口

`packages/knowledge` 导出：

```ts
export class UpsertRejected extends Error {
  constructor(
    readonly status: 400 | 409,
    message: string,
    readonly code?: string,
  );
}

export type UpsertGuardContext = {
  /** 锁内读到的条目。新建为 null。 */
  existing: Entry | null;
  /** 本次请求，已经过 UpsertEntryInput 解析。 */
  input: UpsertEntryInput;
};

export type UpsertGuard = (
  ctx: UpsertGuardContext,
) => Promise<UpsertEntryInput | void> | UpsertEntryInput | void;

class KnowledgeStore {
  upsert(
    rawInput: UpsertEntryInput,
    meta: CommitMeta,
    guard?: UpsertGuard,
  ): Promise<{ entry: Entry; commit: string; op: "add" | "update" }>;
}
```

行为：

- 不传 guard 时，和今天的 `upsert` 相同。界面和 hub 内部调用不用改。
- guard 抛 `UpsertRejected`：不写文件，锁释放，错误原样抛出。Room 把它变成对应的 HTTP 状态；有 `code` 时放进 JSON。
- guard 返回 `UpsertEntryInput`：用它替换即将写入的输入。返回 `void`：用原来的输入。
- 替换值会再次 `UpsertEntryInput.parse`。解析前把 `kind` 和已在锁内确定的 `id` 钉死，调用方改不了种类，也改不了这次用的 id。`op` 仍按进入 guard 之前的新建或更新。
- 返回值可以改 `confirmed`。更新时只有 `confirmed === true` 才刷新 `confirmedAt`，所以 CX-03 可以在回调里去掉 Agent 送来的 `confirmed: true`。
- guard 内禁止调用同一仓库的 `upsert`、`confirm`、`withdraw`、`writeDiagram`，也禁止 `withRepoLock(repoDir)`。这些调用立刻抛 `RepoLockReentryError`，不排队。`get` 可以，它锁的是文件路径。另一仓库的 `upsert` 可以，顺序的下一次调用也可以。

### CX-03 计划任务 6 怎么复用

任务 6 不新加锁，也不在 `upsert` 之前读 `sourceRefs`。它只改 `apps/hub/src/roomApi.ts` 里这次 `upsert` 的回调，插在用户 basis 守卫之后、`return` 之前：

```ts
await ks.upsert(input, { author: "agent", taskId }, async ({ existing, input: locked }) => {
  const guarded = applyActiveDecisionGuard(existing, locked, byId);
  await assertCurrentTaskUserEvidence(db, taskId, workspaceId, existing, guarded);
  // CX-03 任务 6 从这里开始，仍在这把仓库锁里：
  // - 用 existing 读写入前的 sourceRefs（字段省略则保留磁盘上的列表）
  // - 拒绝带 sourceSnapshot 的 S 条目改 basis
  // - 写入前或写入后 sourceRefs 非空时，再要求当前用户消息的逐字摘录
  // - 需要忽略 confirmed: true 时，返回去掉该字段的 input
  // 不要在回调里调用 upsert / confirm / withdraw / writeDiagram / withRepoLock(repoDir)
  // 同一仓库重入会抛 RepoLockReentryError
  return guarded;
});
```

任务 6 的「先跑旧的 active 决策守卫」就是调用已经在回调里的 `applyActiveDecisionGuard`，不要把那段检查搬回锁外。纯聊天路径以本 spec 为准：没有 `sourceRefs` 时，用户 basis 和从失效状态改回 active 已经由 `assertCurrentTaskUserEvidence` 拒绝。CX-03 文档里「保持今天」指的是 #28 合入后的行为，包括这两项检查，实施时不得删除，也不得放宽。CX-03 plan 里「不带 sourceRefs 的现有需求用例仍是 200」仍然成立，因为 `does not guard requirements or a superseded decision` 的更新用的是 `inferred`，不是用户 basis，也没有把失效状态恢复成 active。

CX-03 任务 5 的导入在自己持有仓库锁时仍不得调用 `upsert`。那条路径用计划里的 `writeImportedSource`，不走本 guard。

## Room `POST /entries`

1. Bearer、zod、`sourceMessages`、basis 必填、quote、`implementation` 拒绝：仍在加锁前，规则不变。
2. 更新一个不存在的 id：仍在加锁前 404 `entry not found: <id>`。这只拒绝明显不存在的 id，不作为 basis 判断。若这一次读到了文件，但加锁后文件已经不在，锁内的 `entry <id> not found` 同样映射为 404，而不是 500。
3. `upsert` 加锁，读条目，跑 guard：先旧的 active 决策守卫，再本 spec 的用户证据。
4. 通过后才 `writeAndCommit`。拒绝时文件字节不变；新建被拒绝时不产生该文件。
5. 提交成功后的索引、任务变更、`knowledge.changed` 与今天相同。索引失败仍返回 200。

`getTask` / `getMessage` 只在第 3 步判定「需要证据」之后查询，避免每次 `inferred` 写入都多读一次。查询本身在锁内。

## 测试

`packages/knowledge/test/store.test.ts`：

- guard 抛 `UpsertRejected` 时文件不变，随后另一次 `upsert` 仍能写。证明锁会释放。
- guard 里再调用同一仓库的 `upsert`、`confirm`、`withdraw`、`writeDiagram`：立刻抛 `RepoLockReentryError`，文件不变。随后另一次 `upsert` 仍能写。持有这把锁时，另一仓库的 `upsert` 仍能写。
- 同一仓库上两个带 guard 的 `upsert` 串行：第二个 guard 看到的是第一个已经写入的标题，而不是排队前的标题。
- guard 返回的输入被写入；返回 `confirmed: false` 的更新不刷新 `confirmedAt`。

`apps/hub/test/roomApi.test.ts`：

- 新建 `decided`，`sourceMessages` 只有 agent 消息：409，`code` 为 `user_basis_evidence`，文件不存在。
- 新建 `stated`，引用的是另一条用户消息，不是当前任务那条：同样的 409 和 code，文件不存在。
- 需求已是 `stated`，改正文但只引用 agent 消息：409，文件不变。
- active 决策改正文，basis 为 `decided`，只引用另一条用户消息：409 且 `code` 为 `user_basis_evidence`，不是旧的「改写已定决策」文案，文件不变。
- superseded 决策恢复为 active，basis 为 `inferred`，不引用当前任务用户消息：409，文件不变。
- `dropped` 决策（`withdraw` 写成的状态）恢复为 active，basis 为 `inferred`，只引用 agent 消息：409，文件不变。引用当前任务用户消息：200，状态为 active。
- `superseded` 需求恢复为 active，basis 为 `inferred`，只引用 agent 消息：409，文件不变。引用当前任务用户消息：200，状态为 active。
- 系统任务引用更早的用户消息，basis 为 `decided`：409 和同一个 code。
- 上报任务引用更早的用户消息，basis 为 `decided`：409 和同一个 code，文件不存在。
- 需求改正文，basis 为 `stated`，引用当前任务用户消息：200。
- superseded 决策恢复为 active，并引用当前任务用户消息：200，状态为 active。
- 加锁前存在的条目，在锁内读到之前被删掉：404 `entry not found: <id>`，不是 500。
- 只引用 agent 消息的 `inferred` 新建：200。
- 现有八个决策测试、quote 逐字测试的断言不改。quote 那两个用例的 `sourceMessages` 要加上当前任务的用户消息 id，否则它们的 `stated` 会先被本规则拒绝，测不到逐字比较。quote 的 200 / 400 文案保持原样。

## 文档

- `CHANGELOG.md` 的 `[Unreleased]` 记下这条 Room API 拒绝。
- `docs/reference.zh-CN.md` 的 API 小节写上 409 原文和 `code`。
- 不改 README，不改 `ROADMAP.md`。CX-03 的 spec / plan 只改措辞：凡是「今天的行为 / 保持今天」指 Room 纯聊天路径的地方，都改成 #28 合入后的行为，包括用户 basis 证据检查和失效→active 检查，并写明不得删除。计划任务 6 写明怎么复用 `UpsertGuard`。不改 CX-03 的设计。`recoverUncommitted`、界面 `PUT` / `confirm`、文件省略规则里的「今天」仍指那些路径自己的行为，不把它们改成 Room 的证据检查。
