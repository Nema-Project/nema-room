# `mcpLeftovers` 的偶发失败：pid 文件读到空串 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**状态：可实现。** 根因已查明并使用本机实测证据确认（见下「根因」）。issue #161 提出的「僵尸进程」假设经实测**推翻**。

**Goal:** 让 `apps/cli/test/extensions/mcpLeftovers.test.ts` 不再偶发拦住 `main`，同时不放宽「进程是否已停止」的判定：修复后仍必须能区分「已停止」与「仍在运行」。

**Tech Stack:** TypeScript、Node.js `fs`、`child_process`、Vitest。不新增依赖，不访问网络。

**Issue:** [#161](https://github.com/Nema-Project/nema-room/issues/161)，milestone v0.2.x。

**Base:** `e1786e8`（Merge pull request #160）。

## 根因（实测，非推断）

**`orphan()` 夹具在 `writeFileSync` 尚未写入内容时就读了 pid 文件，得到 `""`；`Number("") === 0`，而 `process.kill(0, 0)` 对 pid 0 恒成功，于是 `alive(child)` 永远为真。**

夹具第 30–32 行先轮询 `existsSync(file)`，再 `readFileSync(file, "utf8")`：

```js
while (!existsSync(file) && Date.now() - start < 5000) { /* wait for the child */ }
return { leader: leader.pid!, child: Number(readFileSync(file, "utf8")) };
```

`existsSync` 对「已创建、尚未写入」的文件就返回 true，而 `writeFileSync` 是两步（创建/截断 → 写入）。在这两步之间读到空串时：

- `Number("")` 是 `0`；
- `process.kill(0, 0)` 按 POSIX 是「向调用者自己的进程组发信号」，**恒成功**（实测：`alive(0) === true`，且 `/proc/0/stat` 并不存在）；
- 于是第 88 行的 `until(() => !alive(child))` 永远等不到，5 秒后返回 `false`。

这条路径**同时解释**了 CI 记录里的三个细节，僵尸假设解释不了其中两个：

| 证据 | CI 实际 | 空串→pid 0（本假设） | 僵尸（issue 假设） |
| --- | --- | --- | --- |
| 第 1 条测试 `sweep stops a recorded server's whole group…` | ✅ 82 ms 通过 | ✅ 通过（它不用 `orphan()` 的 child） | ❌ 本机实测同样失败 |
| 第 87 行 `sweep() === ["search"]` | ✅ 通过 | ✅ 通过 | ✅ 通过 |
| 失败测试耗时 | **5127 ms** | **5083 ms**（三次：5091/5103/5088） | **~7076 ms** |
| `/proc/<child>/stat` 状态 | 未记录 | child 从未被读到，与 pid 0 无关 | `Z` |

关键区分点是**第 1 条测试在 CI 里是绿的（82 ms）**，而僵尸假设会让第 1 条也失败——本机把测试进程放进「不回收孤儿的 subreaper」下运行（`prctl(PR_SET_CHILD_SUBREAPER)`）后，第 1 条与第 5 条**都**失败，且各耗约 7.1 秒。这与 CI 的记录不符，因此僵尸不是本次失败的原因。

另外两次 main CI（`3d676f2`、`41170625288`）与 attempt 2 皆绿，与「窗口很窄的读写竞争」一致。

### 实测记录（本机 Linux，kernel 6.12.94，Node v24.22.1）

- 僵尸判活：造一个真僵尸，`/proc/<pid>/stat` 第 3 列为 `Z`，`process.kill(pid, 0)` **成功**。单个僵尸成员也会让 `kill(-pgid, 0)` 成功。→ issue 的假设在机制上成立，但**不是**这次失败的原因。
- 空串判活：`Number("") === 0`；`process.kill(0, 0)` 成功；`/proc/0/stat` 不存在。
- 夹具路径读空串的发生率：**500 次里 14 次**（2.8%），从未出现部分写入。
- 强制走空串路径复现：第 88 行失败，`until` 用满 5000 ms，整条测试 **5083 ms** —— 与 CI 的 5127 ms 吻合。
- subreaper 下（僵尸路径）：第 1 条 **7071 ms** 失败、第 5 条 **7076 ms** 失败 —— 与 CI 不符。
- 产品侧无缺陷：在 subreaper 下跑 40 次，`sweep()` 每次都返回该 id，`sweep()` 返回后 child 从未仍处于 `S`/`R`（40/40 为 `Z`）。即产品确实停掉了整组，只是停掉后留下的僵尸骗过了 `kill(pid, 0)`。

## 结论

要修的是**测试**，两处，都是测试自身的判断方式问题：

1. **夹具的 pid 文件读取**：读到空串/非数字时不能当成 pid。这是本次拦 main 的直接原因。
2. **测试的判活函数**（`alive`）：`kill(pid, 0)` 把「已退出但未回收」当成活着。这是 issue #161 描述的现象，虽然本次没被触发，但它确实会让测试在别的机器（PID 1 不回收的环境）上偶发失败。

产品代码 `apps/cli/src/extensions/mcp/leftovers.ts` **不改**：实测 40/40 全部正确停止。`groupAlive` 的 `kill(-pgid, 0)` 也确实会把僵尸算作组成员，但那只会让 `stopGroup` 多等满 2 秒宽限期然后 SIGKILL——行为仍然正确（僵尸本来也杀不掉），改变它反而会让产品去猜测试环境。

## 为什么不放宽判活

新增的判活函数**更严**，不是更松：

- 旧：`kill(pid, 0)` 成功就是「活着」。空 pid、僵尸、以及 pid 0 都算活着。
- 新：先拒绝 `pid` 不是正整数的情况（直接判「已停止」，因为 pid 0/NaN 不可能是我们要等的进程）；Linux 上读 `/proc/<pid>/stat` 的 state，`Z` 判「已停止」；**读不到或无法解析时退回 `kill(pid, 0)`**，即保守判「活着」。

漏过去的唯一情形：一个 `Z` 状态的进程其实还有活着的后代在跑。这在本测试里不可能——测试只等自己 spawn 的那个 child，且 sweep 杀的是整组；而且僵尸本身不再执行任何代码。`groupAlive` 仍是产品判断进程组存活的方式，测试不碰它。

## 任务

### 任务 1：夹具不在空串上取值

- 修改：`apps/cli/test/extensions/mcpLeftovers.test.ts` 的 `orphan()`，读到非数字时继续轮询（带 5 秒上限），超时则抛错而不是返回 0。
- 满足：`Number("")` 不再可能变成 `child` 的值。

### 任务 2：判活区分「已停止」与「未回收」

- 修改：同文件的 `alive()`，改为调用新的 `isStopped(pid)`（或等价命名），规则如上。
- 满足：真僵尸判「已停止」；正常进程判「活着」；读不到 `/proc` 时退回 `kill(pid, 0)`（保守）。
- 平台：Linux 走 `/proc`；非 Linux 的 POSIX 走 `ps -o stat=`（本仓库已有 `/bin/ps`、`/usr/bin/ps` 的绝对路径习惯，见 `leftovers.ts`）；Windows 上该 describe 已被 `skipIf(!posix)` 排除。

### 任务 3：钉死行为的测试

- 新增用例：造一个真僵尸，断言判活函数返回「已停止」。
  - Linux：spawn 一个立即退出的子进程、父进程不 `wait`，读 `/proc` 确认是 `Z`，再断言。
  - 需要非 Linux 的 POSIX 也能跑：用 `sh -c 'sleep 0.05 & exec sleep 30'` 这种写法造僵尸（已在本机验证得到 `Z`），或用平台分支。
- 新增用例：空/非数字 pid 判「已停止」，且不会误判成 pid 0（回归本次事故）。
- 证伪：把判活函数改回裸 `kill(pid, 0)`，上述两条必须变红。

### 任务 4：验证

- `npx vitest run apps/cli/test/extensions/mcpLeftovers.test.ts --maxWorkers=1`
- subreaper 下重复跑若干次那条失败用例，确认不再受僵尸影响。
- `npx vitest run --maxWorkers=2`（全量）与 `npm run typecheck` 保持绿。

## 实施结果

- 新增 `apps/cli/test/processState.ts`：`isStopped(pid)` 与 `waitForPid(file)`。放在 test 根目录，与既有的 `links.ts` 同级。
- `mcpLeftovers.test.ts`：`alive` 改用它，`orphan()` 改为 `await waitForPid(file)`（因此 `orphan()` 变成 async，调用点都加了 `await`）。
- 新增测试：
  - `processState.test.ts > isStopped > an exited process that was never reaped counts as stopped`（造真僵尸，断言旧判活为真、新判活为「已停止」）
  - `processState.test.ts > isStopped > a pid that cannot name a process we started is stopped…`（pid 0 / 负数 / NaN / 小数 + `Number("")`）
  - `processState.test.ts > waitForPid > skips the empty window…` / `> fails instead of returning a pid…`
  - `mcpLeftovers.test.ts > a child pid is read only once the writer has written it, never as an empty pid 0`
- 证伪（改回旧写法必须变红，已实测）：
  - `isStopped` 退回裸 `kill(pid, 0)`：僵尸用例与 pid-0 用例变红（2 失败）。
  - `alive` 退回裸 `kill(pid, 0)`、在 subreaper 下跑：第 1 条与第 5 条都失败（7070/7073 ms）——正是僵尸假设与 CI 记录不符的地方。
  - `waitForPid` 退回 `existsSync` + 直接读：3 条相关用例变红。
- 稳定性：普通环境连跑 15 次全绿；subreaper（僵尸环境）下连跑 6 次全绿。
- `waitForPid` 一开始写成同步 `Atomics.wait` 轮询，会把同进程的写入者一起阻塞（自测即挂 5 秒），改为 async。

## 待确认

- 无。用户未参与本 issue 的决策；本计划的结论只依赖实测。

## Review Focus

- 判活函数在**读不到** `/proc` 或 `ps` 时必须保守判「活着」，不能因为读失败就当成已停止。
- 新增测试必须能在 Linux 上稳定造出 `Z`；若造不出，测试要跳过而不是假装通过。
- 第 80 行那条失败用例必须保留（不能删、不能永久跳过）。
