# 发布机制 第 2 期：入口动态化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让仓库树不再保存「下一版」的镜像 pin，让受支持的 Compose 入口不随版本变化：根 compose 变成带 `${NEMA_IMAGE_TAG:-latest}` 的模板，发布用的 Compose 资产由 `stamp-compose.mjs` 从模板渲染成双镜像同版 pin 的文件并随 Release 以固定名 `docker-compose.yml` 发布；首次安装从该资产解析一次版本、验证整套产物后锁进本地 `.env`，再给出同版 daemon 命令（只打印，不执行）。

**Architecture:** 模板只描述形状，资产只描述版本。`check-images.mjs` 因此拆成两组断言：形态断言对仓库模板跑（服务、端口、健康检查、`postgres:17`、hub/web 不 `build:`、hub/web 的 `image:` 必须正好是 `${NEMA_IMAGE_TAG:-latest}` 插值形式），版本断言对渲染后的资产跑（双镜像 pin 等于发布版本、不出现 `latest`）。`stamp-compose.mjs` 是模板到资产的唯一转换入口，渲染后立刻用版本断言自检，不过就不写文件。desktop-release 的 publish 作业在建 draft 前渲染该资产、把它并入资产集校验与 `SHA256SUMS`。公开链接换成 `releases/latest/download/docker-compose.yml` 是同一期的最后一步，且必须等第一个带该资产的版本真的发布并验证通过后才合并。

**Tech Stack:** Docker Compose v2，Node.js 22（内置 `node:test`、`fetch`），GitHub Actions（钉 SHA），`gh` CLI。不新增 npm 依赖：`yaml` 已经在 devDependencies 里。

**Spec:** `docs/superpowers/specs/2026-10-28-release-mechanics-design.md`，第 91–101 行「第 2 期：入口动态化」整节，以及「约束」64–72 行、「留给实现者」118–128 行、「验收标准」第 3/4/5/8/9 条。动手前读全文。规格里的问题 1（promote 自动翻指针）属于第 3 期，本计划不涉及；问题 2 已由维护者选定 **A：只打印 daemon 安装命令，不当场执行 `npm i -g`**，本计划按 A 写，不再列为待定。

**Base:** 代码基线 `860a8d684964c615cd9210489dd74fd9c5edf686`（写本计划时的 `origin/main`，Merge pull request #76）。动手前：

```sh
git fetch origin main
git merge-base --is-ancestor 860a8d684964c615cd9210489dd74fd9c5edf686 HEAD
git log --oneline 860a8d684964c615cd9210489dd74fd9c5edf686..HEAD
git diff --name-only 860a8d684964c615cd9210489dd74fd9c5edf686..HEAD
```

ancestry 必须成功。`860a8d6..HEAD` 里只允许文档提交（本计划文件）；出现其它路径时先停。不要要求 `git rev-parse HEAD` 等于基线：计划提交合入后 HEAD 必然比基线多几笔文档提交。

## 写本计划时核对的代码（860a8d6）

下面每条都在基线上读过。行号是基线行号；实现时若与这里不符，先改本计划再写代码。

- `docker-compose.yml`：第 35 行 hub `image: ghcr.io/nema-project/nema-room-hub:0.1.5`，第 65 行 web `image: ghcr.io/nema-project/nema-room-web:0.1.5`。第 1–15 行注释写着「Published installs: fetch docker-compose.yml from tag v0.1.5」「use the matching 0.1.5 host daemon」「main can advance ahead of published artifacts」。这些注释随本期失效，必须一起改。
- `.env.example`：27 行。第 19 行起是 `# --- Only used by \`npm run up\` (docker compose) ---` 段。`node scripts/setup.mjs` 在 `.env` 不存在时用 `copyFile(.env.example → .env, COPYFILE_EXCL)`（`scripts/setup.mjs` 第 190 行）复制它。
- `scripts/images/check-images.mjs`：`assertComposeImages(text, version)` 在 31 行，第 35 行已经有 `/image:\s+\S+:latest\b/`（实测**不**匹配 `${NEMA_IMAGE_TAG:-latest}`），第 38–39 行用 `text.includes('image: <image>:<version>')` 要求字面 pin，第 41–58 行是形状部分（hub/web 不 `build:`、端口、`NEMA_HUB_URL`、`postgres:17`、健康检查）。`checkRepositoryImages(root, tag)` 在 94–103 行读三个 manifest 与 helper，再对根 compose 跑 `assertComposeImages`。CLI 在 121–140 行，支持 `--move-latest`、`--budget`、可选 `[v<version>]`。
- `scripts/images/check-images.test.mjs`：第 10 行把根 compose 读成 `published`；第 25 行「published compose pins hub and web and rejects drifted fixtures」用把 `:<desktopVersion>` 换成 `:latest` 的字符串替换做夹具；第 64 行「repository compose file matches the desktop version」；第 73 行「ports and the hub URL follow env on the published file and the source build」通过 `docker compose config` 断言 `plain.services.hub.image === ...hub:${desktopVersion}`，并断言 `docker-compose.yml + docker-compose.build.yml` 合并后 `build.target` 是 `hub`/`web`。**这两个用例需要 Docker**，本机没有 Docker 时不要写「已通过」。
- `scripts/images/smoke-compose.mjs`：`parseArgs` 在 74 行，没有版本参数；`smokeCompose` 在 139 行的 `env`（149–156）是 `{ ...process.env, NEMA_DATA_HOST_DIR, NEMA_UID, NEMA_GID }`，所以工作流里给 step 加 `NEMA_IMAGE_TAG` 就能传进 `docker compose`，脚本本身**不需要**改。
- `.github/workflows/image-publish.yml`：第 105 行跑 `scripts/images/*.test.mjs`；第 117 行 `node scripts/images/check-images.mjs "$REF_NAME"`、第 125 行 `node scripts/images/check-images.mjs`；第 228–230 行 `Smoke the loaded images` → `smoke-compose.mjs --pull never --hub-port 4410 --web-port 3010`；第 291 行 publish 作业 `node scripts/images/check-images.mjs "$TAG"`；第 304–340 行 move latest；第 366 行 `docker compose pull`、第 369 行 `smoke-compose.mjs --pull always ...`。
- `.github/workflows/desktop-release.yml`：publish 作业第 299–307 行整理 `release-input`/`release-payloads`，308–314 行逐 target 跑 `desktop:validate-release`，315–320 行 `node scripts/desktop/release-manifest.mjs collect release-input release-assets "$VERSION" "$PRERELEASE"`，321–323 行重验远端 tag，324–341 行拒绝已发布 Release 并校验复用 draft 的既有资产「都必须在 release-assets 里」，345–367 行建/复用 draft、`gh release upload "$TAG" release-assets/*`、比对 `expected`（`release-assets` 的文件名）与 `actual`（draft 资产名）、最后 `gh release edit --draft=false`。
- `scripts/desktop/release-manifest.mjs`：`expectedTargets` 6 行，`expectedAssets(version, target)` 13 行，`collectReleaseManifest` 68 行，manifest 结构在 100 行，`SHA256SUMS-<version>.txt` 由非 `SHA256SUMS-` 资产拼出（103–105 行）。`scripts/desktop/release.test.mjs` 第 49 行断言 `files.length === 7`，第 52–53 行断言合并校验和里正好三个安装包名。
- `scripts/desktop/validate-release.mjs`：只做桌面 payload 资格校验（`parseReleaseValidationArgs` 6–11 行 → `validatePublicationEligibility` 17 行），**不校验 Release 资产集**。规格「留给实现者」把它和 `release-manifest.mjs` 并列写成「资产集期望」，与代码不符；本计划按代码写。
- `scripts/ci/workflows.test.mjs`：253 行「image smoke paths are fixed and the workflow is not invented」，322–372 行「image publish pushes pinned GHCR images only after verify, and only from the publish job」（361–366 行断言 smoke 文案 `/docker compose pull/` 与两条 smoke-compose 命令），279–320 行用 `gh` 桩直接跑 publish 作业里名为 `Create or reuse draft, upload, publish` 的那一步。
- `scripts/release/stamp-version.mjs`：`selfCheck` 在 122–128 行，注释写「The image-version assertion joins in phase 2」，只跑 `check-tag`。`scripts/release/stamp-version.test.mjs` 第 114–115 行断言源码匹配 `/phase 2/` 且**不**出现 `check-images`。第 1 期把这件事明确留给了本期；`CONTRIBUTING.md` 第 82、84 行、`scripts/npm/RELEASE.md` 第 46 行、`scripts/images/RELEASE.md` 第 12 行都写着同一句承诺。
- `scripts/compose-dev.mjs`：`devComposeFileArgs = ["-f","docker-compose.yml","-f","docker-compose.build.yml"]`，`devComposeUpArgs()` 返回 `["compose", ...devComposeFileArgs, "up","-d","--build"]`。`scripts/up.mjs` 与 `scripts/setup.mjs` 都用它，源码路径不变。
- 带版本的 compose 链接：`rg -n 'raw.githubusercontent.com/Nema-Project/nema-room/v[0-9]' README*.md docs/guide*.md site/` 在基线上命中 **10 个文件**：`README.md`、`README.en.md`、`README.zh.md`、`README.ja.md`、`docs/guide.en.md`、`docs/guide.zh.md`、`docs/guide.ja.md`、`site/index.html`、`site/ja/index.html`、`site/zh/index.html`。每个文件同时有一处 `blob/v0.1.5/docker-compose.yml` 链接和一处 `curl -fsSLO https://raw.githubusercontent.com/.../v0.1.5/docker-compose.yml`。没有第四个 guide 文件（`docs/guide.md` 不存在）。
- `README.md` 与 `README.en.md` 在基线上**逐字节一致**（`md5sum` 都是 `b60127dcd32f7c68413750295587633d`），`scripts/ci/docs-check.mjs` 也把「English README files must be byte-identical」当错误条件。这条现在成立，本期必须保持。
- daemon 命令的实际现状：`site/index.html` 第 289、290 行与 `site/{ja,zh}/index.html` 对应行写死 `npm i -g @nema-project/nema@0.1.5`（**不是** `@0.1.4`）；`README*.md` 与 `docs/guide*.md` 用占位符 `@<hub version>` / `@<hub 版本>` / `@<hub のバージョン>`，`@nema-project/nema@0.1.3` 只作为「2026-10-27 手动首发」的历史事实出现。规格说的「现有的 `@0.1.4` 字面命令」在基线上不存在。
- 源码构建的镜像名随模板变化：今天 `npm run up` 把构建结果打成 `ghcr.io/nema-project/nema-room-hub:0.1.5`，改模板后（`NEMA_IMAGE_TAG` 未设时）会打成 `…:latest`。仓库里没有任何步骤依赖这个本地 tag 名：`verify.yml` 的 `npm run up` 只等端口，image-publish 的 `--pull never` 冒烟会显式传 `NEMA_IMAGE_TAG`（任务 5）。这是源码路径的可见变化，写进 PR 描述。
- `scripts/ci/policy.mjs`：`imageFiles` 只有 `Dockerfile`、两个 compose 文件、`image-publish.yml`；`scripts/install/**` 不在任何分类前缀里，落在 `mode: app`、`platform: false`、`npmPack: false`。
- `docs-check.mjs` 只校验本地链接与「英文 README 逐字节一致」，**不抓远端 URL**，所以链接切换的「HTTP 200」只能人工实测。

## 与规格不一致、按代码写的地方

规格是 2026-10-28 在 `d765122` 上写的，基线已经是 `860a8d6`。下面这些点是实际代码与规格文字对不上的地方，本计划按代码写，不为了贴合规格去描述不存在的形状。

1. **`validate-release.mjs` 不校验资产集。** 规格「留给实现者」把 `release-manifest.mjs` 与 `validate-release.mjs` 并列成「资产集期望」，但 `scripts/desktop/validate-release.mjs` 只做桌面 payload 资格校验（`parseReleaseValidationArgs` → `validatePublicationEligibility`）。资产集期望全在 `release-manifest.mjs` 的 `collectReleaseManifest` 与 `desktop-release.yml` 的 `expected`/`actual` 比对里。本计划只改 `release-manifest.mjs`（任务 3），不动 `validate-release.mjs`。
2. **站点写死的是 `@0.1.5`，不是 `@0.1.4`。** `site/{index,ja/index,zh/index}.html` 第 289、290 行各两处 `npm i -g @nema-project/nema@0.1.5`。`README*.md` 与 `docs/guide*.md` 用的是占位符 `@<hub version>` / `@<hub 版本>` / `@<hub のバージョン>`；`@nema-project/nema@0.1.3` 只作为「2026-10-27 手动首发」的历史事实出现在第 83、101 行一类位置。规格说的「现有的 `@0.1.4` 字面命令」在基线上不存在，任务 9 按实测结果处理。
3. **带版本的 compose 链接正好 10 个文件，没有第四个 guide。** 规格任务描述里提过 `docs/guide.md`「?」；实测没有这个文件。10 个文件是四个 README、三个 `docs/guide.<lang>.md`、三个站点页。
4. **`README.md` 与 `README.en.md` 确实逐字节一致**（`md5sum` 同为 `b60127dcd32f7c68413750295587633d`），`docs-check.mjs` 也强制这一条。本期必须维持，任务 9、10 都带 `cmp` 检查。
5. **第 1 期把「镜像版本断言」明确留给了本期，散在五处**：`scripts/release/stamp-version.mjs` 第 123 行的注释、`scripts/release/stamp-version.test.mjs` 第 114–115 行断言源码里有 `phase 2` 字样、`scripts/npm/RELEASE.md` 第 46 行、`scripts/images/RELEASE.md` 第 12 行、`CONTRIBUTING.md` 第 82、84 行。这些不是可选项，是本期必须收掉的承诺（任务 4、11）。
6. **仓库里没有「公开镜像安装路径」的可执行入口。** `scripts/setup.mjs` 只做源码构建；`dist-npm` 打出的包里只有 `dist`、`src/report/SKILL.md`、`LICENSE`，不含任何 install 脚本。零 clone 的用户今天能做的只有 `curl` 一份 compose。所以任务 8 的 `scripts/install/public.mjs` 是这套流程的**入库实现**（从 checkout 运行，也给第 3 期复用），而零 clone 的等价手工流程是「下载资产 → 从文件读出双镜像版本 → 写 `.env` → 装同版 daemon」，任务 9 把它写成文档。若维护者要的是「零 clone 也能跑的一键安装器」，那需要把脚本本身作为第二个固定名资产发布，会扩大资产集，**本期不做**，也不在这份计划里假装有。
7. **`check-images.mjs` 现有的 `:latest` 正则本来就放过插值。** 第 35 行 `/image:\s+\S+:latest\b/` 对 `image: ghcr.io/nema-project/nema-room-hub:${NEMA_IMAGE_TAG:-latest}` 实测**不匹配**；拦住模板的是第 38–39 行的字面 pin 断言。所以「不出现字面钉版的 `:latest`」这条今天已经成立，任务 1 要做的是把字面 pin 断言从模板移到资产，并把「模板里必须是插值」变成一条正面断言。
8. **`smoke-compose.mjs` 不需要改。** 它在 `smokeCompose` 里把 `process.env` 展开进 `docker compose` 的环境变量（第 149–156 行），所以工作流 step 上加 `NEMA_IMAGE_TAG` 就够。规格说「全部显式传入」，落在工作流层面，不在脚本层面。
9. **`image-publish.yml` 的 PR 构建会立刻暴露「模板 `:latest` 与本地加载的 `${VERSION}` 不一致」**：第 220–223 行把镜像 tag 成 `ghcr.io/nema-project/nema-room-hub:${VERSION}`，第 230 行 `--pull never` 冒烟。模板改成插值后若不同时传 `NEMA_IMAGE_TAG`，PR 冒烟会找不到 `:latest`。任务 1 与任务 5 必须在同一个 PR 里，不能拆开合。
10. **`scripts/ci/policy.mjs` 没有 `scripts/install/` 分类。** 落进 `mode: app`、`platform: false`、`npmPack: false`：PR 会跑完整应用测试，但不会跑 macOS/Windows 平台作业，也不会跑 npm pack。本期不改这个分类表。

## Global Constraints

- 每期独立 PR，独立合并。本计划 12 个任务，未超 15。
- 只写文档的任务（本文件）不改任何生产代码、工作流、校验器；本文件不改 `CHANGELOG.md`、`ROADMAP.md`，不关闭 #63。
- 本期不改 `CHANGELOG.md` 与 `ROADMAP.md`（任务要求）。AGENTS.md 第 83 行要求用户可见变更进 `changelog.d/<slug>.<category>.md` 片段；本期是否要一条由维护者定，默认不加，且无论如何不直接改 `CHANGELOG.md`。
- `.github/workflows/npm-publish.yml` 的文件名是 npm trusted publisher 绑定的一部分，**不改名**。本期不改它的行为。
- GitHub Actions 全部钉完整 SHA。`scripts/ci/workflows.test.mjs` 的契约测试随工作流改动同步更新，不绕过、不注释。
- 不存长期凭据。除 `GITHUB_TOKEN` 外不新增任何 secret。不自动 commit、tag 或 publish；tag 不由 CI 创建。
- 三份 `RELEASE.md`（`scripts/npm/`、`scripts/images/`、`scripts/desktop/`）的政策不变：tag 只打在该 SHA 的 main CI 已成功的提交上，tag 创建是维护者的独立步骤。
- 模板里的 `:-latest` **只**服务源码开发流程（`npm run db:up`、`npm run up` 的合并配置）。裸 `latest` 不得出现在任何受支持安装说明里，也不得成为发布资产的取值。
- 发布资产永远是双镜像同版 pin 的字面文件；`.env` 里的 `NEMA_IMAGE_TAG` 是这次安装记录的锁定版本。二者由同一次读取产生，安装器不得在两者不一致时写入。
- `README.md`、`README.en.md`、`README.zh.md`、`README.ja.md` 与 `docs/guide.{en,zh,ja}.md` 同一次改；`README.md` 与 `README.en.md` 必须保持逐字节一致（基线成立，见上）。
- daemon 安装命令必须带版本，数字来自已锁定的整套版本（`.env` 的 `NEMA_IMAGE_TAG` 与 Release 版本相同）。不写无版本命令冒充「能配任意 hub」。
- 代码、注释、提交信息用英文；本文件用中文。工作流里新增的 shell 一律 `set -euo pipefail`。
- 不改 `scripts/ci/policy.mjs` 的分类表：本期不给 `scripts/install/**` 新增 `platform` 或 `npm` 分类（改它只会让 install 相关 PR 多跑 macOS/Windows，属于另一次有意的 CI 成本决定）。
- 不新增 npm 依赖，不新建迁移，不改 `apps/**` 的运行时代码。本期只碰 `scripts/**`、`docker-compose.yml`、`.env.example`、`.github/workflows/**` 与文档/站点。
- 测试用 Node ≥ 22（本机 `export PATH=/tmp/node-v22.20.0-linux-x64/bin:$PATH`）。`check-images.test.mjs` 的两个用例要 Docker；没有 Docker 的环境跑 `node --test scripts/images/*.test.mjs` 会有失败，报告时必须如实写「Docker 缺失，未验证」，不能写成通过。
- 第 3 期的东西一律不写进本期：`verify-release.mjs`、`release-promote.yml`、npm 顺序发布、GHCR `latest` 移交、desktop-release 只到 draft、`prerelease == false` 守卫、promote 的幂等与防倒退。

## 实现者选择（已定）

规格「留给实现者」的几项，按下面做，不再另选。

1. **断言函数（`scripts/images/check-images.mjs`）。** 导出 `assertComposeShape(text)`（模板与资产共有的形状）、`assertComposeTemplate(text)`（形状 + 必须正好是插值形式）、`assertComposeAsset(text, version)`（形状 + 双镜像字面 pin 等于 `version` 且不含 `:latest`）、`renderComposeAsset(template, version)`（纯字符串转换）、`composeAssetVersion(text)`（从资产里读出两个镜像共同 pin 的严格版本，供安装器用）。`assertComposeImages` 这个名字删除，不保留别名；`assertPackageVersions`、`shouldMoveLatest`、`assertImageBudget`、`IMAGE_BUDGET_BYTES`、`HUB_IMAGE`、`WEB_IMAGE` 不动。
2. **`checkRepositoryImages(root, tag?)` 的语义。** 永远跑模板形态断言；给了 `tag` 时再用 `renderComposeAsset` 渲染并跑版本断言，返回版本号。这样 `image-publish.yml` 第 117、125、291 行三处调用都不用改参数。CLI 新增 `--asset <file> <x.y.z>`，对任意一份已渲染的资产跑版本断言；不带参数仍是「模板形态 + 三包版本自检」。
3. **`stamp-compose.mjs` 的形态。** `node scripts/images/stamp-compose.mjs <x.y.z>` 把渲染结果写到 stdout（不落盘）；`node scripts/images/stamp-compose.mjs <x.y.z> <path>` 自检通过后才写文件；`--check` 只自检、不输出也不写。拒绝把仓库根的 `docker-compose.yml` 当输出路径（防止把模板渲染成资产）。
4. **Release 资产的名字与清单。** 固定名 `docker-compose.yml`，不放进 `targets`（它是单份，不属于某个桌面 target）。`collectReleaseManifest` 增加一个参数接收该文件的路径，manifest 增加顶层键 `compose: { name, size, sha256 }`，并把它计入 `SHA256SUMS-<version>.txt`。`validate-release.mjs` **不动**（它校验桌面 payload，不校验资产集）。
5. **安装器位置。** 新增目录 `scripts/install/`：`release-set.mjs`（纯校验）与 `public.mjs`（解析、写 `.env`、打印命令）。`scripts/setup.mjs` 只加「读出并自检 checkout 版本」这一小段，源码构建路径的其余行为与 `devComposeUpArgs()` 不变。
6. **`.env` 的写法。** 只动 `NEMA_IMAGE_TAG` 一行：已有合法值就原样保留、不覆盖；没有就追加一行（前面带一行注释）。整文件读入、改行、写临时文件再 `rename`，保留其它行与结尾换行状态。
7. **已有键的判定。** `NEMA_IMAGE_TAG` 是严格 SemVer（不带 `v`、不是 `latest`、不是预发布）时算合法。合法即沿用并按该版本验证整套产物；该版本与最新 Release 不同则打印一行说明（安装仍停在原版本）并以 0 退出。空值、`latest`、非 SemVer、预发布一律非零退出，不写文件。

## Review Focus

1. 形态断言会不会拒绝 `${NEMA_IMAGE_TAG:-latest}` 这种插值，或者反过来放过字面 pin。→ 任务 1。
2. 发布资产是不是真的来自模板渲染，而不是第二份手写文件。→ 任务 2、3。
3. `stamp-version` 的自检是不是真的接上了渲染检查，而不是继续留着「phase 2 再做」的注释。→ 任务 4。
4. image-publish 的三处 compose 调用有没有一处漏传 `NEMA_IMAGE_TAG`，从而悄悄拉 `latest`。→ 任务 5（含契约断言）。
5. 安装器有没有在缺件时仍然写 `.env` 或打印「已锁定」，有没有覆盖已有键。→ 任务 7、8。
6. 链接切换是否在前置门未满足时就被合并。→ 任务 10。
7. 文档里是否还留着一个写死的 daemon 版本数字或一句「它不是发布资产」。→ 任务 9、10、11。

本期的范围边界见文末「本期明确不做」。

---

### Task 1: 拆分形态断言与版本断言，模板改为插值

**Files:**
- Modify: `scripts/images/check-images.mjs`
- Modify: `docker-compose.yml`（第 1–15 行注释、第 35 行、第 65 行）
- Modify: `.env.example`
- Test: `scripts/images/check-images.test.mjs`

**Interfaces:**
- `check-images.mjs` 新增并导出 `assertComposeShape(text)`、`assertComposeTemplate(text)`、`assertComposeAsset(text, version)`、`renderComposeAsset(template, version)`、`composeAssetVersion(text)`；删除 `assertComposeImages`。
- `assertComposeShape(text)`：模板与资产共用的形状部分，今天 `assertComposeImages` 第 41–58 行那些条件原样搬过来——服务齐全、`postgres:17`、hub/web 块里没有 `build:`、端口 `127.0.0.1:${NEMA_HUB_PORT:-4400}:${NEMA_HUB_PORT:-4400}`、`127.0.0.1:${NEMA_WEB_PORT:-3000}:3000`、`NEMA_HUB_URL: ${NEMA_HUB_URL:-http://127.0.0.1:${NEMA_HUB_PORT:-4400}}`、hub 健康检查含 `/api/daemon/status`、web 含 `127.0.0.1:3000`。**不看** `image:` 的值。
- `assertComposeTemplate(text)`：`assertComposeShape` + hub/web 的 `image:` 值**正好**是 `ghcr.io/nema-project/nema-room-hub:${NEMA_IMAGE_TAG:-latest}` 与 `ghcr.io/nema-project/nema-room-web:${NEMA_IMAGE_TAG:-latest}`，且全文件不出现 `image: <任意>:latest` 字面量（`${NEMA_IMAGE_TAG:-latest}` 这种写法按现有正则本来就不匹配，已实测）。模板里出现 `0.1.5` 之类字面 pin 时这一条必须报错。
- `assertComposeAsset(text, version)`：`assertComposeShape` + 出现 `image: ghcr.io/nema-project/nema-room-hub:<version>` 与 web 同式 + 不含 `:latest` + 不含 `${NEMA_IMAGE_TAG`。**不调用** `assertComposeTemplate`：资产是渲染结果，本来就没有插值。`version` 必须是严格 SemVer（`readReleaseVersion('v'+version, version)` 通过，不接受 `latest` / `v` 前缀）。
- `renderComposeAsset(template, version)`：先数 `\${NEMA_IMAGE_TAG:-latest}` 的出现次数，必须正好 2（一处 hub、一处 web），再整体替换；然后检查剩下的文本里不含 `$NEMA_IMAGE_TAG`、`${NEMA_IMAGE_TAG}`、`${NEMA_IMAGE_TAG:-` 任何残余写法，出现即报错（计数只认 `${NEMA_IMAGE_TAG:-latest}` 这一种写法，注释里写裸的 `NEMA_IMAGE_TAG` 不加 `$` 不影响；但注释不能写出 `$NEMA_IMAGE_TAG`、`${NEMA_IMAGE_TAG}`、`${NEMA_IMAGE_TAG:-` 这三种残余形式，否则会被残余检查判错）；替换后跑 `assertComposeAsset` 自检。
- `composeAssetVersion(text)`：两条 `image:` 行读出的严格版本必须相同，否则报错并点名两个值。
- `checkRepositoryImages(root, tag)`：模板形态必跑；给 `tag` 时渲染 + 版本断言，返回版本（CLI 输出仍是 `image versions: <version>`）。
- CLI：`check-images.mjs`（无参）、`check-images.mjs v<x.y.z>`、`check-images.mjs --asset <file> <x.y.z>`、`--move-latest`、`--budget` 保持现状。
- `docker-compose.yml`：第 35、65 行改成插值；第 1–15 行注释删掉所有 `v0.1.5` / `0.1.5` 字样（注释里可以写裸的 `NEMA_IMAGE_TAG`，不要写 `$NEMA_IMAGE_TAG` 形式的残余插值，见上一条），改成「main 的 compose 是模板，不含可用版本；公开安装取受支持 Release 的 `docker-compose.yml` 资产；源码开发用 `npm run up`」。
- `.env.example`：新增

  ```sh
  # Hub and web image tag. A supported install writes the full release version here on
  # first install and keeps it. Source checkouts leave it unset and build from this tree
  # with `npm run up`; it is not a source-version selector.
  # The template's `:-latest` only keeps source-only flows (`npm run db:up`) working.
  # NEMA_IMAGE_TAG=<x.y.z>
  ```

**Satisfies:** 验收 3（「仓库根 compose 不含字面版本 pin」「形态断言对模板通过」）、验收 8。

- [ ] **Step 1: 写失败测试**

`scripts/images/check-images.test.mjs`：
- 把第 10 行的 `published` 改名为 `template`。新增 `const asset = renderComposeAsset(template, desktopVersion)`。
- 改写第 25 行那条用例（名字改成 `template shape assertions and asset version assertions reject drifted fixtures`），断言：
  - `assert.doesNotThrow(() => assertComposeTemplate(template))`；
  - `assert.doesNotThrow(() => assertComposeAsset(asset, desktopVersion))`；
  - `assert.throws(() => assertComposeAsset(asset.replaceAll(':' + desktopVersion, ':latest'), desktopVersion), /latest/)`（覆盖从「模板字面 pin」迁到资产一侧，不删）；
  - `assert.throws(() => assertComposeAsset(asset.replace('nema-room-hub', 'nema-room-other'), desktopVersion), /missing/)`；
  - `assert.throws(() => assertComposeTemplate(template.replace('image: ghcr.io/nema-project/nema-room-hub:${NEMA_IMAGE_TAG:-latest}', 'image: ghcr.io/nema-project/nema-room-hub:0.1.5')), /NEMA_IMAGE_TAG/)`（模板里出现字面 pin 必须被拒）；
  - 用旧的 `withBuild` 夹具改成对 `template` 断言 `/hub must not build/`；端口改写的用例同样改成对 `template` 断言 `/NEMA_HUB_PORT/`。
- 新增 `test('renderComposeAsset pins both images and rejects a template without interpolation')`：渲染结果里没有 `:-latest`；`renderComposeAsset('image: x:y', '1.2.3')` 抛错（出现 0 次）；把模板里一处 `:-latest` 改成 `:${NEMA_IMAGE_TAG}` 后抛错；`renderComposeAsset(template, 'latest')` 抛错。
- 新增 `test('composeAssetVersion reads the shared pin')`：从 `asset` 得到 `desktopVersion`；两个镜像 pin 不同时抛错并同时点名两个值。
- 第 64 行那条 CLI 用例保持，`image versions: <desktop>` 的输出不变。
- 第 73 行那条 `composeConfig` 用例：`composeConfig` 的 `base` env 里要和 `NEMA_HUB_URL` 一样显式删掉 `NEMA_IMAGE_TAG`，否则跑测试的人自己的 shell 变量会让结果不确定。`plain` 改成在 `NEMA_IMAGE_TAG` 未设时断言 `:latest` fallback（`assert.equal(plain.services.hub.image, 'ghcr.io/nema-project/nema-room-hub:latest')`），并新增 `const pinned = composeConfig(['docker-compose.yml'], { NEMA_IMAGE_TAG: '9.9.9' })` 断言两个 `:9.9.9`；`built`（合并 build 文件）断言全部保留。

- [ ] **Step 2: 跑** `export PATH=/tmp/node-v22.20.0-linux-x64/bin:$PATH && node --test scripts/images/*.test.mjs` → FAIL（`renderComposeAsset`、`assertComposeTemplate` 不存在；模板还是字面 pin）。没有 Docker 的两个用例此时也会红，报告里分开写。

- [ ] **Step 3: 实现** 上列五个函数与 CLI，改 `docker-compose.yml` 与 `.env.example`。`serviceBlocks` 保持不变（插值不影响块解析）。

- [ ] **Step 4: 跑** 同一条命令 + `node scripts/images/check-images.mjs`（应打印 `image versions: 0.1.5`）+ `node scripts/images/check-images.mjs v0.1.5`。有 Docker 的环境再跑 `docker compose config`（无参时 hub/web 显示 `:latest`，`NEMA_IMAGE_TAG=9.9.9 docker compose config` 显示 `:9.9.9`）并记录实际输出。

- [ ] **Step 5: Commit** `feat(images): split compose shape and version assertions`

### Task 2: `stamp-compose.mjs`

**Files:**
- Add: `scripts/images/stamp-compose.mjs`
- Add: `scripts/images/stamp-compose.test.mjs`

**Interfaces:**
- `stampCompose({ root, version, out = null })` → `{ text, version }`；`out` 为 `null` 时不写文件。
- CLI：`node scripts/images/stamp-compose.mjs <x.y.z>`（stdout）、`<x.y.z> <path>`（自检通过才写）、`--check <x.y.z>`（只自检；`--check` 可以放在版本号前或后，两种都接受）。
- 输出路径等于 `<root>/docker-compose.yml` 时直接拒绝（`refusing to overwrite the compose template`）。
- 写文件用「写临时文件 + rename」，自检失败时不留半份文件，也不改已存在的旧文件。
- 成功时 stdout 打一行 `compose asset: <version> ok`（写文件模式在 stderr 打 `wrote <path>`）。

**Satisfies:** 验收 3（「`stamp-compose.mjs` 的产物通过版本断言」）、验收 8。

- [ ] **Step 1: 写失败测试**

`scripts/images/stamp-compose.test.mjs`（用 `mkdtemp` 在临时目录复制一份 `docker-compose.yml`）：
- `it('renders both images to the given version and leaves the template untouched')`：`stampCompose({root, version:'9.9.9'})` 的 `text` 含两个 `:9.9.9`、不含 `:-latest`，`root/docker-compose.yml` 字节不变。
- `it('writes the output only after the version assertion passes')`：`out` 指向临时目录里的 `docker-compose.yml`，写后文件与 `text` 相同。
- `it('refuses the repository template path and a non-release version')`：`out` 指向 `root/docker-compose.yml` 抛 `/refusing to overwrite/`；`version` 为 `'v1.2.3'`、`'latest'`、`'1.2'`、`''` 各自抛错且不写文件。
- `it('writes nothing when the rendered file fails the assertion')`：把临时模板的 web 行改成 `...:${OTHER_TAG:-latest}`，`out` 已存在旧内容；调用抛错后旧内容不变。
- `it('--check prints the result and writes nothing')`：`spawnSync` CLI，`--check 9.9.9` 退出 0、stdout 有 `compose asset: 9.9.9 ok`、目录里没有新文件。

- [ ] **Step 2: 跑** `node --test scripts/images/stamp-compose.test.mjs` → FAIL（模块不存在）。

- [ ] **Step 3: 实现** 复用 Task 1 的 `renderComposeAsset` / `assertComposeAsset`，不要在该文件里复制断言逻辑。

- [ ] **Step 4: 跑** `node --test scripts/images/*.test.mjs` → PASS（Docker 缺失时那两个用例除外，见 Global Constraints）。

- [ ] **Step 5: Commit** `feat(images): render a pinned compose asset from the template`

### Task 3: desktop-release 附上固定名 Compose 资产

**Files:**
- Modify: `scripts/desktop/release-manifest.mjs`
- Modify: `.github/workflows/desktop-release.yml`
- Test: `scripts/desktop/release.test.mjs`

**Interfaces:**
- `collectReleaseManifest({ version, prerelease, artifactsRoot, outputDir, build, composeAsset = null })`：`composeAsset` 是文件路径。给了就要求文件存在、非空、名字正好 `docker-compose.yml`，复制进 `outputDir`，manifest 增加 `compose: { name, size, sha256 }`，并把 `sha256  docker-compose.yml` 追加到 `SHA256SUMS-<version>.txt`（按安装包顺序之后）。`targets` 结构不变。
- CLI `collect` 的 `rest` 从 4 个变 4 或 5 个：`collect <artifacts-root> <output-dir> <version> <prerelease> [<compose-file>]`；其它长度仍报 usage（`release-manifest.mjs` 第 117–124 行）。
- `desktop-release.yml` publish 作业在 `Verify the complete asset set` 之前增加一步 **`Stamp the Compose asset`**（独立 step，名字固定，供契约测试定位）：

  ```yaml
  - name: Stamp the Compose asset
    shell: bash
    run: |
      set -euo pipefail
      node scripts/images/stamp-compose.mjs "$VERSION" compose-asset/docker-compose.yml
  ```

  然后 `node scripts/desktop/release-manifest.mjs collect release-input release-assets "$VERSION" "$PRERELEASE" compose-asset/docker-compose.yml`。
- 324–341 行的 draft 复用校验、357 行的 `gh release upload "$TAG" release-assets/*`、359–364 行的 expected/actual 比对都**不改**：`release-assets/docker-compose.yml` 会自动进入 `expected`。注意由此产生的行为：一个在旧版本 workflow 下建的 draft 没有该资产，`expected != actual` 会失败关闭，要人工删掉旧 draft 才能重跑。这是期望行为，写进 `scripts/desktop/RELEASE.md`（任务 11）。

**Satisfies:** 验收 3（资产面）、验收 8。

- [ ] **Step 1: 写失败测试**

`scripts/desktop/release.test.mjs`：
- 更新「collection accepts a complete matrix…」：`files.length` 7 → 8，合并校验和从 3 行变 4 行且最后一行是 `docker-compose.yml`，`written.compose.sha256` 等于文件哈希，`written.targets` 不变。
- 新增 `it('refuses a missing or empty compose asset')`：不传文件、传空文件、传名为 `compose.yml` 的文件，各自抛错且 `outputDir` 里没有半份产物。
- 新增 `it('refuses a duplicate compose asset name')`：在某个 target 目录里放一份 `docker-compose.yml`，collect 抛 `/Unexpected file/`。

- [ ] **Step 2: 跑** `node --test scripts/desktop/release.test.mjs` → FAIL。

- [ ] **Step 3: 实现** 参数、manifest 键、校验和拼接、CLI 第 5 个参数与工作流那一步。

- [ ] **Step 4: 跑** `node --test scripts/desktop/release-commit.test.mjs scripts/desktop/release.test.mjs scripts/release-notes.test.mjs` → PASS。再用一个临时目录跑 `node scripts/images/stamp-compose.mjs 9.9.9 /tmp/x/docker-compose.yml`，把结果交给 `collect` 做一次手工端到端（不连网络）。

- [ ] **Step 5: Commit** `feat(release): attach the rendered compose file to the release asset set`

### Task 4: `stamp-version` 的自检接上渲染检查

**Files:**
- Modify: `scripts/release/stamp-version.mjs`
- Test: `scripts/release/stamp-version.test.mjs`

**Interfaces:**
- `selfCheck(root, version)` 变成两步：`check-tag v<version>` 之后，读 `root/docker-compose.yml`、`renderComposeAsset(template, version)` 并 `assertComposeAsset`。任一步失败都用同一段恢复逻辑把四个版本文件写回原始字节，错误信息点名是哪一步（`check-tag failed for v…` / `compose template failed at v…`）。
- 删除 `selfCheck` 上方那句「The image-version assertion joins in phase 2」注释；`stampVersion` 的对外签名不变。
- 不改 `PACKAGE_FILES`：盖印仍然只改三个 `package.json` 与 `package-lock.json`，不碰 `docker-compose.yml`。

**Satisfies:** 验收 1 的第 2 期部分（「第 2 期再加模板形态与渲染资产检查」）、验收 8。

- [ ] **Step 1: 写失败测试**

`scripts/release/stamp-version.test.mjs`：
- 删掉第 114–115 行的 `assert.match(source, /phase 2/)` 与 `assert.doesNotMatch(source, /check-images/)`，改成 `assert.match(source, /renderComposeAsset/)`。
- 现有「stamping a consistent tree…」用例保留 `docker-compose.yml` 字节不变的断言。
- 新增 `it('refuses when the compose template cannot render at the new version')`：在 fixture 的 `docker-compose.yml` 里删掉一处 `:-latest`，`stampVersion(root, '9.9.9')` 抛错，四个版本文件与 `docker-compose.yml` 全部回到执行前字节，`git status --porcelain` 为空。

- [ ] **Step 2: 跑** `node --test scripts/release/*.test.mjs` → FAIL。

- [ ] **Step 3: 实现** 两步自检 + 注释更新。

- [ ] **Step 4: 跑** `node --test scripts/release/*.test.mjs` → PASS。

- [ ] **Step 5: Commit** `feat(release): make the version stamp check the rendered compose asset`

### Task 5: image-publish 三处 compose 调用显式传版本（含该工作流的契约断言）

**Files:**
- Modify: `.github/workflows/image-publish.yml`
- Modify: `scripts/ci/workflows.test.mjs`（只加 image publish 用例的断言）

**Interfaces:**
- `build` 作业的 `Smoke the loaded images` step 增加 `env: NEMA_IMAGE_TAG: ${{ needs.plan.outputs.version }}`。
- `publish` 作业的 `Push the verified layouts` step 保持 `check-images.mjs "$TAG"`（任务 1 之后它内部会渲染并断言），不新增 compose 调用。
- `smoke` 作业的 `Pull pinned images` 与 `Smoke the pulled images` 两个 step 都增加同样的 `env: NEMA_IMAGE_TAG: ${{ needs.plan.outputs.version }}`。
- 三处都在命令前加 `test -n "$NEMA_IMAGE_TAG"`，空值直接失败，不依赖 fallback `latest`。
- 源码构建覆盖方式不变：`docker-compose.build.yml` 不改，`devComposeUpArgs()` 不改。
- **任务 1 与任务 5 必须在同一个 PR 里合并**：只改模板不传 `NEMA_IMAGE_TAG`，`image-publish.yml` 的 PR 构建会在 `--pull never` 冒烟里找不到 `:latest`（本地加载的镜像是 `${VERSION}`）。
- `scripts/ci/workflows.test.mjs` 的「image publish pushes pinned GHCR images only after verify…」用例新增：`build` 里含 `--pull never` 的 step 必须有 `env.NEMA_IMAGE_TAG`（解析后等于 `needs.plan.outputs.version`）；`smoke` 里含 `docker compose pull` 的 step 与含 `--pull always` 的 step 同样必须有；三个 step 的 `run` 都含 `test -n "$NEMA_IMAGE_TAG"`；该文件里不存在「含 `docker compose` 或 `smoke-compose.mjs` 但不含 `NEMA_IMAGE_TAG`」的 step。既有断言一条不删。

**Satisfies:** 验收 3（「image-publish 的发布前 `--pull never` 与发布后 pull/smoke 均显式传入 `NEMA_IMAGE_TAG` 并通过，以该工作流的 CI 结果为准」）、验收 8。

- [ ] **Step 1: 写失败测试** 按上面最后一条加断言到 `scripts/ci/workflows.test.mjs`。
- [ ] **Step 2: 跑** `node --test scripts/ci/workflows.test.mjs` → FAIL。
- [ ] **Step 3: 实现** 三个 step 的 `env` 与守卫行；`docker compose pull` 与 `smoke-compose.mjs` 的命令文本保持原样（既有契约匹配的是命令前缀）。
- [ ] **Step 4: 跑** `node --test scripts/ci/workflows.test.mjs` → PASS；`actionlint -color` 退出 0（有 `actionlint` 时）。再人工核一遍该文件：所有 `docker compose` / `smoke-compose.mjs` 命令都在带 `NEMA_IMAGE_TAG` 的 step 里。
- [ ] **Step 5: Commit** `ci(images): pass the release version to every compose smoke`

### Task 6: desktop-release 的契约测试

**Files:**
- Modify: `scripts/ci/workflows.test.mjs`（只加 desktop-release 用例的断言）

**Interfaces:**
- desktop-release 用例新增：publish 作业的 step 名字序列里 `Stamp the Compose asset` 出现在 `Verify the complete asset set` 之前；collect 那一步的 `run` 含 `compose-asset/docker-compose.yml`；`gh release upload "$TAG" release-assets/*` 仍在 `Create or reuse draft, upload, publish` 那一步里，且该 step 里仍有 `--draft=false` 与 `--verify-remote`（279–320 行那条用 `gh` 桩跑的测试必须继续通过）。
- 保留全部既有断言；不把任何断言改成 `skip` 或注释。

**Satisfies:** 验收 8。

- [ ] **Step 1: 写测试** 按上面那条加断言。
- [ ] **Step 2: 跑** `node --test scripts/ci/workflows.test.mjs` → FAIL（任务 3 若尚未落地，`Stamp the Compose asset` 不存在）。
- [ ] **Step 3: 实现** 只改测试。
- [ ] **Step 4: 跑** `node --test scripts/ci/*.test.mjs` → PASS。
- [ ] **Step 5: Commit** `test(ci): pin the compose asset step in the desktop release`

### Task 7: 整套产物校验 `scripts/install/release-set.mjs`

**Files:**
- Add: `scripts/install/release-set.mjs`
- Add: `scripts/install/release-set.test.mjs`
- Modify: `.github/workflows/verify.yml`（test 作业加一行 `node --test scripts/install/*.test.mjs`）
- Modify: `scripts/ci/workflows.test.mjs`（verify.yml 用例加一条断言）

**Interfaces:**
- `releaseSetItems(version)` → 四项的稳定描述：`compose asset`、`hub image ghcr.io/nema-project/nema-room-hub:<version>`、`web image ghcr.io/nema-project/nema-room-web:<version>`、`npm @nema-project/nema@<version>`。
- `checkReleaseSet({ version, composeText, fetchImpl })` → `{ version, evidence: string[] }`，四项各一条证据行；任一缺失抛 `Release <version> is not installable: <item>`（多项时全部列出，用 `; ` 分隔）。规则：
  - compose：`composeAssetVersion(composeText) === version`，否则算缺件并说明实际值。
  - npm：`GET https://registry.npmjs.org/@nema-project/nema/<version>`，200 且响应 `version` 字段等于 `version`；404 算缺件。
  - GHCR：先 `GET https://ghcr.io/token?service=ghcr.io&scope=repository:nema-project/nema-room-<target>:pull` 取 `token`，再 `GET https://ghcr.io/v2/nema-project/nema-room-<target>/manifests/<version>`，header `Authorization: Bearer <token>` 与 `Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json`；200 才算在。匿名进行，不用任何凭据。
  - 网络错误、超时、JSON 解析失败一律**不算存在**（不得当成可用）。
- 这个模块是安装器的前置检查，不是 `verify-release`：它不查 Release 资产集、不查镜像版本标签、不查三处版本一致。第 3 期会另写 `verify-release.mjs`，本期不写、不占名字。
- `verify.yml` 的 test 作业在 `node --test scripts/ci/*.test.mjs …` 那一行之后、`npm test -- --maxWorkers=2` 之前插入 `- run: node --test scripts/install/*.test.mjs`；`scripts/ci/workflows.test.mjs` 的 verify 用例断言这一步存在且排在 `npm test -- --maxWorkers=2` 之前。**这一行必须和测试文件在同一个提交里落地**，否则其它 PR 上这一步会因为 glob 不匹配任何文件而失败。

**Satisfies:** 验收 5（「从经整套验证的稳定 Release Compose 资产解析版本」里的验证面）、验收 8。

- [ ] **Step 1: 写失败测试** `scripts/install/release-set.test.mjs`，全部用假 `fetchImpl`，不联网：
  - 四项齐全 → 返回 4 条 `evidence`，每条含对应名字。
  - npm 404 → 抛错且信息含 `npm @nema-project/nema@1.2.3`；GHCR hub 404 → 含 `hub image`；web 403 → 含 `web image`；compose pin 不是该版本 → 含 `compose asset`。
  - 多项同时缺 → 一条错误里四项都点名。
  - `fetchImpl` 抛 `TypeError('fetch failed')` → 抛错且不把该项当已有。
  - token 响应没有 `token` 字段 → 算缺件。
- [ ] **Step 2: 跑** `node --test scripts/install/*.test.mjs` → FAIL（模块不存在）。
- [ ] **Step 3: 实现** 只用 `fetch` 与 `AbortSignal.timeout`，超时 15s，重试 0 次（安装器宁可失败也不猜）；同时加 `verify.yml` 那一行与 workflows 契约断言。
- [ ] **Step 4: 跑** `node --test scripts/install/*.test.mjs` 与 `node --test scripts/ci/*.test.mjs` → PASS。
- [ ] **Step 5: Commit** `feat(install): verify the four released artifacts before claiming a version is installable`

### Task 8: 公开安装路径解析并锁定 `.env`

**Files:**
- Add: `scripts/install/public.mjs`
- Add: `scripts/install/public.test.mjs`
- Modify: `scripts/setup.mjs`（源码路径只加版本读出与自检）
- Test: `scripts/setup.test.mjs`

**Interfaces:**
- `resolveInstall({ dir, fetchText, fetchImpl, now = () => new Date() })` → `{ version, action: 'write' | 'reuse', envPath, composePath, daemonCommand, notes: string[] }`；只做决策，不写盘。
- `applyInstall({ dir, plan })` → 写 `.env`（只在 `action === 'write'` 时写 `NEMA_IMAGE_TAG`）与 `docker-compose.yml`（仅当该文件不存在）。写盘前重读 `.env`，值变了就放弃（并发安全）。
- 版本解析：抓 `https://github.com/Nema-Project/nema-room/releases/latest/download/docker-compose.yml`（跟随重定向），`composeAssetVersion` 得到版本，再 `checkReleaseSet`。
- `dir/.env` 已有合法 `NEMA_IMAGE_TAG=<V>`：`action: 'reuse'`，不写该键；按 `<V>` 验证整套产物；`<V>` 与资产版本不同时 `notes` 里加一行「install stays on <V>; fetch the asset for v<V> from …/releases/download/v<V>/docker-compose.yml」，退出码仍为 0。
- 已有值非法（空、`latest`、`v` 前缀、非 SemVer、预发布）：抛错，点名 key 与值，不写任何文件。
- `daemonCommand`：`npm i -g @nema-project/nema@<version>`；同时给出 `npx @nema-project/nema@<version> --version`。**只打印，不执行**（问题 2 选 A）。
- CLI：`node scripts/install/public.mjs [--dir <path>] [--check]`。`--check` 打印决策与证据、不写盘；不带 `--check` 时按 `applyInstall` 写入，然后打印 daemon 命令与 `docker compose up -d`。stdout 每一行都要能让用户分辨「已锁定」「沿用的旧锁定」「缺失项」。
- `scripts/setup.mjs`：在打印 `t.config` 之后、`options.check` 返回之前，读出 checkout 的 trio（复用 `scripts/npm/check-tag.mjs` 的 `readReleaseTrio`/`assertReleaseTrio`），不一致就非零退出并说明；把它写进三种语言的 `config` 文案（例如「本检出构建的版本」）。源码路径不读这个键来选版本、不修改它已有的值，也不从 latest Release 推导 daemon 版本；`devComposeUpArgs()` 一字不改。注意：该键一旦存在，compose 仍会用它给源码构建出的本地镜像打 tag，这正是文档要说清「它不是源码版本选择器」的原因。

**Satisfies:** 验收 5。

- [ ] **Step 1: 写失败测试** `scripts/install/public.test.mjs`，全部在 `mkdtemp` 目录里跑，用假的 `fetchText`/`fetchImpl`：
  - 空目录第一次安装：写入 `.env` 只含一行 `NEMA_IMAGE_TAG=1.2.3`（加一行注释）、写入 `docker-compose.yml` 等于抓到的资产、`daemonCommand` 里是 `@nema-project/nema@1.2.3`。
  - 已有 `.env` 含 `NEMA_IMAGE_TAG=1.2.2`：`action: 'reuse'`，`.env` 字节不变，验证的是 `1.2.2` 那一套，`notes` 提到 1.2.3。
  - 已有 `.env` 含 `NEMA_IMAGE_TAG=latest`：抛错，`.env` 字节不变。
  - 已有 `.env` 含其它键与注释：写入后除 `NEMA_IMAGE_TAG` 行外逐字节不变。
  - 资产里两个镜像版本不同：抛错，不写 `.env`。
  - 四项缺一项：抛错，不写 `.env`（「缺件必须拒绝，不能宣称已锁定」）。
  - `--check`：不写任何文件。
  - 已有 `docker-compose.yml`：不被覆盖；它的 pin 与锁定版本不同则抛错并说明。
- `scripts/setup.test.mjs` 新增：`TEXT` 三种语言都有「checkout 版本」这一项；`parseOptions` 不变；`setupSettings` 不变。
- [ ] **Step 2: 跑** `node --test scripts/install/*.test.mjs scripts/setup.test.mjs` → FAIL。
- [ ] **Step 3: 实现** 两个模块、CLI、`setup.mjs` 那一小段与三语文案。
- [ ] **Step 4: 跑** 同一条命令 → PASS；`node scripts/setup.mjs --check` 在仓库根退出 0 并打印 checkout 版本；`node scripts/setup.mjs --help` 不变。
- [ ] **Step 5: Commit** `feat(install): resolve one locked release version for public installs`

### Task 9: 文档里的安装说明（先不动链接）

**Files:**
- Modify: `README.md`、`README.en.md`、`README.zh.md`、`README.ja.md`（第 83、95–108 行区段）
- Modify: `docs/guide.en.md`、`docs/guide.zh.md`、`docs/guide.ja.md`（第 60–67、117–119、249–250 行区段）
- Modify: `site/index.html`、`site/ja/index.html`、`site/zh/index.html`（第 289–290 行区段）

**Interfaces:**
- 站点三页里写死的 `npm i -g @nema-project/nema@0.1.5` 改成 `npm i -g @nema-project/nema@<locked version>`，紧邻的一句写明「数字来自 `NEMA_IMAGE_TAG`，与这份安装用的 Release 版本相同」。
- README/guide 现有的 daemon 段（`@<hub version>` 占位）保留结构，改成说明数字来源：`.env` 里的 `NEMA_IMAGE_TAG`、等于 Release 版本、由公开安装路径写入；源码检出从这棵树构建 daemon。
- 第 95 行那段「The published installation pins … because `scripts/images/check-images.mjs` requires the pin to equal the package version」改成对模板/资产的正确描述：仓库树里的 compose 是模板、不含可用版本；受支持的 Compose 文件是该版本 Release 上的 `docker-compose.yml` 资产；安装时把版本锁进 `.env`。
- 第 97 行「For public installation, use the versioned v0.1.5 Compose file linked above…」改成不依赖某个具体版本的写法，但**保留现有的 v0.1.5 链接**（链接在任务 10 才换）。
- `docs/guide.*.md` 第 249–250 行「源码升级」段补一句：源码检出不用 `NEMA_IMAGE_TAG` 选版本。
- 英文文案以 `README.md` 为准，`README.en.md` 必须同步到逐字节相同；zh/ja 与站点三语写等价内容，不新增承诺。
- 站点三语、README 四语、guide 三语在同一次提交里改完。

**Satisfies:** 验收 4（文案面；链接面在任务 10）、验收 5（文档面）。

- [ ] **Step 1: 先 grep 现状**，把结果贴进 PR 描述：

  ```sh
  rg -n 'nema-project/nema@[0-9]' README*.md docs/guide*.md site/
  rg -n 'not a release asset|リリースの添付ファイル|发布页上的附件' README*.md docs/guide*.md site/
  ```

  基线结果：站点三页各两处 `@0.1.5`；README/guide 无写死命令，只有占位与 `@0.1.3` 历史事实；「不是发布资产」共 10 处（每文件 1 处，站点在 289 行的段落里）。
- [ ] **Step 2: 改文案** 按 Interfaces 逐文件改；zh/ja 与三语站点同步。
- [ ] **Step 3: 跑** `cmp README.md README.en.md`；`echo '["README.md","README.en.md","README.zh.md","README.ja.md","docs/guide.en.md","docs/guide.zh.md","docs/guide.ja.md","site/index.html","site/ja/index.html","site/zh/index.html"]' > /tmp/paths.json && node scripts/ci/docs-check.mjs /tmp/paths.json` → 0 errors。
- [ ] **Step 4: 自查** `rg -n 'nema-project/nema@0\.1\.5' site/ README*.md docs/guide*.md` 必须无命中；`rg -n 'not a release asset|リリースの添付ファイル|发布页上的附件' README*.md docs/guide*.md site/` 此时**仍应命中**（链接还没换，句子还成立），任务 10 再删。
- [ ] **Step 5: Commit** `docs: describe the locked release version in install instructions`

### Task 10: 切换到固定名 Compose 资产链接（前置门）

**Files:**
- Modify: 任务 9 那 10 个文件里的 compose 链接与「不是发布资产」句子

**Interfaces:**
- 替换成 `https://github.com/Nema-Project/nema-room/releases/latest/download/docker-compose.yml`：每个文件的 `blob/v0.1.5/docker-compose.yml` markdown 链接与 `curl -fsSLO https://raw.githubusercontent.com/Nema-Project/nema-room/v0.1.5/docker-compose.yml` 各一处。
- 删除「It is not a release asset.」/「リリースの添付ファイルではありません。」/「它不是发布页上的附件。」三句，改成「它是该 Release 的固定名资产」。
- 站点 `<pre>` 里的注释行 `# Hub and web, linux/amd64. The compose file is on tag v0.1.5, not a release asset.` 同步改。
- 切换后不再出现 `blob/v<版本>/docker-compose.yml`，也不再出现 `raw.githubusercontent.com/Nema-Project/nema-room/v<版本>`。

**前置门（缺一不可，未满足就不合并本任务）：**

1. 一个包含 `docker-compose.yml` 资产的版本已经**真实发布**（该资产由 desktop-release 上传，draft 转正已完成）。
2. `curl -fsSI https://github.com/Nema-Project/nema-room/releases/latest/download/docker-compose.yml` 返回 200，`curl -fsS` 下来的文件 `composeAssetVersion` 等于该 Release 的版本。
3. 该版本的 npm 包与两个 GHCR 镜像 tag 可匿名读到（`node scripts/install/public.mjs --check` 四项齐）。
4. 该 URL 在**稳定** latest 上成立（不是预发布）。

门未满足时：本任务保持未勾选，旧链接继续可用，PR 其余任务照常合并。这条门是规格第 4 条验收的实测依据，不能靠推理代替。

**Satisfies:** 验收 4。

- [ ] **Step 1: 逐条实测前置门**，把 4 条命令与输出贴进 PR。任何一条不满足就停在本任务，不改文件。
- [ ] **Step 2: 改 10 个文件**：链接、curl 命令、那三句「不是发布资产」、站点注释行。三语同步。
- [ ] **Step 3: 跑** `rg -n 'raw.githubusercontent.com/Nema-Project/nema-room/v[0-9]|blob/v[0-9][^/"]*/docker-compose.yml' README*.md docs/guide*.md site/` → **零命中**；`rg -n 'not a release asset|リリースの添付ファイル|发布页上的附件' README*.md docs/guide*.md site/` → 零命中；`cmp README.md README.en.md`；`node scripts/ci/docs-check.mjs /tmp/paths.json` → 0 errors。
- [ ] **Step 4: 再实测** 切换后的 URL：`curl -fsSL .../releases/latest/download/docker-compose.yml | head -5`，确认是固定名下载而不是跳 HTML。
- [ ] **Step 5: Commit** `docs: point the public compose entry at the fixed-name release asset`

### Task 11: 三份 RELEASE.md 与 CONTRIBUTING 的安装/发布说明

**Files:**
- Modify: `scripts/images/RELEASE.md`（第 12 行那段；Fail closed 清单）
- Modify: `scripts/npm/RELEASE.md`（第 46 行那段）
- Modify: `scripts/desktop/RELEASE.md`（第 45 行资产清单；第 53 行发布前检查）
- Modify: `CONTRIBUTING.md`（第 28、30、82、84 行）

**Interfaces:**
- `scripts/images/RELEASE.md`：删掉「`check-images.mjs` still rejects a tag whose version differs from the compose pin, so the pin is updated in the same release commit」与「The image-version assertion joins the stamp command in phase 2」。改成：仓库树的 compose 是模板（`${NEMA_IMAGE_TAG:-latest}`），没有可发布的 pin；发布资产由 `stamp-compose.mjs <x.y.z>` 渲染，并在 `image-publish.yml` 与 `desktop-release.yml` 各自的检查里校验；`check-images.mjs` 对模板跑形态断言、对资产跑版本断言。Fail closed 清单里把「tag、三包版本与 compose 镜像 tag 不一致」改成「渲染出的资产双镜像不等于本次版本」。
- `scripts/npm/RELEASE.md`：第 46 行的「Until then…」段删掉，改成「`release:stamp` 的自检现在是 `check-tag` + 模板形态 + 以新版本渲染的资产断言；它仍然不改也不生成任何 compose 文件，不 commit / tag / publish」。
- `scripts/desktop/RELEASE.md`：第 45 行资产清单加 `docker-compose.yml`（固定名，来自模板渲染，计入 `SHA256SUMS-<version>.txt`），并写明「旧版本建的 draft 若没有该资产，重跑会失败关闭，需先删除该 draft」；第 53 行发布前检查加一条「确认 draft 里 `docker-compose.yml` 的双镜像 pin 等于本次版本」；「Anonymous download and hash verification」第 2 条加该文件。
- `CONTRIBUTING.md`：第 28 行去掉「main 在 release PR 合并后、镜像发布前可能钉住尚不可用的候选版本」这类以 pin 为前提的说法，改成「main 的 compose 是模板，不是安装入口；公开安装取 Release 资产」；第 30 行保持版本化 daemon 命令的说法并补一句数字来自 `.env` 的 `NEMA_IMAGE_TAG`；第 82、84 行的「镜像版本断言留到第 2 期」「在那之前 check-images 仍要求 pin」改成已实现的描述。
- 不改这三份文件里「tag 只打在 main CI 成功的 SHA 上」「不从 CI 创建 tag」的原文。

**Satisfies:** 验收 9（第 2 期：改安装说明）。

- [ ] **Step 1: grep** `rg -n 'phase 2|第 2 期|compose pin|pin 等于包版本' scripts/*/RELEASE.md CONTRIBUTING.md`，把命中逐条处理，不许留「留到第 2 期」的承诺。
- [ ] **Step 2: 改四个文件**。
- [ ] **Step 3: 跑** `rg -n 'phase 2|第 2 期' scripts/*/RELEASE.md CONTRIBUTING.md` → 零命中；`node scripts/ci/docs-check.mjs /tmp/paths.json`（paths 换成这四个文件）→ 0 errors；三条政策原句仍在（`rg -n 'Do not create a release tag from CI|不从 CI 创建 tag' scripts/*/RELEASE.md`）。
- [ ] **Step 4: Commit** `docs(release): describe compose templates, assets, and locked versions`

### Task 12: 集成验证与发布后核对

**Files:**
- 无新文件（只跑检查、写 PR 描述与发布记录）

**Interfaces:**
- 本地按 AGENTS.md 的对应行跑，并把实际输出贴进 PR：

  ```sh
  export PATH=/tmp/node-v22.20.0-linux-x64/bin:$PATH
  node --test scripts/images/*.test.mjs
  node --test scripts/install/*.test.mjs
  node --test scripts/release/*.test.mjs
  node --test scripts/desktop/release-commit.test.mjs scripts/desktop/release.test.mjs scripts/release-notes.test.mjs
  node --test scripts/ci/*.test.mjs
  node --test scripts/setup.test.mjs scripts/release-notes.test.mjs
  npm run typecheck
  actionlint -color
  ```
- CI：该 PR 的 `CI gate` 必须绿；`scripts/images/**`、`docker-compose.yml` 的改动会拉起 image-publish 的 PR 构建（只构建冒烟，不推送）。
- 发布后核对（第一次带资产的发布完成后，人工执行并记录）：`releases/latest/download/docker-compose.yml` 200 且 pin 正确；`node scripts/install/public.mjs --check --dir <临时目录>` 四项齐；GHCR 两个 tag 匿名可读；npm 该版本存在；`sha256sum -c SHA256SUMS-<version>.txt` 含 `docker-compose.yml`。

**Satisfies:** 验收 8 的证据部分，以及验收 3/4/5 的实测收口。

- [ ] **Step 1: 本地跑完上面全部命令**，逐条记录退出码。没有 Docker 时明确写「`check-images.test.mjs` 的两个 `docker compose config` 用例未跑」。
- [ ] **Step 2: 提交 PR 后等 `CI gate`**，把 run URL 记进 PR。
- [ ] **Step 3: 合并前核对本计划「本期明确不做」** 没有一项被顺手做掉（`rg -n 'verify-release|release-promote|promote' .github/workflows scripts` 应无新增）。
- [ ] **Step 4: 合并后按任务 10 的前置门实测**，满足才开链接切换的 PR。
- [ ] **Step 5: Commit** 无（本任务只产出证据；证据写进 PR 描述与发布记录）。

---

## 验收对照

| 验收 | 任务 |
|---|---|
| 1 第 2 期部分：盖印后自检含模板形态与渲染资产检查，`git diff --stat` 仍只含四个版本文件 | 1、2、4 |
| 3 仓库根 compose 无字面 pin；形态断言对模板通过；`stamp-compose` 产物过版本断言；image-publish 三处显式 `NEMA_IMAGE_TAG` | 1、2、3、5、12 |
| 4 站点三页、README 四份、guide 三份不再有随版本变化的 compose URL；模拟发布后零改动 | 9（文案）、10（链接 + 前置门实测） |
| 5 公开安装在干净环境解析版本、验证整套产物后写 `.env` 并给同版 daemon 命令；已有键沿用验证不覆盖不混 latest；源码 setup 不受影响 | 7、8、9 |
| 8 `workflows.test.mjs` 随改动更新且全绿；新增脚本都有相邻 `*.test.mjs`；按 AGENTS.md 跑测试并报告 | 1、2、3、4、5、6、7、8、12 |
| 9 三份 RELEASE.md 与 CONTRIBUTING 的安装说明同步 | 11 |

验收 2、6、7 属于第 1 期与第 3 期，本计划不覆盖。

## 本期明确不做

实现任何一条都算超出本期的范围：

- `scripts/release/verify-release.mjs`、`.github/workflows/release-promote.yml`。第 3 期才写。
- npm 从 tag 推送改为顺序发布；`npm-publish.yml` 的任何行为改动（文件名同样不动）。
- GHCR `latest` 的移动从 image-publish 的 publish 作业移走。本期第 304–340 行原样不动。
- desktop-release 只做到 draft。本期仍由它在同一步里 `gh release edit --draft=false`。
- promote 的幂等、防倒退、候选预检、job summary。
- 回填或修改已发布 v0.1.5 的资产集（它没有 `docker-compose.yml` 资产，本期不补）。
- 把安装器脚本本身作为第二个固定名资产发布（见「与规格不一致」第 6 条）。
- linux/arm64 镜像（#50）。
- tag 自动化，以及把 manifest 版本改成由 tag 派生。
- 改 `CHANGELOG.md`、`ROADMAP.md`、关闭 #63。
- 改 `scripts/ci/policy.mjs` 的分类表、新增 npm 依赖、新建数据库迁移、改 `apps/**` 运行时代码。

`prerelease == false` 的稳定版守卫是现行代码里已经存在的行为，本期保持原样，既不算新增也不算本期成果。

## 任务顺序与提交

1 → 2 必须先（2 复用 1 的渲染与断言）；3 → 4 → 5 → 6 依次（3 的 workflow step 被 6 的契约断言盯住，5 的 `env` 被 5 自己的断言盯住，6 只加 desktop-release 的断言）；7 → 8 → 9 串行；10 必须等真实发布；11 可与 9 同批做；12 收口。每个任务一个提交，提交信息用英文，身份用维护者账号，不加任何联合作者署名。
