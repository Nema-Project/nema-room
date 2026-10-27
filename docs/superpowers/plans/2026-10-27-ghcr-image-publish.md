# 发布 hub / web 的 Docker 镜像（GHCR）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打 `v*` tag 且同一提交通过 `verify` 之后，把 hub 与 web 的 `linux/amd64` 镜像推到 GHCR；`docker-compose.yml` 改为拉取钉死版本；源码构建仍走 `npm run up`。

**Architecture:** 发布用的 compose 文件只有 `image:`，端口字面量固定为 hub 4400、web 3000。源码构建用 `docker-compose.build.yml` 以 `!override` 替换 hub 端口，并把 web 的构建参数设为 `http://127.0.0.1:<NEMA_HUB_PORT>`。web 运行镜像改为 Next standalone。工作流把构建（无 `packages: write`）和推送（只有 `packages: write` 加 `contents: read`）分开；推送的是构建 job 的 OCI layout，不在发布 job 里重新构建。

**Tech Stack:** Dockerfile，Docker Compose v2，buildx，钉死 digest 的 crane，Node `.mjs` 加 `node --test`，GitHub Actions。版本校验复用 `scripts/desktop/release-version.mjs` 与 `scripts/desktop/release-commit.mjs`。

**Spec:** `docs/superpowers/specs/2026-10-27-ghcr-image-publish-design.md`

**Base:** `ee6b203a355c4879ee93b58e4d02ae222945707f`。不改 Host 校验，不把 `NEXT_PUBLIC_*` 改成运行期配置，不发布 arm64，不推送镜像。

## Global Constraints

- 发布 job 不执行 `docker build`、`docker buildx build` 或 `npm ci`。crane 只复制已有的 OCI layout。
- 除发布 job 外，没有任何 job 拥有 `packages: write`。全文件不出现 `id-token`，不出现 `secrets.GITHUB_TOKEN` 以外的 secret。
- 发布镜像的浏览器 hub 地址是 `http://127.0.0.1:4400`。发布 compose 的 hub 端口三处都是字面量 4400。
- 镜像版本等于 `apps/desktop`、`apps/local`、`apps/cli` 的共同版本，不使用 hub / web 的 `0.0.0`。
- 冒烟的 `docker compose down -v` 必须带项目名 `nema-image-smoke`。
- 代码和注释用英文。两份英文 README 字节相同。

## Review Focus

1. 发布 job 是否只推送构建产物，且权限只有 `packages: write` 与 `contents: read`。→ 任务 4。
2. 发布 compose 的端口是否不再随 `NEMA_HUB_PORT` 插值，源码覆盖是否仍能改端口并重建 web。→ 任务 2。
3. web 运行镜像是否不再拷贝整棵 `/app`，入口是否把 `HOSTNAME` 覆盖为 `0.0.0.0`。→ 任务 1、任务 5。
4. tag、三方版本、compose 镜像 tag 是否必须一致，预发布是否不会移动 `latest`。→ 任务 2、任务 4。
5. 冒烟是否在没有 `build` 键的配置上证明 hub 接受 web 的 Origin，并成功创建工作区。→ 任务 3、任务 5。

---

### 任务 1：web 运行镜像改为 standalone
- 修改：nema-room:apps/web/next.config.ts
- 修改：nema-room:Dockerfile
- 新建：nema-room:scripts/images/web-entrypoint.sh
- 新建：nema-room:scripts/images/web-image.test.mjs
- 满足：R-3

- [ ] **Step 1:** 写 `scripts/images/web-image.test.mjs`。断言：`Dockerfile` 在 `npm run build -w apps/web` 之前设置 `NEMA_DOCKER_WEB=1`；`NEXT_PUBLIC_HUB_URL` 的默认 ARG 是 `http://127.0.0.1:4400`；名为 `web` 的运行阶段不包含 `COPY --from=web-build /app ./`，且复制 `apps/web/.next/standalone`、`apps/web/.next/static`、`apps/web/public`；`scripts/images/web-entrypoint.sh` 导出 `HOSTNAME=0.0.0.0`，并把 `PORT` 默认设为 3000，最后 `exec node apps/web/server.js`；Dockerfile 以该脚本为入口。`apps/web/next.config.ts` 在 `NEMA_DOCKER_WEB === "1"` 时与 `NEMA_MANAGED_LOCAL_BUILD` 一样启用 `output: "standalone"`。hub 运行阶段仍复制 `vendor/archify` 与 `vendor/superpowers-rules`，CMD 仍是 `node apps/hub/dist/src/main.js`。
- [ ] **Step 2:** 跑 `node --test scripts/images/web-image.test.mjs` → FAIL。
- [ ] **Step 3:** 改 `next.config.ts`：`NEMA_MANAGED_LOCAL_BUILD=1` 或 `NEMA_DOCKER_WEB=1` 时跳过读取仓库 `.env`，并设置 standalone、`images.unoptimized`、sharp 的 `outputFileTracingExcludes`。两种标志都不设置时行为与现在一致。改 Dockerfile 的 `web-build` 与 `web` 阶段：构建期 `ENV NEMA_DOCKER_WEB=1`，运行阶段只复制 standalone 根、static 和 public，WORKDIR `/app`。入口脚本按测试的契约写，模式 `0755`。两个运行阶段加上 `org.opencontainers.image.source=https://github.com/Nema-Project/nema-room` 与由 ARG `IMAGE_VERSION`（默认 `dev`）填入的 `org.opencontainers.image.version`。
- [ ] **Step 4:** 跑 `node --test scripts/images/web-image.test.mjs` → PASS。
- [ ] **Step 5:** 提交信息：`build(docker): ship the web image as Next standalone`

### 任务 2：发布 compose、源码覆盖与版本一致
- 修改：nema-room:docker-compose.yml
- 新建：nema-room:docker-compose.build.yml
- 新建：nema-room:scripts/compose-dev.mjs
- 修改：nema-room:scripts/up.mjs
- 修改：nema-room:scripts/setup.mjs
- 新建：nema-room:scripts/images/check-images.mjs
- 新建：nema-room:scripts/images/check-images.test.mjs
- 修改：nema-room:.github/workflows/verify.yml
- 满足：R-1、R-2、R-6

- [ ] **Step 1:** 写 `check-images.test.mjs`。`check-images.mjs` 只依赖 Node 内建模块。测试断言：`assertComposeImages` 接受 hub / web 镜像 tag 与传入版本相同的 compose 文本，拒绝 `latest`、拒绝缺镜像、拒绝 hub 或 web 上出现 `build:`、拒绝 hub 端口不是字面量 `127.0.0.1:4400:4400`。`assertPackageVersions` 在 desktop、local、cli 三者相同且等于 tag 去掉 `v` 时通过，任一不同则以非零失败并打印三个版本。`assertImageBudget` 在 `Size` 小于等于 800 MiB 时通过，超过时失败并带上镜像名和 MiB。对仓库里的真实 `docker-compose.yml` 跑 `assertComposeImages`，版本取 `apps/desktop/package.json`。再跑 `docker compose -f docker-compose.yml config` 断言没有 `build`，以及 `NEMA_HUB_PORT=5500 docker compose -f docker-compose.yml -f docker-compose.build.yml config` 断言 hub 只发布 `5500:5500`、web 构建参数是 `http://127.0.0.1:5500`、两个服务都有 `build`。`devComposeUpArgs()` 等于 `["compose","-f","docker-compose.yml","-f","docker-compose.build.yml","up","-d","--build"]`，且 `up.mjs` 与 `setup.mjs` 使用它。
- [ ] **Step 2:** 跑 `node --test scripts/images/check-images.test.mjs` → FAIL。
- [ ] **Step 3:** 重写 `docker-compose.yml` 的 hub / web：`image` 钉到当前桌面版本（现在是 `0.1.3`），删除 `build`。hub 的 `NEMA_HUB_PORT` 与端口映射写死 4400。保留 postgres、数据卷、`user`、`NEMA_DATABASE_URL`、`NEMA_WEB_ORIGIN` 与 `NEMA_HUB_CLEAN_DAEMON_DIRS`。为 hub 与 web 加上任务描述里的 node healthcheck，web `depends_on` hub 的 `service_healthy`。新建 `docker-compose.build.yml`，用 `!override` 替换 hub 端口，web 的 build arg `NEXT_PUBLIC_HUB_URL` 为 `http://127.0.0.1:${NEMA_HUB_PORT:-4400}`。`scripts/compose-dev.mjs` 导出 `devComposeUpArgs`。`up.mjs` 与 `setup.mjs` 改为使用它。把 `node --test scripts/images/*.test.mjs` 加进 `verify.yml` 里 ubuntu test job 已有的那条 `node --test scripts/ci/*.test.mjs ...` 命令。
- [ ] **Step 4:** 跑 `node --test scripts/images/check-images.test.mjs scripts/images/web-image.test.mjs scripts/setup.test.mjs` → PASS。在临时项目名下确认 `docker compose -f docker-compose.yml -f docker-compose.build.yml up` 创建的容器能被不带第二份文件的 `docker compose down` 停掉；若不能，把 `package.json` 的 `down` 与 `verify.yml` 的 `docker compose down` 改成带上同样的两个 `-f`，并更新 `scripts/ci/workflows.test.mjs` 里对应的命令字符串。
- [ ] **Step 5:** 提交信息：`build(docker): pin compose images and keep source builds`

### 任务 3：不构建的 compose 冒烟
- 新建：nema-room:scripts/images/smoke-compose.mjs
- 新建：nema-room:scripts/images/smoke-compose.test.mjs
- 满足：R-5

- [ ] **Step 1:** 写测试。导出的 `assertNoBuild(config)` 在任一服务有 `build` 时抛错。`assessHubProbe({status, cors, origin})` 要求 status 200 且 cors 等于 origin。`assessWorkspace({ok, id})` 要求 `ok` 且 `id` 非空。`assessBundle(found, hubUrl)` 在产物里找不到该 URL 时抛错。参数解析接受 `--pull never` 与 `--pull always`，其它值失败。默认项目名是 `nema-image-smoke`。脚本正文包含 `docker compose` 与 `-p`，且 `down -v` 只和该项目名一起出现。
- [ ] **Step 2:** 跑 `node --test scripts/images/smoke-compose.test.mjs` → FAIL。
- [ ] **Step 3:** 实现 `smoke-compose.mjs`。它用 `docker compose config --format json` 做 `assertNoBuild`，再用 `up -d --wait --pull <policy>` 启动。健康之后请求 `${hubUrl}/api/daemon/status`，带 `Origin` 为 web 的 origin；再 `POST /api/workspaces`，JSON 是 `{ "name": "image-smoke" }`，同样的 Origin。用容器里的 `node` 在 `/app/apps/web/.next` 中查找 hub URL。数据目录用临时目录，`NEMA_UID` / `NEMA_GID` 用当前用户。postgres 的宿主机端口改到 `127.0.0.1:55432:5432`，避免碰开发用的 5433。结束时对项目名执行 `down -v`，`--keep` 时跳过。不要读取或删除 `~/.nema`。
- [ ] **Step 4:** 跑 `node --test scripts/images/*.test.mjs` → PASS。
- [ ] **Step 5:** 提交信息：`test(docker): smoke compose from pinned images`

### 任务 4：发布工作流
- 新建：nema-room:.github/workflows/image-publish.yml
- 修改：nema-room:scripts/ci/workflows.test.mjs
- 满足：R-4、R-5、R-6

- [ ] **Step 1:** 在 `workflows.test.mjs` 增加断言。`image-publish.yml` 的触发只有 `push` tags `v*` 与 `workflow_dispatch`。`verify` job `uses` `./.github/workflows/verify.yml`，`checkout_ref` 是 plan 的 commit。`build` 依赖 plan 与 verify，条件与 `desktop-release.yml` 的 build 相同：verify 成功，或本次不要求 verify 且 verify 被跳过。`build` 没有 `packages` 权限。`publish` 依赖 plan、verify、build；仅当事件是 `push`、`release` 为 true、三者都成功时运行。`publish.permissions` 只有 `contents: read` 与 `packages: write`。`publish` 的步骤文本不包含 `docker build`、`docker buildx build`、`npm ci`。`workflow_dispatch` 下 publish 条件为 false。`smoke`（发布后的拉取冒烟）依赖 publish，权限是 `contents: read` 与 `packages: read`，步骤包含 `docker compose pull` 与 `scripts/images/smoke-compose.mjs`，不包含 `docker build`。构建步骤包含 `linux/amd64`、`provenance` 的 `mode=max`、`sbom`、`--pull never`。全文件不包含 `id-token`，`secrets.` 只出现在 `secrets.GITHUB_TOKEN`。预发布不推 `latest`：推送 `latest` 的步骤有 `prerelease` 为 false 的条件。actions 都是全长 SHA。`verify.yml` 的测试命令包含 `scripts/images/*.test.mjs`。
- [ ] **Step 2:** 跑 `node --test scripts/ci/workflows.test.mjs` → FAIL。
- [ ] **Step 3:** 写 `image-publish.yml`。plan job 复用桌面发布里「tag 移动则失败、SHA 必须是 `origin/main` 的祖先」的做法，调用 `scripts/desktop/release-commit.mjs` 与 `scripts/desktop/release-version.mjs`，并运行 `scripts/images/check-images.mjs`。build job 用 buildx 构建两个 target，平台 `linux/amd64`，provenance `mode=max`，SBOM 打开，tag 为 `ghcr.io/nema-project/nema-room-hub:<version>` 与 web 的对应名字，构建参数 `NEXT_PUBLIC_HUB_URL=http://127.0.0.1:4400` 与 `IMAGE_VERSION`。一次构建写出 OCI layout；同一构建的本地镜像用 `--pull never` 交给冒烟脚本。打印体积并调用 `assertImageBudget`。artifact 上传 OCI layout。publish job 下载后用钉死 sha256 的 crane 复制 layout，稳定版再复制 `latest`。推送前再次 `--verify-remote`。`workflow_dispatch` 的 `verify_full` 默认 false，与桌面工作流一样只在为 true 或 tag 推送时跑 verify。SHA 从各 action 的当前 tag 解析，注释里写上 tag 名。crane 的版本与 sha256 写在工作流里，校验方式与 `verify.yml` 里的 actionlint 相同。
- [ ] **Step 4:** 跑 `node --test scripts/ci/workflows.test.mjs scripts/images/*.test.mjs` → PASS。安装与 `verify.yml` 相同版本的 actionlint 并跑过，新工作流无报错。
- [ ] **Step 5:** 提交信息：`ci: publish hub and web images from release tags`

### 任务 5：文档、手册，以及本机构建冒烟
- 修改：nema-room:README.md
- 修改：nema-room:README.en.md
- 修改：nema-room:README.zh.md
- 修改：nema-room:README.ja.md
- 修改：nema-room:docs/guide.en.md
- 修改：nema-room:docs/guide.zh.md
- 修改：nema-room:docs/guide.ja.md
- 修改：nema-room:docs/reference.zh-CN.md
- 修改：nema-room:CONTRIBUTING.md
- 修改：nema-room:.env.example
- 修改：nema-room:CHANGELOG.md
- 新建：nema-room:scripts/images/RELEASE.md
- 满足：R-7、R-8

- [ ] **Step 1:** 四份 README 的 Web / Compose 小节在 clone 步骤之前加上不 clone 的启动：从与镜像版本相同的 tag 下载 `docker-compose.yml`（当前版本写仓库里 compose 正在钉住的那个版本），`mkdir -p "$HOME/.nema/data"`，`docker compose up -d`。写明镜像从本工作流进入 main 之后的第一个 `v*` tag 起才存在。daemon 不在镜像里，仍在宿主机运行；独立 npm 包可用之前，daemon 仍按现有源码步骤安装。源码路径改为 `npm run up`（它会 `--build`），不再让读者对发布文件执行 `docker compose up --build`。三份 guide 的手动安装与端口说明做同样的区分：改 `NEMA_HUB_PORT` 只在源码构建时生效，web 会按 `http://127.0.0.1:<端口>` 重建；发布镜像忽略该变量。`docs/reference.zh-CN.md` 的 Host 校验段补上这句。`CONTRIBUTING.md` 的开发环境注明 `npm run up` 从源码构建，单独的 `docker compose up` 拉取钉死镜像。`.env.example` 用注释说明 `NEXT_PUBLIC_HUB_URL` 不再作为 compose 构建参数，发布镜像写死 `http://127.0.0.1:4400`。`CHANGELOG.md` 的 Unreleased 增加一条 Added。
- [ ] **Step 2:** 写 `scripts/images/RELEASE.md`：工作流文件名 `image-publish.yml`；失败关闭（verify 失败、tag 移动、tag 不在 main、版本与 compose 不一致、超过体积上限、crane 推送失败、冒烟失败）；预发布不更新 `latest`；首次推送后维护者确认两个 GHCR 包为 public，若创建时是 private，在包设置里改公开，不把 PAT 放进仓库。手册中的镜像名、compose 文件名和脚本名与仓库里的文件一致。
- [ ] **Step 3:** `cmp README.md README.en.md` 无差异。对改过的 Markdown 跑 `node scripts/ci/docs-check.mjs`，路径列表包含这些文件与本 spec、本 plan，结果 0 errors。
- [ ] **Step 4:** 在本机构建两个镜像并打上 compose 里的 tag，构建参数 `NEXT_PUBLIC_HUB_URL=http://127.0.0.1:4400`。若 4400 或 3000 已被占用，改用空闲端口并按该 hub 端口重建 web，冒烟脚本传对应的 `--hub-port` 与 `--web-port`。运行 `node scripts/images/smoke-compose.mjs --pull never`。通过标准：healthcheck 就绪、daemon status 的 CORS 与 Origin 一致、工作区创建返回 id、容器产物里有 hub URL。记录命令、退出码和体积行。不要 `docker push`，不要打 git tag，不要对默认 compose 项目执行 `down -v`。
- [ ] **Step 5:** 提交信息：`docs: describe pulling pinned hub and web images`

---

## 实现后的自检

- `node --test scripts/images/*.test.mjs scripts/ci/workflows.test.mjs scripts/setup.test.mjs`
- actionlint，版本与 `verify.yml` 里的 `ACTIONLINT_VERSION` 相同
- 任务 5 Step 4 的本机冒烟
- 不把「CI 将在 tag 上拉取 GHCR」写成已经发生过的事。本 PR 没有推送镜像。
