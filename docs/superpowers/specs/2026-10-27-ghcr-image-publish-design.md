# 发布 hub / web 的 Docker 镜像（GHCR）

日期：2026-10-27。实现计划：[2026-10-27-ghcr-image-publish.md](../plans/2026-10-27-ghcr-image-publish.md)。

**设计所对照的 HEAD**：`ee6b203a355c4879ee93b58e4d02ae222945707f`（`main`）。对应 issue #41。#41 没有评论。架构、`NEXT_PUBLIC_HUB_URL` 能否在运行期注入、以及 `NEMA_HUB_PORT` 怎么处理，是 #41 留给 spec 的三个问题；本设计按当前代码给出决定，标 `[推断]`，实现用的就是这些决定。维护者若要改，改 spec 再改实现。

## 意图与原因

Web / Compose 现在只能从源码跑起来：根目录 `Dockerfile` 已有 `hub` 和 `web` 两个 target，`docker-compose.yml` 用 `build:` 在用户机器上现场构建。想只用容器跑 hub 和 web 的人，仍要 clone 仓库、装依赖、构建镜像。daemon 不进容器，它在宿主机上用用户自己的登录运行，这一点保持不变。把 hub 和 web 发布到 GHCR 之后，compose 直接拉取钉死版本的镜像，源码构建留给开发和 CI。

## 目标

- 打 `v*` tag 且该提交的 `verify` 通过之后，把 hub 与 web 镜像推到 GHCR，tag 为与桌面版相同的版本号，稳定版另打 `latest`。
- 仓库里的 `docker-compose.yml` 只引用这些钉死版本的镜像，没有 `build:`。不 clone 仓库、只拿这份 compose 文件，就能拉起 PostgreSQL、hub 和 web。
- 源码构建仍然可用：`npm run up` 和 `node scripts/setup.mjs` 继续在本机从 Dockerfile 构建，不依赖 GHCR 上已经有镜像。
- 发布镜像里的浏览器 hub 地址是 `http://127.0.0.1:4400`。发布用的 compose 把 hub 端口固定为 4400，使 Host 校验与这个地址一致。
- README 四种语言、三份 guide、`docs/reference.zh-CN.md` 写明不 clone 的启动方式，并写明 daemon 仍在宿主机运行。

## 非目标

- 不发布 daemon、CLI、桌面或 PostgreSQL 的镜像。postgres 服务继续使用现有的 `postgres:17`，不在这次改成 digest。
- 不把 `NEXT_PUBLIC_*` 改成运行期配置，也不改 Host 校验的规则。
- 不发布 `linux/arm64`，不在工作流里安装 QEMU。
- 不在本仓库里完成 GHCR 包的可见性切换。首次推送之后若包是 private，由维护者在包设置里改为 public；工作流不保存 PAT。
- 不由这个 PR 推送任何镜像或 tag。镜像从本工作流进入 `main` 之后的第一个 `v*` tag 起才存在。
- 不改 `verify.yml` 里现有的源码 compose 冒烟（`npm run up` 后访问 `127.0.0.1:4400` 与 `127.0.0.1:3000`）。拉取已发布镜像的冒烟放在发布工作流里，避免每个 PR 都再构建并推送一遍。

## 反目标

做到了也算失败：

1. 在 `verify` 未通过的提交上、或 tag 已经移走的提交上，镜像推送成功。
2. 构建 job 或冒烟 job 持有 `packages: write`，或仓库里出现 GHCR / registry 的长期 secret。
3. 发布 job 在持有 `packages: write` 时执行 `docker build` 或 `npm ci`。
4. 发布用的 compose 把镜像指到 `latest`，或 hub / web 的 tag 与该提交的桌面版本不一致。
5. 预发布 tag 移动了 `latest`。
6. 发布镜像把 hub 地址写成 4400 以外的值，或发布用的 compose 让宿主机端口和容器端口可以不一致。
7. `npm run up` 或 setup 向导改为只拉取 GHCR、不再从当前检出构建。
8. 为了缩小镜像改掉 hub 的生产依赖集合（包括它现在会装上的 PGlite），或把 daemon 打进 hub 镜像。

## 约束

- 代码和注释用英文；本设计与计划用中文。
- 镜像版本不是 `apps/hub` 或 `apps/web` 的 `package.json` 版本（两者现在都是 `0.0.0`）。版本取桌面发布版本：`scripts/desktop/release-version.mjs` 的 `readReleaseVersion` 与 `readPackageVersion`。tag 必须是 `v` 加严格 SemVer，且与 `apps/desktop`、`apps/local` 相等。本设计另外要求 `apps/cli` 与这两者相等。
- tag 指向的提交必须是受保护的 `main` 的祖先。发布前复核远端 tag 仍指向已验过的 SHA。复用 `scripts/desktop/release-commit.mjs`，不另写一套 tag 解析。
- actions 钉全长 commit SHA，与 `desktop-release.yml` 相同。crane 按发行包的 digest 钉死，不使用带 `packages: write` 的第三方 action 去推镜像。
- 浏览器里的 hub 地址来自 `apps/web/lib/hub.ts` 的 `process.env.NEXT_PUBLIC_HUB_URL`。该文件被客户端组件引用，Next 在 `next build` 时把 `NEXT_PUBLIC_*` 内联进包。容器启动后再设同名环境变量，改不到已经发出的页面。
- Host 校验只接受 `127.0.0.1:<NEMA_HUB_PORT>` 和 `localhost:<NEMA_HUB_PORT>`（`apps/hub/src/app.ts` 的 `hostGuard`）。浏览器连的是宿主机发布出来的端口，所以宿主机端口、容器内监听端口、`NEMA_HUB_PORT` 必须是同一个数。现有 `docker-compose.yml` 已经按这个不变量用同一个插值写了两边。
- web 镜像今天的运行阶段执行 `COPY --from=web-build /app ./`，连同 deps 阶段的整棵工作区（含 devDependencies）一起进镜像。发布镜像不能保持这个形状。
- Next standalone 的 `server.js` 读取 `HOSTNAME` 和 `PORT`。Docker 会注入容器主机名到 `HOSTNAME`，若入口不覆盖，Next 可能绑到这个主机名而不是 `0.0.0.0`。
- 本仓库工作流的默认权限保持 `contents: read`。只有发布 job 额外拥有 `packages: write`。
- Compose 的序列默认是追加。源码覆盖文件若要替换端口，必须使用 Compose 的 `!override`（Compose v2.24 起；本仓库已要求 Compose v2，实现以 v2.40 的 `config` 合并结果为准）。

## 已定的做法

- 镜像名采用 #41 里建议的名字：`ghcr.io/nema-project/nema-room-hub` 与 `ghcr.io/nema-project/nema-room-web`。稳定版打版本 tag 和 `latest`；预发布只打版本 tag。compose 文件写版本 tag，不写 `latest`。[推断]
- 自动推送只由 `v*` tag 触发，且只在该提交的 `verify.yml` 全量通过之后。`workflow_dispatch` 可以构建并做本地冒烟，到推送之前停下。tag 与 `apps/desktop`、`apps/local`、`apps/cli` 三者一致，并等于 compose 里两个镜像的 tag。hub / web 的 `0.0.0` 包版本不参与这个比较。[D-1]
- 构建与推送分成两个 job。构建 job 检出已钉住的 SHA，用 buildx 构建 `linux/amd64`，把带 BuildKit provenance（`mode=max`）和 SBOM 的 OCI layout 作为 artifact 上传，并在本机加载同一构建的镜像做冒烟。构建 job 不登录 GHCR。发布 job 只下载该 OCI layout，复核 tag 与版本，再用钉死 digest 的 crane 复制到 GHCR。发布 job 不检出之后执行安装或构建。权限只有 `contents: read` 与 `packages: write`。不用 GitHub artifact attestation，因此不授予 `id-token` 或 `attestations`。[D-2]
- 只构建 `linux/amd64`。Apple Silicon 上的 Docker Desktop 以模拟方式运行这个 amd64 镜像。arm64 本机镜像留到这条发布路径已经有一次成功的 tag 推送之后再加，不在这次引入仿真构建。[推断]
- 发布的 web 镜像在 `docker build` 时把 `NEXT_PUBLIC_HUB_URL` 设为 `http://127.0.0.1:4400`，并把它内联进客户端包。不增加运行期配置文件、占位符替换或反向代理。源码构建若改了 hub 端口，必须按该端口重新构建 web，见下一条。[推断]
- 发布用的 `docker-compose.yml` 删除 `build:`。hub 与 web 使用上面的版本 tag。hub 的 `NEMA_HUB_PORT`、容器端口、发布到 `127.0.0.1` 的宿主机端口都写成字面量 `4400`，不读取 `NEMA_HUB_PORT` 插值。web 仍发布 `127.0.0.1:3000:3000`。这样一份被单独下载的 compose 文件不能把端口改得和镜像里写死的地址不一致。用户 `.env` 里的 `NEMA_HUB_PORT` 对这份文件无效。[推断]
- 源码构建放在新的 `docker-compose.build.yml`。它为 hub 和 web 加上现有的 `build`（context 为仓库根，target 分别为 `hub` 和 `web`），用 `!override` 替换 hub 的端口为 `127.0.0.1:${NEMA_HUB_PORT:-4400}` 对同号容器端口，并把 web 的构建参数设为 `http://127.0.0.1:${NEMA_HUB_PORT:-4400}`。不再单独读取 `NEXT_PUBLIC_HUB_URL` 作为 compose 构建参数，避免 `.env` 里的 URL 和端口各改各的。`npm run up` 与 `scripts/setup.mjs` 使用这两个 compose 文件并带 `--build`。`npm run db:up` 仍只启动 postgres，不需要覆盖文件。[D-3]
- web 的 Docker 运行阶段改为 Next standalone。`NEMA_DOCKER_WEB=1` 时 `apps/web/next.config.ts` 与现有的 `NEMA_MANAGED_LOCAL_BUILD=1` 一样输出 standalone、关闭图片优化，并排除 sharp。运行镜像只复制 standalone 根、`.next/static` 和 `public`，布局与桌面载荷一致：`apps/web/server.js`。入口脚本在启动前导出 `HOSTNAME=0.0.0.0` 和 `PORT=3000`。hub 的 Dockerfile 目标保持现在的生产依赖阶段，包括 git 与 vendored archify、superpowers rules。[推断]
- 两个运行镜像的 `docker image inspect` `Size` 上限各为 800 MiB。构建 job 打印 `image size: hub` 与 `image size: web` 的 MiB 数，超过上限失败。上限是为了拒绝今天这种把整棵 deps 树拷进 web 运行镜像的结果。若 standalone 或现有 hub 生产镜像的实测体积本身超过 800 MiB，实现在同一次改动里按实测上调常数并在 PR 里写上实测值，不为此删掉 hub 依赖。[推断]
- hub 与 web 在发布用的 compose 里有 healthcheck：容器内的 `node` 请求本机的 `/api/daemon/status` 与 `/`。冒烟脚本在健康之后，从宿主机用 web 的 Origin 请求 hub 的 `/api/daemon/status`，要求 200 且 `access-control-allow-origin` 为该 Origin；再 `POST /api/workspaces` 创建一个工作区，要求响应里有 id。并在 web 容器的 standalone 产物里找到写死的 hub URL。冒烟前检查解析后的 compose 配置没有 `build` 键。构建 job 对本机 tag 使用 `--pull never`。tag 上的发布后 job 在干净的 runner 上 `docker compose pull` 再启动，不构建。[D-4]
- 发布后的拉取冒烟 job 权限是 `contents: read` 与 `packages: read`，没有 `packages: write`。`packages: read` 只为了在包尚未被维护者改成 public 时，同一仓库的 CI 仍能拉到刚推送的镜像。[推断]
- 四个 README、三份 guide、`docs/reference.zh-CN.md`、`CONTRIBUTING.md`、`.env.example` 写明：不 clone 时从对应 tag 下载 `docker-compose.yml` 再 `docker compose up -d`；daemon 不在镜像里，仍在宿主机运行，在独立 npm 包可用之前从源码安装；自定义 hub 端口只在源码构建路径生效，且 web 会按该端口重建。`CHANGELOG.md` 的 Unreleased 有对应条目。两份英文 README 字节相同。[D-5]
- `scripts/images/RELEASE.md` 写明失败关闭的条件，以及维护者的一次性步骤：首次 tag 推送之后确认两个 GHCR 包是 public，若不是则在包设置里改为 public。工作流文件名定为 `.github/workflows/image-publish.yml`。[推断]

## 留给实现者

- buildx 一次构建同时写出 OCI layout 和可供 `docker load` 的 docker archive 时，用这一次构建的两份输出：OCI 用于推送，archive 用于构建 job 的本地冒烟。若当前 buildx 不能在一次构建里写两份输出，则一次构建只写 OCI layout，再用钉死版本的 crane 或 skopeo 把该 layout 载入本地 daemon 后冒烟，仍然禁止为冒烟和推送各构建一遍。
- crane 复制 OCI layout 的子命令以所钉版本的 `--help` 为准，写进工作流。目标是「不重新构建、把已有 OCI layout 推到上述两个名字」。稳定版再复制一份到 `latest`。
- 800 MiB 上限的实测若不够，只按上一条已定做法上调常数。不在这次把 PGlite 从 hub 镜像里拆出去。
- 冒烟使用独立的 compose 项目名 `nema-image-smoke` 和临时数据目录。清理只用 `docker compose -p nema-image-smoke down -v`。不要对开发者的默认项目执行 `down -v`。

## 验收标准

- R-1：`docker-compose.yml` 中 hub 与 web 的 `image` 分别为 `ghcr.io/nema-project/nema-room-hub:<版本>` 与 `ghcr.io/nema-project/nema-room-web:<版本>`，版本等于 `apps/desktop`、`apps/local`、`apps/cli` 三者的共同版本；文件中这两个服务没有 `build`；hub 端口三处都是字面量 4400；web 端口是 `127.0.0.1:3000:3000`；两个服务有 healthcheck；postgres 仍是 `postgres:17`。
- R-2：`docker-compose.build.yml` 与发布文件合并后，hub / web 带有 `build`，hub 端口只有一对且随 `NEMA_HUB_PORT` 改变，web 的构建参数为 `http://127.0.0.1:<该端口>`。`npm run up` 与 setup 向导使用这两个文件和 `--build`。只启动 postgres 的命令不需要覆盖文件。
- R-3：`NEMA_DOCKER_WEB=1` 时 Next 输出 standalone。web 运行阶段不复制整个 `/app`。入口脚本把监听地址固定为 `0.0.0.0:3000`。发布构建传入的 `NEXT_PUBLIC_HUB_URL` 是 `http://127.0.0.1:4400`。镜像内客户端产物包含这个 URL。
- R-4：`.github/workflows/image-publish.yml` 只在 `v*` tag 上推送。推送 job 依赖该 SHA 的 `verify` 成功，并在推送前复核 tag 仍指向该 SHA、且该 SHA 是 `origin/main` 的祖先。推送 job 的权限是 `contents: read` 与 `packages: write`，步骤里没有 `docker build` 和 `npm ci`。构建 job 没有 `packages` 权限。整个文件没有 registry 长期 token，没有 `id-token`。`workflow_dispatch` 不推送。预发布不打 `latest`。平台是 `linux/amd64`。provenance 为 `mode=max` 且开启 SBOM。
- R-5：冒烟在健康检查通过之后，用 web Origin 得到 hub `/api/daemon/status` 的 200 与匹配的 CORS 头，并成功创建一个工作区。构建 job 对本地镜像使用 `--pull never`。tag 的发布后 job 只拉取、不构建。冒烟拒绝带 `build` 键的 compose 配置。
- R-6：构建打印两个镜像的体积；任一超过 800 MiB（或按已定做法上调后的常数）则构建失败。
- R-7：四份 README、三份 guide、`docs/reference.zh-CN.md`、`CONTRIBUTING.md`、`.env.example`、`CHANGELOG.md` 符合已定做法里的文档条目。`README.md` 与 `README.en.md` 字节相同。文档检查通过。
- R-8：`scripts/images/RELEASE.md` 与工作流文件名一致，并写明可见性的一次性步骤与失败关闭条件。
