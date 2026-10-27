# 加快 PR CI 门禁，同时让 main 保持可发布

日期：2026-10-27。实现计划：[2026-10-27-pr-ci-fast-gate.md](../plans/2026-10-27-pr-ci-fast-gate.md)。

**设计所对照的 HEAD**：`9980a4a786c50a344db7adfd4a689da120b4c123`（`main`，PR #47 的合并提交）。对照过的运行是 PR #44、#46、#47 在 2026-10-27 的 Actions。ruleset 读于同一天。本设计不改工作流、不改 ruleset；那些改动是后续实现 PR 的事。

这是稳定化与流程，不是产品方向。对照 [issue #45](https://github.com/Nema-Project/nema-room/issues/45) 的决策规则：它让人和 Agent 更快拿到仍然可信的实现证据，并让 `main` 保持可发布。它不增加产品能力，也不改讨论、知识或开发包的语义。ROADMAP 里发布与分发工作同样算稳定化，不算产品方向。对应台账是仍在进行中的 P0-02，以及尚未实施的 P1-08（CI 分层、避免无必要的重型任务）。

## 意图与原因

Agent 在一个 PR 上连续小步推送时，门禁几乎总是红的，而且每次 `main` 前进都会让其余开着的 PR 整套重跑。维护者要的是：PR 上的必过检查短到能迭代，`main` 上的提交始终经得起发布。

已核对的现状：

- `.github/workflows/ci.yml` 的 `concurrency` 是 `ci-${{ github.ref }}`，`cancel-in-progress: true`。（S-1）新的推送会取消同一 ref 上还在跑的运行。被取消的必过 job 让最终的 `CI gate` 失败。`gatePasses` 把 `cancelled` 当成不通过，这是对的，不能改成把取消当成成功。
- 三条 PR 的最近运行里，长 job 都被取消、门禁失败，只有停手之后的那一次才绿：
  - PR #44：取消的 [40491979894](https://github.com/Nema-Project/nema-room/actions/runs/40491979894)、[40495397822](https://github.com/Nema-Project/nema-room/actions/runs/40495397822)。`verify / Full application tests and web build` 被取消，`CI gate` 失败。随后的 [40495820911](https://github.com/Nema-Project/nema-room/actions/runs/40495820911) 成功；该 job 从 11:25:00Z 到 11:33:38Z。
  - PR #46：取消的 [40494312218](https://github.com/Nema-Project/nema-room/actions/runs/40494312218)、[40494937962](https://github.com/Nema-Project/nema-room/actions/runs/40494937962)，同样是这个 job 被取消后门禁失败。成功的 [40496029646](https://github.com/Nema-Project/nema-room/actions/runs/40496029646) 从 classify 11:26:51Z 到门禁 11:36:37Z。这次 diff 是 README、站点、`ROADMAP.md` 和 `AGENTS.md`，仍然跑了 macOS / Windows platform 和完整 Ubuntu 套件。
  - PR #47：取消的 [40494926165](https://github.com/Nema-Project/nema-room/actions/runs/40494926165)（完整测试被取消；Windows npm pack 是真实失败）、[40495400786](https://github.com/Nema-Project/nema-room/actions/runs/40495400786)（完整测试、Windows platform、Windows npm pack 被取消，门禁失败）。成功的 [40495664036](https://github.com/Nema-Project/nema-room/actions/runs/40495664036) 从 11:24:19Z 到 11:34:05Z。npm pack 大约 1–3 分钟，platform 大约 1.5–3 分钟，都比 Ubuntu 完整测试（约 9.5 分钟）先结束。
- 活跃 ruleset `main pull request`（id `25873388`）要求检查上下文 `CI gate`（GitHub Actions，`integration_id` 15368），并且 `strict_required_status_checks_policy` 为 true。（S-2）分支必须先更新到 `main` 才能合并。每次合进 `main`，其他开着的 PR 都要更新并重跑当时的整套 verify。
- `scripts/ci/policy.mjs` 把任意路径上的 `AGENTS.md` / `CLAUDE.md` 排除在文档白名单之外，测试锁着这个行为。（S-3）这是 P0-02 故意的：根上和嵌在里面的 Agent 说明不是用户文档。（S-8）PR #46 因此走了全量。
- 基线上的 `verify.yml` 在每次非文档 PR 里跑四类 job：`workflow-lint`、`platform`（macOS 与 Windows）、`test`（Ubuntu 上的 typecheck、`npm test`、hub/cli 构建、web lint 与 web build、Compose）、`npm-pack`（Ubuntu、Windows、macOS）。（S-4）工作流注释写 Ubuntu `test` 平常 8–12 分钟；上面三次成功运行落在这个区间里。
- 桌面 smoke 不是每次非文档 PR 都跑。`desktop-release.yml` 的 `pull_request` 只含 `apps/desktop/**` 与 `scripts/desktop/**`；macOS 分钟按 10 倍计费，所以普通分支推送不触发它。（S-5）镜像 smoke 的工作流不在这份 `main` 上。PR #44 的 `image-publish.yml` 只有 `v*` tag 和 `workflow_dispatch`，没有 `pull_request`；publish job 要求 `github.event_name == 'push'` 且 `release == 'true'`。（S-7）
- `npm-publish.yml` 的 `verify` job 无条件调用 `verify.yml`，publish 要求这次 verify 成功。（S-6）`desktop-release.yml` 与 PR #44 的 `image-publish.yml` 在 tag 上把 `verification_required` 设为 true，再调用同一套 `verify.yml`。P0 规格写明发布前跑完整套件，并且当时要求分支更新到最新。（S-8）

墙钟上的长杆是 Ubuntu 的 `test` job，不是 platform，也不是 npm pack。把重型 job 从 PR 上拿掉，省的是 macOS 分钟和「重型 job 被一起取消」的红叉，不会把必过检查变成一两分钟。必过检查仍然大约是这一次 Ubuntu 运行的长度。真正把等待乘上去的，是取消进行中的运行，以及 strict 让每个开着的 PR 在 `main` 每次前进时重跑整套。

## 目标

- 非文档 PR 的必过 `CI gate` 只等待：分类、文档检查、workflow lint、Ubuntu 应用测试与 web build（含现有的 hub/cli 构建、`npm test` 与 Compose）。macOS/Windows platform 与三系统 npm pack 只在下面的路径表命中时跑。
- 文档白名单 PR 继续跳过应用测试和重型 job，门禁仍能变绿。`AGENTS.md` / `CLAUDE.md` 仍然不在白名单里。
- 推送到 `main`，以及手动 `workflow_dispatch`，跑完整的 `verify.yml`（lint、Ubuntu `test`、platform、npm pack）。跳过任何一项都让这次门禁失败。
- `npm-publish.yml`、`desktop-release.yml`，以及已经或即将落在 `main` 上的 `image-publish.yml`，在 `v*` tag 上仍对同一个 SHA 要求完整 `verify.yml`。发布 job 仍在 verify 失败、取消、跳过或缺失时失败关闭。
- 桌面 smoke 与镜像 smoke 仍按路径触发，不进入 ruleset 的必过检查名单。
- PR 并发继续取消被取代的运行。`main` 上正在跑的验证不被后来的推送取消。
- Agent 文档写明：把 review 修改合成一次推送；不要空等 CI，也不要因为旧 run 被取消再推一次。

## 非目标

- 本设计的 PR 不改 `.github/workflows/`、`scripts/ci/`、ruleset、tag、发布或合并。
- 不把 Ubuntu `test` job 再拆开，不把 Compose 从 PR 必过检查里拿掉。
- 不把桌面安装包构建或镜像构建加进每一次 `main` 推送。
- 不新建 `image-publish.yml`。基线上没有这个文件。
- 不把 `CI gate` 改名，不往 ruleset 里加 platform、npm pack、桌面或镜像的检查名。
- 不改 `pages.yml` 的触发和并发。
- 不改产品代码、README 四种语言或 UI 文案。

## 反目标

做到了也算失败：

1. 用 `develop` 分支当主要办法。与 `main` 同一套门禁，PR 不会变快。`develop` 上用轻门禁、再一次性合并到 `main`，风险堆成一次大批合并。`npm-publish`、`image-publish`、`desktop-release` 都键在 `v*` tag 上，并且要求 tag 提交是 `origin/main` 的祖先。`develop` 不是它们验证的那条线。（T-2）
2. 为了让旧的被取消 run 变绿，把 `cancelled` 或缺失结果当成通过。
3. 文档 PR、或只改了不在路径表里的文件的 PR，在分类失败或不确定时仍跳过重型 job。空 diff、分类器抛错，必须走重、不许走轻。
4. tag 工作流因为新的布尔输入默认值，少跑 platform、npm pack 或 Ubuntu `test`。
5. 实现 PR 或本规格 PR 调用 ruleset API、创建 tag、发布 npm 或 GHCR、或合并 PR。
6. 把桌面矩阵或镜像 publish 放进普通 PR 的必过检查，使一次路径未命中变成「检查永远等待」。

## 约束

- 代码和注释用英文。本规格与计划用中文。`AGENTS.md` 的新增句子用英文，与该文件其余部分一致。
- Actions 继续钉全长 SHA。不改 `actionlint` 1.7.12 的 pin。权限保持 `contents: read`。不用 `pull_request_target`，不把 secret 交给 fork PR。
- 分类继续使用 PR base..head 的完整 diff：`git diff --no-renames --name-only -z`，改名的两侧都在，不按页截断。输入不合法就抛错，门禁失败。这条已经由 `changes.test.mjs` 锁住，实现不得改成 `--find-renames`。
- ruleset 的其余规则不动：允许 merge、squash、rebase；`require_extra_approval_for_unattributed_changes` 仍为 true；审批人数仍为 0；禁用的 ruleset `main`（id `25809837`）保持禁用。
- 两份英文 README 若被碰到必须字节相同。本变更不碰它们。
- 历史句子保持历史。`scripts/desktop/RELEASE.md` 里「rollout 提交的 main SHA 当时没有 Actions 运行，因为 `ci.yml` 不在 `main` 推送上跑」是 2026-10-27 之前的事实，不改写成现在的验收。

### 风险与回退

关掉 strict 是接受下面这个窗口，不是把它留成未写明的副作用。

何时发生：一条 PR 的 `CI gate` 已在当时的 `main` 上成功，之后另一条 PR 先合并，`main` 前进。第一条不更新分支。ruleset 仍接受那次旧的 `CI gate`。两边改到同一处时，GitHub 的合并冲突会挡住。没有冲突、但合在一起才红的改动会进入 `main`。重型 job 在 PR 上被跳过时，单独的 macOS、Windows 或 npm pack 失败也要等这次推送之后才看得见。

如何发现：推送到 `main` 的 `CI` 工作流以 mode `full` 跑完整 `verify.yml`。这是合并之后的检测，不是合并前的第二道门。墙钟与今天的 PR 全量接近（Ubuntu job 约 8–12 分钟，platform 与 npm pack 并行）。

响应：谁先看见 `main` 的 `CI gate` 失败，谁先撤回或修好，再做别的事。`main` 最新一次 `CI` 缺失、进行中、被取消或失败时，不再往上合并。Agent 在合并前先看这次运行。这个句子写进 `AGENTS.md`。

tag 工作流不用再加一条「去查 `main` 那次门禁绿没绿」的依赖。`npm-publish`、`desktop-release`、`image-publish` 已经对 tag 指向的 SHA 调用 `verify.yml`，失败、取消、跳过或缺失都不能发布。`main` 全量失败的那个 SHA，tag 上的同一套 verify 也会失败，所以发布已经被挡住。被并发组挤掉的 pending `main` 运行没有结论，不能拿来当 tag 的依据；tag 自己再跑一遍。发布清单仍要求不要给 `main` CI 未成功的 SHA 打 tag，免得留下一个不能移动的失败 tag。

回退：

- 撤回用 PR `git revert -m 1 <merge>`。撤回 PR 走当时的门禁；合入后再跑一次 `main` 全量。在这次变绿之前不合其他 PR。
- 不要在该 SHA 的 `CI` 工作流缺失、仍在跑、被取消或失败时打 `v*` tag。失败的 tag 不能移动（发布脚本拒绝 tag 被移动）。打错的 tag 留在原地，修好后用下一个版本号。
- GitHub 在 `cancel-in-progress: false` 时仍会取消同一并发组里更早的 pending 运行，只保留最新的 pending。因此不是每一个 `main` SHA 都有跑完的全量。被挤掉的 SHA 没有成功的门禁，不能拿来打 tag。正在跑的那次不会被后来的推送取消。
- 若这套跳过规则本身让 `main` 变红，撤回实现合并即可回到「每个非文档 PR 都跑完整 verify」。strict 可以单独改回 true，字段与下面的手工步骤相同。

## 已定的做法

- 关掉「分支必须更新到最新」，不启用 merge queue。上面的窗口是这个决定接受的风险，不因此把 strict 留在 true。[D-1]
  - 活跃 ruleset 只把 `strict_required_status_checks_policy` 从 true 改为 false。检查上下文仍是 `CI gate`，`integration_id` 仍是 15368。
  - merge queue 能在合并前用临时 merge ref 再跑必过检查，因此比「合入之后才发现」更早拦住集成失败。本仓库不采用它。（T-1）同一套必过检查进队列前要先在 PR 上出现，队列里再跑一次。若必过检查是快门，队列并不覆盖被跳过的重型 job；若让快门在 `merge_group` 上变成全量，则每次合并都排队等完整 verify，并且维护者还要求 `main` 推送再跑一遍，等于付两次。队列还要改合并方式、给 `ci.yml` 加 `merge_group`，ruleset 多一条规则。本仓库的发布安全网是 tag 上的 verify 加上 `main` 全量，不靠队列。
  - `develop` 分支按反目标第 1 条拒绝，不作为实现选项。（T-2）
- 手工改 ruleset 的人是维护者 NullumNomen，实现 PR 不调用 API。[D-9]
  - 顺序：先合并实现 PR；确认这次合并造成的 `main` 推送跑完了 mode `full` 且 `CI gate` 成功；然后才改 strict。在 `main` 推送全量还没上线时关掉 strict，两条 PR 的集成失败没有这个安全网。
  - 页面：仓库 Settings → Rules → Rulesets → `main pull request` → Require status checks to pass → 取消勾选 “Require branches to be up to date before merging”。保存后 API 里该规则的 `strict_required_status_checks_policy` 应为 false，`required_status_checks` 仍只有 `{context: "CI gate", integration_id: 15368}`，`do_not_enforce_on_create` 仍为 false。
  - 不要勾选 merge queue。不要改 pull request 规则里的合并方式、审批人数或 `require_extra_approval_for_unattributed_changes`。不要动 id `25809837`。
- PR 的 `cancel-in-progress` 保持 true。`push` 到 `main` 与 `workflow_dispatch` 为 false。并发组名保持 `ci-${{ github.ref }}`。[D-3]
  - 表达式是 `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`。
  - `desktop-release.yml` 已有的「tag 不取消、其他 ref 取消」不改。Agent 指南同样覆盖它：桌面路径上的连续推送也会取消进行中的桌面 smoke。
- 文档白名单保持现在的规则，并且 `AGENTS.md` / `CLAUDE.md` 在任何目录下都不是文档。[D-4]（T-3）
  - 仍算文档：仓库根上的 `*.md`（路径里没有 `/`）、`docs/` 与 `site/` 下扩展名属于现有白名单的文件、以及恰好 `.github/workflows/pages.yml`。可执行文件、`..`、绝对路径、反斜杠、空段，都不是文档。
  - 不把 `AGENTS.md` 放进白名单。P0 把它排除，是因为它会改变 Agent 怎么跑、怎么提交、怎么理解验证，不是用户文档。新的快门已经去掉「只改说明也要等 macOS」的代价：只改 `AGENTS.md` 的 PR 跑 Ubuntu 快门，不跑 platform / npm pack / 桌面 / 镜像。再放进白名单会连单元测试一起跳过，这个安全理由还在，不改。
  - 全部路径都是文档时 mode 为 `docs`。空路径列表不是文档，mode 为 `full`（应用测试、platform、npm pack 都必过）。任一路径含空段（`docs//guide.md`、以 `/` 结尾）、`.` 或 `..` 段、以 `/` 开头，或含反斜杠，整次分类都是 mode `full`。这些路径要在文档谓词之前拦住：今天的谓词会把 `docs//guide.md` 当成文档。其余非文档路径 mode 为 `app`：普通未知文件（例如 `vendor/rules.md`、`unknown`、`docs/` 下的 `.js`）不触发重型类别。
- 重型类别的路径表如下。一条路径可以命中多类。Git 路径用 `/`。目录命中包括该目录下的文件。门禁基础设施路径强制 platform 与 npm pack 都必过，这样改分类器的 PR 自己会跑重型 job，不能靠自己的跳过逻辑变绿。[D-5]

  | 类别 | 命中 | 谁消费这个结果 |
  | --- | --- | --- |
  | platform | `apps/cli/`、`apps/local/`、`apps/desktop/`、`packages/knowledge/`、`scripts/desktop/`、`scripts/security/`；恰好 `scripts/setup.mjs`、`scripts/setup.test.mjs`、`scripts/release-notes.test.mjs`、`package.json`、`package-lock.json` | `verify.yml` 的 `platform` job |
  | npm pack | `apps/cli/`、`packages/shared/`、`scripts/npm/`；恰好 `scripts/setup.mjs`、`scripts/setup.test.mjs`、`package.json`、`package-lock.json`、`.github/workflows/npm-publish.yml` | `verify.yml` 的 `npm-pack` job |
  | 门禁基础设施（上面两类都强制为必过） | 恰好 `.github/workflows/ci.yml`、`.github/workflows/verify.yml`；以及 `scripts/ci/` 下任意文件 | 同上 |
  | desktop | `apps/desktop/`、`scripts/desktop/` | 只与 `desktop-release.yml` 现有的 `pull_request.paths` 对齐，不进 `CI gate` |
  | image | 恰好 `Dockerfile`、`docker-compose.yml`、`docker-compose.build.yml`、`.github/workflows/image-publish.yml`；以及 `scripts/images/` 下任意文件 | 不进 `CI gate`。文件不在 `main` 上时不新建工作流 |

  - `apps/hub/` 与 `apps/web/` 不触发 platform。这两处的测试已在 Ubuntu `npm test` 里跑。platform job 是在 macOS/Windows 上再跑一遍操作系统敏感子集。hub 或 web 的 PR 把这个矩阵留到 `main` 全量。（T-5）
  - 只改 lockfile 会触发 platform 与 npm pack，不触发桌面 smoke。桌面工作流今天已经写明 lockfile 只等 tag，保持这个界限。（T-6）
  - 分类步骤的 id 保持 `changes`。它写到 `GITHUB_OUTPUT` 的键固定为 `mode`、`platform`、`npm_pack`、`desktop`、`image`，值是 `docs`/`app`/`full` 与 `true`/`false`。`jobs.classify.outputs` 必须把 `platform` 与 `npm_pack` 显式转成 `steps.changes.outputs.platform` 与 `steps.changes.outputs.npm_pack`（`mode` 保持现有的同样转法）。job 输出不写这两个键时，后面的 `needs.classify.outputs.platform` 是空字符串。空字符串不是 false：必过标志空或缺失，门禁失败，重型 job 不得因此被跳过。`push` 与 `workflow_dispatch` 不按 diff 分类，直接写 `mode=full`、`platform=true`、`npm_pack=true`、`desktop=false`、`image=false`，并继续写今天 dispatch 所用的那份文档路径列表，好让文档检查的不变量照常跑。
- `CI gate` 对跳过的处理：[D-6]
  - `classify`、`docs`、`lint` 三者都必须是 `success`。`lint` 在 `docs`、`app`、`full` 上都必过，包括只改 Markdown 的 PR。
  - `platformRequired` 与 `npmPackRequired` 只能是明确的 true 或 false。空字符串、缺失或其他值在 `docs`、`app`、`full` 上都失败，不能当成 false。
  - mode `docs`：这两个标志都必须为 false，否则失败。`app`、`platform`、`npmPack` 各自只能是 `skipped` 或 `success`。
  - mode `app`：`app` 必须是 `success`。某一重型类必过时，对应结果必须是 `success`；不必过时，只能是 `skipped` 或 `success`。
  - mode `full`：`app`、`platform`、`npmPack` 都必须是 `success`。`skipped` 失败。必过标志在这个 mode 下不放宽结果。
  - 其他 mode，以及 `failure`、`cancelled`、空字符串、缺失、`unknown`，在该 job 必过时失败。不必过时也不接受这几个值。
  - 可复用工作流失败时，调用方拿不到的输出按空结果处理，空结果失败。不要把空结果默认成 `skipped`。
- `verify.yml` 增加三个布尔输入：`app_tests`、`platform`、`npm_pack`，默认都是 true。`workflow-lint` 没有关闭开关。`test`、`platform`、`npm-pack` 仅在对应输入为 true 时运行。工作流输出 `lint`、`app`、`platform`、`npm_pack`，值是对应 job 的 `result`。[D-7]
  - 现有调用方不传这三个输入，因此 tag 上的 `npm-publish.yml`、`desktop-release.yml`，以及带 `verification_required` 的镜像工作流，仍跑全部 job。实现不得为了 PR 快门去改它们的 `with:`，除非是补上显式的 true。
  - `ci.yml` 在 PR 上调用时：`app_tests` 为 mode 不是 `docs`；`platform` 为 mode 是 `full` 或分类 `platform=true`；`npm_pack` 同理。`push` 到 `main` 与 `workflow_dispatch` 传 true。
  - `ci.yml` 增加 `push: branches: [main]`。不给 tag 加触发；tag 仍只由各自的发布工作流调用 `verify.yml`。
  - Ubuntu `test` job 的步骤保持基线顺序，Compose 留在这个 job 里。拆开会让应用 PR 在栈能启动之前合并。（T-4）
- 桌面与镜像 smoke 不进必过 `CI gate`，也不在每次 `main` 推送时跑。[D-8]
  - `desktop-release.yml` 的 `pull_request.paths` 保持恰好 `apps/desktop/**`、`scripts/desktop/**`。policy 的 desktop 类别必须与这两条一致，测试比较两边。
  - 每次 `main` 推送都做桌面安装包或镜像构建，会把 10 倍计费的 macOS 打包加到每一次合并上。可发布性的那一层是 tag 工作流里已有的 smoke，加上 tag 前的完整 `verify.yml`。PR 路径表负责「改了桌面或镜像文件时在 PR 上 smoke」。
  - `image-publish.yml` 不在基线时，实现不创建它。路径表先写进 policy 并有测试。实现开始时若该文件已经在树上，则给它加 `pull_request.paths`，且只含：`Dockerfile`、`docker-compose.yml`、`docker-compose.build.yml`、`scripts/images/**`、`.github/workflows/image-publish.yml`。publish 的 `if` 必须仍然要求 `github.event_name == 'push'`。`verification_required` 在 `pull_request` 上保持 false，避免镜像工作流在 PR 上再跑一遍完整 verify。build job 在 PR 上运行就是镜像 smoke。文件仍不存在时，测试只断言路径表，并断言工作流文件不存在。
- 实现 PR 更新 `AGENTS.md`：review 修改合成一次推送；`CI gate` 会因被取消的运行失败，这是故意的；不要空等 CI；不要只为了抹掉旧 SHA 上的红叉再推一次。最新一次推送的运行才算数。合并前先看 `main` 最新的 `CI`：缺失、进行中、被取消或失败时不合。看见 `main` 变红，先撤回或修好，再合别的。[D-3]
- 实现 PR 在 `scripts/desktop/RELEASE.md` 与 `scripts/npm/RELEASE.md` 加上「不要给 CI 未成功的 `main` SHA 打 tag」，不改写 rollout 历史段落。若 `scripts/images/RELEASE.md` 当时存在，加同一句。`CHANGELOG.md` 的 `[Unreleased]` 记一条 Changed。`ROADMAP.md` 的 P1-08 链到本规格并标为进行中，不标已完成；P0-02 保持进行中，并写明 strict 仍为 true，直到维护者按 D-9 改完。在 `docs/superpowers/specs/2026-10-26-p0-release-assurance-design.md` 的 “Require branches to be up to date before merging” 那一段落后加一句英文 supersession，指向本规格。不把 P0 规格改写成另一种设计。

## 留给实现者

- `policy.mjs` 内部的函数名与路径匹配的写法。对外要保住的是：现有 `classifyPaths` 的文档 / 非文档判定（本规格改的是返回值所携带的重型标志，文档白名单的成员与排除项不变）、`gatePasses` 的结果表、以及 `GITHUB_OUTPUT` 的五个键。
- `ci.yml` 里 verify 布尔输入的具体写法，只要真值与 D-7 一致，并且 `jobs.classify.outputs.platform` / `npm_pack` 就是上面写死的那两个 `steps.changes.outputs` 映射。
- `AGENTS.md` 新段落的英文用词，只要 D-3 的行为都在：合成一次推送、取消是故意的失败、不要空等、不要为旧的红叉再推、合并前先看 `main` 的 `CI`、`main` 变红时先撤回或修好。

## 验收标准

- R-1：`classifyPaths` 对文档白名单、`AGENTS.md` / `CLAUDE.md`（根上与 `docs/`、`site/` 下）、空列表、空段、`.` / `..` 段、以 `/` 开头、含反斜杠的路径、混合 diff、门禁基础设施、以及上表每一类的正例和反例（`apps/hub/`、`apps/web/` 不触发 platform；只改 lockfile 不触发 desktop）给出 mode 与四个布尔值。空列表与这些不安全路径的 mode 是 `full`。非法输入仍抛错。`changes.mjs` 对一份临时 git diff 写出五个 `GITHUB_OUTPUT` 键，改名两侧都参与分类。
- R-2：`gatePasses` 覆盖 docs / app / full 与 `success`、`failure`、`cancelled`、`skipped`、空、`unknown` 的组合。必过 job 被跳过则失败。必过标志为空、缺失或既不是 true 也不是 false 时失败，包括 mode `app` 下重型结果已是 `skipped` 的情形。docs 上标志不是 false 则失败。不必过的重型 job 为 `success` 或 `skipped` 则通过。`lint` 不是 `success` 则失败。
- R-3：只含根 Markdown、`docs/` 或 `site/` 白名单、`pages.yml` 的路径集 mode 为 `docs`，四个重型标志都为 false。含 `AGENTS.md` 或 `CLAUDE.md` 的路径集 mode 为 `app`。
- R-4：`jobs.classify.outputs.platform` 与 `npm_pack` 分别等于 `steps.changes.outputs.platform` 与 `steps.changes.outputs.npm_pack`。PR 上 `verify` 的三个输入按 D-7 连接，读的是这些 job 输出。`workflow-lint` 不能被输入关掉。Ubuntu `test` 的现有命令与 Compose 的 `if: always()` 还在。desktop 路径与 `desktop-release.yml` 的 `pull_request.paths` 一致。image 文件存在时路径与 publish 条件符合 D-8，不存在时测试断言文件不存在且路径表仍在。
- R-5：`npm-publish.yml` 与 `desktop-release.yml` 的 tag 路径仍调用 `verify.yml` 且不传 false。不传输入时三个布尔默认 true，四个 job 都会跑。发布 job 在 verify 不是 `success` 时不发布。`ci.yml` 在 `push` 到 `main` 与 `workflow_dispatch` 上把 mode 设为 `full`。
- R-6：`ci.yml` 并发组仍是 `ci-${{ github.ref }}`。`cancel-in-progress` 仅当事件是 `pull_request`。`desktop-release.yml` 的 tag 不取消条款还在。
- R-7：实现 PR 的 diff 不包含 ruleset 调用、tag、发布配置变更。PR 说明写出 D-9 的页面路径、字段名和「先看到 `main` 全量成功再改」的顺序。本规格 PR 同样不改 ruleset。
- R-8：`AGENTS.md` 含 D-3 的行为，包括合并前先看 `main` 的 `CI`，以及 `main` 变红时先撤回或修好、不再往红的 `main` 上合并。`ROADMAP.md` 指向本规格，P1-08 为进行中而非已完成，P0-02 仍为进行中。P0 规格有 supersession 一句。两份发布清单（以及当时存在的镜像清单）写明没有成功的 `main` CI 就不打 tag，并写明挡住发布的是 tag SHA 上的 `verify.yml`，不是另查一次 `main` 运行记录。`CHANGELOG.md` 的 `[Unreleased]` 有对应 Changed。README 四个文件不被修改。
- R-9：实现 PR 自己的 Actions 里，因为改了 `scripts/ci/` 与工作流，platform 与 npm pack 实际运行且 `CI gate` 成功。另用分类单测覆盖「只改 `docs/` 则重型标志为 false」「只改 `apps/web/` 则 platform 与 npm pack 为 false」。不另开会烧完整矩阵的一次性 PR。合入后的 `main` 推送是 mode `full` 的运行证据；在那次成功之前，不声称 strict 已经关掉。
