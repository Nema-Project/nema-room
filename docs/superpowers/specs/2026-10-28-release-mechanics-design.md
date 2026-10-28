# 发布机制：单点盖印、动态入口与整套晋升

日期：2026-10-28。Issue：[Nema-Project/nema-room#63](https://github.com/Nema-Project/nema-room/issues/63)（发布去版本耦合）。本文件是 #63 的实现设计，并把范围扩到 #63 没有覆盖的两处：发布准备的单点盖印，以及三条发布工作流之后的整套晋升。产品判断标准：[Nema-Project/nema-room#45](https://github.com/Nema-Project/nema-room/issues/45)。

**状态**：设计。本文件不是 plan，不改生产代码、工作流或校验器，不关闭 #63，不改 ROADMAP 的状态。

**设计所对照的 HEAD**：`d765122b9dabf19b79d75b9006cea68a6ca8aeef`（`origin/main`，Merge pull request #62）。下面标为「已核对」的行为是在这个 SHA 上读代码得到的，不是推断。

知识库里没有本设计对应的 R/D 条目。`## 已定的做法` 里的条款都标 `[推断]`：标的是「不是从已有条目抄来的」。每条前面的写的是来源：#63（含其采纳的设计评审）、2026-10-28 与维护者的讨论、或在这个 HEAD 上核对过的代码与政策文件。

本次读过的代码与文件，都在这个 SHA 上：

- `scripts/images/check-images.mjs`：`checkRepositoryImages` 读三个 manifest 的版本，`assertPackageVersions` 要求 tag 与三者相等，再 `assertComposeImages` 要求根 `docker-compose.yml` 字面包含 `image: ghcr.io/nema-project/nema-room-hub:<版本>` 与 web 同式、禁止 `:latest`、hub/web 不许 `build:`，并固定端口、健康检查与 `postgres:17`。`shouldMoveLatest(current, next)` 已存在，`current` 为空或 `next` 不更旧时才移动。镜像预算 800 MiB。
- `docker-compose.yml`（main）：hub/web 字面钉 `:0.1.5`。文件头注释告诉读者改从 tag v0.1.4 取这份文件，并写明 main 是未发布的候选、其钉的镜像在发布前不存在。
- `scripts/npm/check-tag.mjs`：`readReleaseTrio` + `assertReleaseTrio`，tag 必须等于 cli/desktop/local 三者，dist-tag 按预发布与否取 `next` 或 `latest`。
- `scripts/release-notes.mjs`：`changelogNotes` 按 `## [<版本>]` 找小节，要求至少一条 `- ` 条目。`--check` 不解析标题里的日期。已核对。
- `.github/workflows/npm-publish.yml`：tag 推送触发；verify（在该 SHA 上跑 `verify.yml`）→ build（打包、冒烟、上传 tarball 产物）→ publish（两次重取 tag、查 main 祖先关系、跑 check-tag，然后 `npm publish --provenance --access public --tag <dist>`）。文件名是 trusted publisher 绑定的一部分。`workflow_dispatch` 只打包冒烟，不发布。
- `.github/workflows/image-publish.yml`：plan 用 `scripts/desktop/release-commit.mjs` 解析不可变提交，tag 已移动则拒绝；build 产出 OCI layout 并用本地 registry 冒烟同一批字节；publish 用 crane 推版本 tag、每次推送前重验远端 tag，随后在单独一步里对稳定版按 `shouldMoveLatest` 移动两个 `latest`；发布后 smoke 用根 compose `docker compose pull` 再冒烟。
- `.github/workflows/desktop-release.yml`：plan 跑 `release-notes.mjs --check`；publish 作业建或复用 draft、上传资产、仅当 draft 恰好持有已验证的资产集时才 publish，已发布的 Release 拒绝覆盖。
- `scripts/npm/RELEASE.md`、`scripts/images/RELEASE.md`、`scripts/desktop/RELEASE.md`：三份都写明 tag 只能打在 main 的 CI 已成功的 SHA 上。npm 那份原文另有「Do not create a release tag from CI. Tag creation stays a separate maintainer step.」
- `site/index.html`（289–294 行）、`README.md`（95 行）、`docs/guide.en.md`（116 行）：公开安装入口指向 `raw.githubusercontent.com/Nema-Project/nema-room/v0.1.4/docker-compose.yml` 与 `npm i -g @nema-project/nema@0.1.4`。站点原文写明这份 compose「It is not a release asset.」
- 根 `package.json`：没有版本盖印或发布切割的 script。已核对。
- `scripts/ci/workflows.test.mjs`：工作流契约以测试形式存在，例如 "release gates bind all stages to one SHA and fail closed on verification results" 与 "image publish pushes pinned GHCR images only after verify, and only from the publish job"。
- `AGENTS.md`：daemon 安装文档必须带版本（`npm i -g @nema-project/nema@<hub version>`），因为 hub 与 daemon 有版本 skew 检查，版本不符不重连。CHANGELOG 的用户可见变更记入 `[Unreleased]`。

## 意图

v0.1.4 与 v0.1.5 两次发布里，机械编排占了维护者和 agent 的大量注意力：手工改六处版本记录；发布 PR 里把公开链接留在旧版本、发布后再开一个追加 PR 翻链接；CHANGELOG 小节日期写在候选提交里，发布时间跨过 JST 午夜就要先插一个日期修正 PR 才能打 tag（v0.1.4 的 PR #53）；tag 之后人肉盯三条并行的工作流，再逐个核对注册表与资产。这些步骤每一步单独看都不难，合起来让「现在哪个版本是可安装的现行版本」在合并到发布之间有一段时间没有单一可核对的答案：main 的 compose 钉着不存在的镜像，三条工作流各自成功各自翻指针，任一失败都可能留下半套新版本对着公开入口。

#45 的判断标准是：这是否让人和 agent 更容易对项目保持有证据支撑的共同理解。本设计不直接推进产品语义，它服务这条标准的方式是先把最基础的一件项目事实变可靠：受支持的首装以最后晋升的 Compose 资产为唯一版本选择入口，安装时把其版本锁定到本地；切换由校验驱动、留有记录；npm 与 GHCR 的别名不是跨注册表原子指针；「装的是哪一版、这一版齐没齐」随时可核对，而不是靠人记着翻过哪几处。

## 目标

- 发布 PR 的机械部分由盖印命令生成：三个 manifest、lockfile 记录、CHANGELOG 小节一次到位。人只写发布说明的内容与 ROADMAP 记录。
- 仓库树不再保存「下一版」的镜像 pin。main 的 compose 在任何时刻都不冒充可安装的发布文件。
- 公开入口（站点、README、指南里的 compose 获取地址）不随版本变化，发布完成后不需要追加 PR 翻链接。
- 首次安装把一整套已验证的版本锁定进本地 `.env`。之后不会因为某个 `latest` 先动而混装两个版本。
- tag 之后由一个整套验证收口：先校验候选产物，再幂等发布 npm，完整验证后按顺序更新别名，最后晋升带 Compose 资产的稳定 Release；受支持的安装只从该入口解析一次版本，并留下各步骤记录。
- 第 3 期第二步上线后，最终 Release 晋升前失败，受支持的安装入口仍保持上一套完整版本；npm dist-tag 与 GHCR 别名可能短暂不一致，summary 记录失败点，重跑向前恢复，不承诺跨注册表原子性。第 2 期与只读过渡阶段的限制另见分期条款。

## 非目标

- 不改三条发布工作流内部既有的 fail-closed 校验语义：verify 绑同一 SHA、tag 防移动、OCI layout 保证冒烟与发布字节一致、draft 资产集精确校验、`latest` 防倒退。本设计只移动「翻指针」的时机并新增收口，不放宽任何一条既有校验。
- 不从 CI 创建 tag。tag 保持维护者的独立步骤（见约束）。
- 不引入 feature flag、发布列车或按比例放量。
- 不替代真机冒烟与 CX 验收，也不把其未完成状态自动用作无关小版本的发布阻塞。未完成事项保留记录，安全、数据损失与已知阻断问题不豁免。
- 不改 CHANGELOG、ROADMAP 的历史小节，不改任何已发布版本的记录。
- 不处理 linux/arm64 镜像（#50）。
- 不把 manifest 版本改成由 tag 在发布时派生。树内版本与 tag 的锁步契约（check-tag）保留。

## 反目标

做到了也算失败：

1. 任一公开入口在某个时刻指向不完整的一套（例如镜像是新版、daemon 包仍是旧版），且文档或站点把这一套描述成现行可安装版本。
2. 受支持的安装路径依赖裸 `:latest` 解析，hub 与 web 在不同时刻拉到不同版本。
3. 盖印命令自动 commit、tag 或 publish。
4. 为了晋升，把长期 npm token、GHCR PAT 或其他长期凭据存进仓库或工作流 secrets。仓库现行做法只有 OIDC（npm）与 `GITHUB_TOKEN`（GHCR）。
5. 把整套验证的「就绪」写成真机验收通过、CX 验收通过或测试通过。它只断言产物存在且彼此一致。
6. 晋升把任一 `latest` 往回翻到更旧的版本。
7. main 上的 compose 或文档让读者以为未发布的候选版本已经可以安装。
8. 晋升中途失败后不留记录，维护者只能靠猜哪些指针已经翻过。

## 约束

- 代码、注释、提交信息用英文；本文件用中文（知识库语言）。工作流与脚本的改动遵守仓库既有约定：Actions 全部钉完整 SHA；`scripts/ci/workflows.test.mjs` 的契约测试随工作流改动同步更新，不绕过。
- `.github/workflows/npm-publish.yml` 的文件名是 npm trusted publisher 绑定的一部分，不改名。让它可由 dispatch 触发发布时，绑定不受影响的前提要在实现里验证并写进该期 plan。
- 三份 RELEASE.md 的现行政策在本设计内保持：tag 只打在 main 的 CI 已成功的 SHA 上；tag 创建是维护者的独立步骤，不从 CI 创建。
- daemon 与 hub 有版本 skew 检查，文档里的 daemon 安装必须带版本。动态化只做到「具体数字由已锁定的整套版本给出」，不写无版本的安装命令冒充能与任意 hub 匹配。
- 安装、配置或用法说明变更时，README 四个语言版本与 `docs/guide` 三个语言版本同步改；`README.md` 与 `README.en.md` 保持逐字节一致。
- 用户可见行为变更在实现提交里记入 CHANGELOG `[Unreleased]`。本设计提交不改 CHANGELOG、ROADMAP。
- 实施时再对一次当时的 HEAD。若 `check-images.mjs`、npm-publish 或 desktop-release 已与本文不同，先改本文再写 plan。

## 已定的做法

### 范围与分期

- 三期，顺序固定为 1 → 2 → 3，每期独立成 PR、独立合并：第 1 期单点盖印（盖印命令 + CHANGELOG 切割），第 2 期入口动态化（#63 本体），第 3 期整套验证与晋升。[推断]
- 第 3 期分两步上线：先只读验证（verify-release 只报告、不翻任何指针，指针仍由各工作流按现行方式翻），至少经历一次真实发布且报告无误报后，才把翻指针移交 promote。过渡阶段 desktop 仍独立发布，可能先于 npm/镜像就绪；此时不得宣称 latest Release 天然代表完整版本。公共安装解析必须先验证整套产物，缺件时拒绝写入 `.env` 并明确报错；已有安装继续使用原锁定版本。只有第二步才建立最终 Release 晋升的就绪门。[推断]
- 每期单独写 plan。计划最多 15 个任务，超过就拆分。[推断]

### 第 1 期：单点盖印

- 新增 `scripts/release/stamp-version.mjs <x.y.z>`：参数是严格 SemVer、无 `v` 前缀（与 `scripts/desktop/release-version.mjs` 的解析一致）。它一次写入 `apps/cli`、`apps/desktop`、`apps/local` 三个 `package.json` 的 `version` 与 `package-lock.json` 中对应的 workspace 版本记录，不改其他字段。[推断]
- 盖印前先检查 trio 与 lockfile 的原始一致性；不一致则拒绝且不写文件。第 1 期写入后只运行 `node scripts/npm/check-tag.mjs v<x.y.z>` 自检，不运行仍要求根 Compose 字面 pin 的 image 检查。任一写入或自检失败须恢复本命令触及文件的原始字节，保留既有用户改动；非零退出并点名失败处。第 2 期落地后，再加入模板形态与新版本渲染资产的检查。第 1 期未改变根 Compose，准备下一次实际 release 时仍须手动同步 pin 并通过既有 image gate；盖印成功不等于发布树已就绪。[推断]
- 新增 `scripts/release/cut-changelog.mjs <x.y.z>`：把 CHANGELOG `[Unreleased]` 的现有条目整体移入新建小节 `## [<x.y.z>] - <执行当天、维护者本地时区的日期>`，位置紧跟 `[Unreleased]` 之后；`[Unreleased]` 只留空标题。`[Unreleased]` 没有条目时命令拒绝执行、文件不变。[推断]
- CHANGELOG 的日期语义就此定为截稿日：小节日期记切割当天，不是 tag 当天。真实发布时间以 GitHub Release 为准——desktop-release 本来就在发布时由 CHANGELOG 生成 release notes，Release 本身带发布时间。PR #62 gates 里「实际发布日变了就刷新日期」的要求随第 1 期落地废止。`release-notes.mjs --check` 只验小节存在且有条目、不解析日期（已核对），不需要改它。[推断]
- 根 `package.json` 增加 `release:stamp` 与 `release:cut` 两个 script 入口。发布 PR 的准备步骤改为：确认 `[Unreleased]` 条目齐全（仍按仓库纪律随功能 PR 陆续写入）→ 跑这两条命令 → 写 ROADMAP 记录。[推断]
- 盖印与切割命令不 commit、不 tag、不 publish。[推断]

### 第 2 期：入口动态化

- 根 `docker-compose.yml` 的 hub/web `image:` 改为 `ghcr.io/nema-project/nema-room-hub:${NEMA_IMAGE_TAG:-latest}` 与 web 同式。`.env.example` 增加 `NEMA_IMAGE_TAG` 并写明：受支持的安装路径在首次安装时把它锁定为一个完整发布版本。模板里的 `:-latest` 只保证源码开发流程（如只起 postgres 的 `npm run db:up`）不因缺变量失败；裸用 `latest` 不出现在任何受支持的安装说明里。[推断]
- `check-images.mjs` 的断言拆成两组：形态断言对仓库模板运行（服务齐全、端口与健康检查形状、hub/web 不 `build:`、`postgres:17`、不出现字面钉版的 `:latest`，插值形式除外）；版本断言对发布资产运行，内容与今天 `assertComposeImages` 的版本部分相同（双镜像 pin 等于发布版本、不用 `latest`）。既有测试里针对字面 pin 的用例迁到资产断言一侧，不删覆盖。[推断]
- 新增 `scripts/images/stamp-compose.mjs <x.y.z>`：把模板渲染成双镜像都钉 `<x.y.z>` 的 compose 文件，渲染后立即用版本断言自检，不过就不输出文件。[推断]
- 发布流程把渲染出的文件作为固定名资产 `docker-compose.yml` 附到该版本的 GitHub Release：由 desktop-release 的 publish 作业在建 draft 时一并上传，其资产集校验的期望集随之包含这个文件。`https://github.com/Nema-Project/nema-room/releases/latest/download/docker-compose.yml` 仅在迁移门满足后才是受支持的 compose 获取地址：先发布包含该资产的新版本，验证固定名资产、npm 和两个镜像，再单独切换公开链接；之前继续使用现有 versioned raw URL。本设计不授权回填或修改已发布 v0.1.5 的资产集。[推断]
- 「可推荐的安装版本」按 #63 的整套就绪定义（不是跨注册表原子事务）：该版本的 compose 资产、hub 与 web 两个镜像的版本 tag、npm 上的 daemon 包，四者全部可验证（含 GHCR 匿名拉取）才算就绪；任一缺失时不得宣称新版本可安装；最终入口保留上一版的保证从第 3 期第二步开始生效。此前 latest Release 可能先发布，首次安装必须检测缺件后拒绝继续，不能宣称已锁定完整版本。[推断]
- 站点三页、README 四份、`docs/guide` 三份里的 compose 链接统一改为 `releases/latest/download/docker-compose.yml`。此链接切换与资产生产可分开合并；只有当前稳定 latest 的该 URL 实测 HTTP 200 且整套产物验证通过后才部署。切换完成后不再出现随版本变化的 compose 下载 URL，后续发布不需要追加 PR 翻链接。[推断]
- 首次安装区分两条路径：现有 `scripts/setup.mjs` 与 `devComposeUpArgs()` 保持源码构建，从 checkout 的 trio 读取并校验版本，使用该 checkout 构建的 daemon，不从 latest Release 推导 daemon 版本。公开镜像安装路径从稳定 latest Release 的 Compose 资产解析双镜像相同的严格版本，验证整套产物后才把 `NEMA_IMAGE_TAG=<版本>` 写入本地 `.env` 并给出精确同版 daemon 命令。已有键不覆盖：使用已锁定版本并验证其可用性，冲突或无效值明确报错，不混用 latest。源码路径明确说明该键不是源码版本选择器，不改其已有值。daemon 与 hub 的 skew 检查不变。[推断]
- daemon 安装命令在文档中不再写死某个版本数字，改为写明数字来自已锁定的整套版本（`.env` 里的 `NEMA_IMAGE_TAG` 与 Release 版本相同）。站点与 README 里现有的 `@0.1.4` 字面命令随本期改掉。[推断]
- image-publish 的构建作业发布前 `smoke-compose.mjs --pull never`、发布后 `docker compose pull` 与 `smoke-compose.mjs --pull always` 全部显式传入 `NEMA_IMAGE_TAG=<本次版本>`，与加载/发布的版本 tag 一致，不依赖 fallback latest；源码构建覆盖方式不变。[推断]

### 第 3 期：整套验证与晋升

- 新增 `scripts/release/verify-release.mjs <x.y.z>`，只读。它逐项断言并输出，任一不满足以非零退出并点名缺的那一项：(1) npm registry 上 `@nema-project/nema@<x.y.z>` 存在且 integrity 可读；(2) GHCR 上 hub、web 两镜像的 `<x.y.z>` tag 可匿名读取 manifest；(3) GitHub Release `v<x.y.z>` 存在，资产集与 `release-manifest-<x.y.z>.json` 的期望集一致且包含固定名 `docker-compose.yml`；(4) 三处版本一致：registry 包版本、两镜像的 `org.opencontainers.image.version` 标签、Release 的 tag。第一步上线期间 Release 仍是 draft 时，报告注明 draft 状态，不算缺件。[推断]
- 新增 `.github/workflows/release-promote.yml`，由维护者以 workflow_dispatch 触发，输入 tag。第二步上线后先跑候选预检：验证不可变 tag/SHA、待发布 npm tarball 及其预期完整性、版本镜像与 draft 资产集；此阶段允许 npm registry 尚无该版本。然后幂等发布 npm，再运行包含实际 npm registry 校验的完整 verify-release。完整校验通过后，按既有判定移动两个 GHCR `latest`，最后发布 Release；仅稳定版显式更新 GitHub latest，预发布保留 prerelease 且不更新稳定 latest。不得先要求 registry 版本存在、再执行唯一能发布它的步骤。每完成一步都写入该运行的 job summary；中途失败，summary 必须列明已翻与未翻的指针。[推断]
- npm 改为顺序发布：tag 推送不再直接发布 npm 包。`npm-publish.yml` 的 publish 作业改为可由 promote 的 workflow_dispatch 在 tag ref 上触发，触发后执行与现行 push 路径完全相同的校验（两次重取 tag 比对 SHA、main 祖先关系、check-tag）才发布。文件名不变；仓库仍不存 npm token。发布前先查询精确版本：存在时将 registry tarball 的实际完整性、包身份与候选打包产物比较；一致视为本步已完成，缺失才 publish，不同则拒绝。网络、鉴权或解析错误不能当作不存在；并发 publish 冲突后也必须重新验证，不能吞掉错误。重跑继续后续步骤，不再次盲目 publish。[推断]
- GHCR `latest` 的移动从 image-publish 的 publish 作业移除，改由 promote 执行。版本 tag 的推送保留在原作业、原样不动。移动判定复用 `scripts/images/check-images.mjs --move-latest`，不新写比较逻辑；保留 `prerelease == false` 的稳定版守卫，预发布只能走 npm next/预发布 Release，不移动任何稳定 latest。promote 跨版本使用同一仓库级并发组且不取消进行中的晋升；每次移动 npm/GHCR/GitHub latest 前重读当前版本并禁止倒退。失败后幂等向前重跑，不回滚不可变包或强移版本 tag；summary 标明部分成功窗口。[推断]
- desktop-release 的 publish 作业改为只做到 draft 建好、资产上传并校验资产集为止；`gh release edit --draft=false` 移到 promote 的最后一步。draft 复用规则与「拒绝覆盖已发布 Release」不变。[推断]
- promote 不建 tag、不合并 PR。tag 创建保持维护者的独立人工步骤。[推断]
- 真机冒烟与 CX 验收作为独立后续事项记录；维护者可选择快速发布，不要求无关的小版本等待完整功能验收。打 tag 不等于这些验收通过。promote 只验证产物一致性，不查这两项，也不声称它们完成；安全与已知发布阻断问题仍需处理。[推断]

### 留待维护者定的问题

- **问题 1（promote 确认格）**：第 3 期第二步，候选预检通过、npm 发布之前是自动翻完三个指针（A），还是停在「就绪」、由维护者再 dispatch 一次确认才翻（B）。选定前，第 3 期的 plan 只能写到只读验证为止。第 1、2 期不受影响。[推断]
- **问题 2（setup 是否执行安装）**：setup 向导给出 daemon 安装命令时，只打印命令让用户执行（A），还是当场询问、确认后由向导执行 `npm i -g`（B）。选定前，第 2 期 plan 里 setup 的这一小段不写，其余部分不受影响。[推断]

## 留给实现者

- stamp-version 写 lockfile 的方式：`npm version --workspaces` 或定向改 JSON 都可以，条件是最终 diff 只含预期文件的预期行，且自检失败时输出能指出是哪一处不一致、自检失败后恢复被本命令修改文件的原始字节，不覆盖原有用户改动。
- cut-changelog 的小节排布细节：新小节与历史小节之间空行的既有排布照抄当前文件。
- 形态断言与版本断言拆分后的函数命名与测试组织。形态断言不得拒绝 `${NEMA_IMAGE_TAG:-latest}` 这一插值形式。
- verify-release 查询各注册表的具体做法：npm registry 的 JSON、crane 匿名读 manifest、`gh release view` 都可以。超时与重试次数自定。输出以「缺哪一项」一眼可读为准。
- promote 与 npm-publish 之间 dispatch 的参数传递与等待做法（`gh workflow run` 加轮询，或其他等价方式），的具体实现。release-promote 必须跨版本串行、移动前重读并防倒退，此处不是可选政策。都要过更新后的 `scripts/ci/workflows.test.mjs`。
- job summary 里指针记录的排版。
- desktop-release 资产集期望清单加入 `docker-compose.yml` 的具体改法（`release-manifest.mjs` 与 `validate-release.mjs` 的对应期望）。

不留给实现者的：三期顺序与第 3 期两步上线；整套就绪定义与最终 Compose/Release 单入口（不承诺跨注册表原子事务）；翻指针的顺序（npm → GHCR `latest` → Release publish）；不存长期凭据；tag 不由 CI 创建；CHANGELOG 日期为截稿日；盖印命令不自动 commit、tag、publish；daemon 安装命令必须带版本且数字来自锁定版本；问题 1、问题 2 在选定前不得自行替维护者决定。

## 验收标准

1. 在一份 trio 预先不一致的树上跑 `release:stamp`：命令非零退出、指出不一致处，且执行后 `git status` 与执行前一致（没有半写入）。在一致的树上盖到新版本后，第 1 期 `node scripts/npm/check-tag.mjs v<新版本>` 通过；第 2 期再加模板形态与渲染资产检查，`git diff --stat` 只含三个 `package.json` 与 `package-lock.json`。
2. `[Unreleased]` 有条目时跑 `release:cut`：条目整体出现在新小节、标题日期是执行当天，`[Unreleased]` 只剩空标题；为空时命令拒绝且 CHANGELOG 不变。随后 `node scripts/release-notes.mjs --check CHANGELOG.md <新版本>` 通过。
3. 仓库根 compose 不含字面版本 pin；形态断言对模板通过；`stamp-compose.mjs` 的产物通过版本断言（双镜像 pin 等于给定版本、不用 `latest`）。image-publish 的发布前 `--pull never` 与发布后 pull/smoke 均显式传入 `NEMA_IMAGE_TAG` 并通过，以该工作流的 CI 结果为准。
4. 站点、README 四份、guide 三份中不再有随版本变化的 compose 下载 URL（以 grep 不到 `raw.githubusercontent.com` 的带版本 compose 链接、也不到 `blob/v<版本>/docker-compose.yml` 形式的链接为准）。模拟一次发布（新 tag 的 Release 资产齐全）后，这些文件零改动即指向新版本。
5. 公开镜像安装在干净环境从经整套验证的稳定 Release Compose 资产解析版本后写入 `.env` 并给出同版 daemon 命令；已有键则沿用该版本并验证，不覆盖或混用 latest。源码 setup 的 hub/web 与 daemon 均来自 checkout，不受 latest Release 或已有镜像锁定键影响。用临时目录与假的 Release 数据测，不碰真实用户数据。
6. verify-release 对一套故意缺件的发布（例如 web 镜像缺该版本 tag）非零退出，输出点名缺项；对完整一套退出 0 并逐项列明四项证据。只读阶段至少经历一次真实发布、报告与注册表实际状态一致且无误报，才允许开始第 3 期第二步。
7. 第二步上线后的发布：promote 的 job summary 按顺序记录 npm 发布、两个 GHCR `latest`、Release publish 三步。人为让某一步失败（例如让 npm dispatch 指向已移动的 tag）时，后续指针不翻，summary 列明已翻与未翻。当任一稳定指针已指向更高版本时，promote 不倒退它；并发不同版本、预发布、npm 已存在且 integrity 相符/不符、npm 成功后失败再重跑均有测试；最终 Release 晋升之前失败不改变受支持安装入口。
8. `scripts/ci/workflows.test.mjs` 随工作流改动更新且全绿。新增脚本都有相邻的 `*.test.mjs`，风格与 `scripts/` 下既有脚本一致。相关测试命令在各期 PR 里按 AGENTS.md 的对应行执行并报告。
9. 三份 RELEASE.md 与 CONTRIBUTING 里与本设计冲突的操作步骤，在各期实现提交里同步更新：第 1 期改发布准备步骤，第 2 期改安装说明，第 3 期改 tag 之后的收口与指针时机。本设计提交本身不改这些文件、不改 CHANGELOG 与 ROADMAP、不关闭 #63。

## 本设计明确不做、留给以后的

- tag 创建自动化：需要先修订三份 RELEASE.md 的政策原文，再另写设计。
- manifest 版本由 tag 派生（树内不再存发布版本）：会推翻 check-tag 的 tree==tag 契约，收益只是发布 PR 的 diff 更小。盖印落地后若仍觉繁琐，再议。
- 发布列车与 feature flag：与本设计的机械简化正交，不在本设计内决定。
