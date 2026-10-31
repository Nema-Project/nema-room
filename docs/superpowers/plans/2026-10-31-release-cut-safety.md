# `release:cut` 并发与中断安全 Implementation Plan

**Goal:** 同一版本的两次 `release:cut` 只有一个能写 `CHANGELOG.md`，另一个以明确错误退出；`CHANGELOG.md` 写完但片段删除中断时，重跑补齐删除、清掉 journal，不重复写内容、不因「小节已存在」拒绝。见 [#155](https://github.com/Nema-Project/nema-room/issues/155)。

**Architecture:** 新增 `scripts/release/release-lock.mjs`（跨进程排他锁），`cut-changelog.mjs` 在锁内先写 journal（本次要删的片段名与内容哈希、写后 `CHANGELOG.md` 的哈希）再写 changelog，按 journal 删片段；`stamp-version.mjs` 共用同一把锁。不新增 npm 依赖。

**Tech Stack:** Node.js 22+（`node:fs/promises`、`node:crypto`、`node:test`），无网络。

**Base:** `e1786e8`（写本计划时的 `origin/main`）。分支 `fix/release-cut-safety`。

## 现状（动手前读过的代码）

- `scripts/release/cut-changelog.mjs` 第 194–201 行：读 changelog → 读片段 → 合并 → 写文件 → 逐个 `unlink`。没有互斥，也没有任何「这次消费了哪些片段」的记录。两个进程会各自读到同一份片段并各写一次；写后到 unlink 之间中断，则下次运行在第 61 行因 `already has a section` 拒绝。
- `scripts/release/stamp-version.mjs` 第 142 行：写四个版本文件并自检，同样无互斥；它和 cut 是同一次发布准备的两个相邻步骤。
- `packages/knowledge/src/git.ts` 第 24–56 行的 `withRepoLock` 是**进程内**串行化（模块级 `tails` Map），docstring 第 36 行只承诺 same repo directory (in-process)；`docs/superpowers/plans/2026-10-27-source-evidence-protocol.md` 第 25 行也写明它不跨进程。**不能复用**，需要真正的文件锁。
- `scripts/release/cut-changelog.test.mjs` 现有 15 个用例，基线 `node --test scripts/release/*.test.mjs` 为 83/83 通过，全部保留。

## 决定与理由

1. **锁 = 仓库根目录排他创建的文件 `.nema-release.lock`，`open(path, 'wx')`。** `wx` 是内核层面的原子「不存在才创建」，不需要额外的竞态窗口。文件内容写 `{schemaVersion, command, pid, token, startedAt}`，供等待方在错误里点名是谁在跑。
2. **不放 `.git/`。** 本仓库大量使用 worktree，worktree 里的 `.git` 是**文件**（`gitdir: …`），`path.join(root, '.git', 'x')` 在 worktree 里直接 `ENOTDIR`。放仓库根并加进 `.gitignore`，worktree 各自一把锁、互不干扰，行为也一致。
3. **不偷锁（no stale takeover）。** 按 pid 存活或按时间判陈旧都有误判风险（pid 复用、跨主机、`kill(pid,0)` 对已退出未回收进程仍成功——#161 踩过这条），偷锁的代价是两个写者同时写。改为失败关闭：超时的错误消息点名锁文件路径、持有者 pid 与开始时间，并给出「确认该进程已不在就删掉这个文件」的补救。命令持有锁只有毫秒级，手工删一个文件的成本远低于静默双重写入。
4. **journal = 仓库根 `.nema-release-cut.json`，先写 journal、再写 `CHANGELOG.md`。** 顺序是这次设计的核心：如果先写 changelog，崩溃点落在两次写之间时没有任何记录能说明「这份 changelog 已经被这次 cut 改过」，下次只能拒绝。先写 journal 则两种崩溃点都可判定。
5. **journal 记录两个哈希：写后 changelog 全文的 sha256，以及每个被消费片段的 sha256。**
   - 前者让重跑能区分「写入已经落地」（当前文件哈希等于记录值 → 只补删除）与「还没落地」（不等 → 走一次正常 cut）。
   - 后者保证只删「自己写进去的那份内容」：片段在中断之后被改过，就不删，留给下一次发布。这直接对应验收里「不删不属于自己的片段」。
6. **journal 带 `version`，版本不一致就拒绝。** 重跑 `0.2.2` 时发现 journal 记的是 `0.2.1`，说明上一次 cut 没收尾，错误里直接给出应执行的那条命令，而不是拿别人的 journal 继续。
7. **`stamp-version` 共用同一把锁。** 两个命令写同一棵发布树（三个 manifest、lockfile、changelog），并行跑的语义从来没人定义过；共用一把锁把「stamp 与 cut 交错」变成错误而不是半写。范围只到这一把锁：不改 stamp 的写入方式、不加新的锁粒度。
8. **锁的等待时间可注入**（`lockWaitMs`、`lockPollMs`、`sleep`），默认 `5000ms` / `50ms`：日常手抖同时敲两次时，后到的一方通常会等到前一个结束、然后在内容层面得到确定的 `already has a section`，而不是一句「有锁」。测试用注入值把两条路径（超时失败、等到后再失败）都钉死，测试不真等。
9. **journal 与锁都在 `path.dirname(changelog)`。** 生产环境就是仓库根；测试的临时目录自带一套，不需要解析 git 根，也就不会在测试里误碰真实仓库。

## 复跑规则（状态机）

| 进入时的状态 | 行为 |
| --- | --- |
| 无 journal | 正常 cut：读 → 合并 → 写 journal → 写 changelog → 按 journal 删片段 → 删 journal |
| journal 的 version ≠ 本次版本 | 拒绝，错误点名 journal 路径与应执行的命令 |
| journal 版本相同，当前 changelog 哈希 = 记录值 | 写入已落地：跳过读取与写，只按 journal 删内容未变的片段，删 journal |
| journal 版本相同，哈希不等，且当前文件已有该版本小节 | 拒绝：无法判断这份小节是谁写的，留 journal 与片段给人看 |
| journal 版本相同，哈希不等，且无该版本小节 | 写入没落地：按正常 cut 重做，journal 被新记录覆盖 |
| journal 不是合法 JSON 或缺字段 | 拒绝，不删任何片段 |

## 任务

- [ ] **Task 1: 先写测试（红）。** `scripts/release/cut-changelog.test.mjs` 增加：
  - `two concurrent cuts of one version: one writes, the other exits with a clear error`
  - `a cut that holds the lock past the wait budget is named in the other process's error`
  - `an interrupted cleanup is finished by a rerun without rewriting the changelog`
  - `a fragment edited after the interruption is kept, not deleted`
  - `a journal for another version stops the cut and names the command to finish first`
  - `a journal whose changelog no longer matches is refused when the section exists`
  - `a journal written before a failed changelog write is replayed as a normal cut and the lock is released`
  - `an unreadable journal is refused and nothing is deleted`
  `scripts/release/stamp-version.test.mjs` 增加 `stamp refuses while a release command holds the shared lock`。
- [ ] **Task 2: `scripts/release/release-lock.mjs`。** `withReleaseLock(root, command, fn, options)`、`releaseLockPath(root)`、`ReleaseLockBusyError`；释放时校验自己写入的 token 再删除。
- [ ] **Task 3: 接进 `cut-changelog.mjs`。** journal 读写、复跑状态机、按哈希删片段、`afterWrite` 注入点（模拟「写完未删」的中断）。
- [ ] **Task 4: 接进 `stamp-version.mjs`。** 原函数体移入 `stampVersionLocked`，外壳取锁。
- [ ] **Task 5: 文档与片段。** `CONTRIBUTING.md`、`scripts/npm/RELEASE.md`、`scripts/images/RELEASE.md`、`scripts/desktop/RELEASE.md` 各补一句；新增 `changelog.d/release-cut-safety.changed.md`；`.gitignore` 忽略锁与 journal。
- [ ] **Task 6: 校验与 PR。** `node --test scripts/release/*.test.mjs`、`npx vitest run --maxWorkers=2`、`npm run typecheck`、`node scripts/ci/docs-check.mjs`，逐条记录退出码。

## 三条验收 → 测试映射

| 验收 | 测试 |
| --- | --- |
| 两个进程同时 cut 同一版本：只有一个成功，只有一份小节，片段删除与内容一致 | `two concurrent cuts of one version…`、`a cut that holds the lock past the wait budget…` |
| 写完未删片段处中断后重跑：删除剩余片段、清掉 journal、不报小节已存在、不重复写 | `an interrupted cleanup is finished by a rerun…` |
| 现有 `cut-changelog.test.mjs` 用例全部保留通过 | 原 15 个用例一个不改，整文件运行通过 |

## 证伪记录

实现后逐条临时撤掉对应保护跑测试，记录实际输出：

1. 把 `cut-changelog.mjs` 换回 base 版本 → 并发用例与中断用例必须红。
2. 去掉片段哈希比较（无条件删） → `a fragment edited after the interruption is kept` 必须红。
3. 去掉 journal 版本比较 → `a journal for another version stops the cut` 必须红。
4. 去掉「写入已落地」分支（照旧在 `cutChangelogText` 拒绝） → 中断用例必须红。

## 明确不做

- 不偷锁、不装信号处理器、不处理跨主机/NFS 的 `wx` 语义差异。
- 不改 `main` 的 CLI 参数、不加 `--force` 之类的逃生开关（逃生手段是删那个文件，错误消息会告诉人）。
- 不真的 cut 任何版本，不改 `CHANGELOG.md` 正文。
- 不动 `packages/knowledge` 的 `withRepoLock`。
