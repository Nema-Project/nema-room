# 桌面版本号与更新检查

日期：2026-10-27。实现计划：[2026-10-27-desktop-version-and-update-check.md](../plans/2026-10-27-desktop-version-and-update-check.md)。

来源：[issue #35](https://github.com/Nema-Project/nema-room/issues/35)。桌面应用的菜单和托盘只有打开、用浏览器打开、退出，用户看不到版本。代码里没有 `autoUpdater` 或 `electron-updater`，打包使用 `--publish never`。升级靠用户自己打开 GitHub Releases。

[ROADMAP](../../../ROADMAP.md) 的 P2-01 仍是签名、公证和自动更新。本设计只做版本展示和只读的发行检查。下载和安装继续手动。P2-01 保持待办。

本次读过的代码：

- `apps/desktop/lifecycle.cjs` 的 `buildMenus` 在所有平台设置应用菜单。非 darwin 的窗口调用 `window.setMenu(null)`。托盘菜单与应用菜单是同一组三项。
- `app.getVersion()` 已在生命周期里被调用的位置之外可得。`apps/desktop/package.json` 的版本是打包版本。`scripts/desktop/stage-runtime.mjs` 把同一版本写入 `runtime-manifest.json`，字段目前没有 commit。
- 本地网关 `apps/local/src/gateway.ts` 对 `/_nema/` 要求会话 cookie。设置服务 `apps/local/src/settings.ts` 处理这些路径。浏览器视图和 Electron 主进程不是同一个进程。
- 侧栏页脚在 `apps/web/components/Sidebar.tsx`。文案在 `apps/web/messages/{en,zh,ja}.json`。

## 意图与原因

用户反馈问题时说不出自己用的版本。新的稳定版发布之后，应用里也没有提示，用户会停在旧安装包上。

## 目标

- macOS 应用菜单和 macOS、Windows 的托盘菜单都有 About 项，能看到版本；运行清单或构建元数据里有 commit 时，附带 7 位短 commit。
- 已登录的本地页面从 `GET /_nema/version` 读到同一版本和短 commit，显示在侧栏页脚。没有这个接口时（Web / Compose）不显示，也不报错。
- 有更新时，托盘增加一条打开发行页的项，页面顶部出现横幅，链接到同一页。
- 启动约 15 秒后做一次检查，之后约每 24 小时一次。托盘有「Check for Updates」，页脚也有「检查更新」。
- 侧栏可以关掉自动检查。关掉之后，启动和周期检查不再访问 GitHub；手动检查仍然可以做一次。
- 失败（离线、超时、限流、非 200、重定向、无法解析）不弹窗、不横幅、不打日志。
- 稳定用户不会被提示 draft、prerelease，或 tag 本身带预发布号的版本。无法解析的 tag 被忽略。

## 非目标

- 不下载、不安装、不调用 `autoUpdater` / `electron-updater`，不改 electron-builder 的 `publish`。
- 不改 Windows 打包目标、`scripts/desktop/release-manifest.mjs`、`scripts/desktop/RELEASE.md`。
- 不把 P2-01 标成完成。
- 不在本环境做真机菜单点击验收。菜单结构由单元测试固定。
- 不给 Web / Compose 增加发行检查。那里没有桌面运行清单时，页脚保持空白。

## 反目标

做到了也算失败：

1. 引入自动下载或安装，或新增 `electron-updater` 依赖。
2. 把 draft、prerelease，或 tag 带预发布号的版本提示给用户。
3. 检查失败时弹出错误、横幅或托盘错误项。
4. 请求带上凭证、机器标识，或跟随重定向。
5. 托盘链接打开 GitHub 发行页以外的地址。
6. 未登录的页面可以读到更新状态，或 `/_nema/version` 不再要求会话。
7. 为了版本号改动 Windows 安装目标或发布清单。

## 约束

- 比较和拉取逻辑放在 `apps/local`，随本地核心进载荷。Electron 主进程不 import 这份 TypeScript；它读核心写下的 `update-status.json`，并把一次手动检查写到单独的 `update-check-request.json`（`checkRequestedAt`）。托盘不改写偏好文件。
- 发行页只接受 `https://github.com/Nema-Project/nema-room/releases/tag/` 加上与版本号一致的稳定 tag（可带 `v` 前缀）。
- 请求是未认证的 GET，`User-Agent` 为 `Nema-Room`，超时 8 秒，`redirect: "error"`。响应体按块读取，超过 1 MB 即停止并视为失败。
- 自动检查默认开启。偏好文件是桌面 home 里的 `update-check.json`，形状是 `{ "updateCheck": { "enabled": false } }`。缺文件、损坏，或没有这个嵌套对象时视为开启。只有 `updateCheck.enabled === false` 关闭自动检查。手动请求在另一个文件里，避免和偏好互相覆盖。
- 设置名是 `updateCheck.enabled`。
- 代码和注释用英文。菜单沿用现有英文标签。页面文案写入三种 `messages`。

## 已定的做法

- About 放在应用菜单和托盘菜单的第一项。标签是 `About Nema Room`，有版本时接 ` 0.1.3`，有短 commit 时再接 ` (abcdef0)`。点击用 `dialog.showMessageBox` 显示同样的文字。非 darwin 仍然 `window.setMenu(null)`，Windows 以托盘为准。[S-1]
- 版本优先用 `app.getVersion()`。没有时用运行清单的 `version`。短 commit 依次看运行清单的 `commit`、`build.commit`，以及载荷根上的 `build-metadata.json` 的同样字段。只接受 7 到 64 位十六进制，展示前 7 位。`stage-runtime` 在源码根就是该目录的 Git 仓库时，把 40 位 `HEAD` 写入清单的 `commit`；fixture 目录不是仓库时不写。不改 `make.mjs`。来源 [S-1]，做法 [推断]
- `GET /_nema/version` 返回 `{ version, commit? }`。`GET /_nema/update` 返回 `{ enabled, state, offer? }`。`PATCH /_nema/update` 的正文只能是 `{ enabled: boolean }`。`POST /_nema/update/check` 的正文是 `{}`，手动跑一次检查。这些路径仍在会话校验之后。核心在启动约 15 秒后检查，之后约每 24 小时一次；每 2 秒看一次 `update-check-request.json` 的 `checkRequestedAt`，用来接托盘的手动请求。Vitest 里不启动这些计时器。已经发出的自动检查如果在写结果前发现用户关掉了自动检查，就写成关闭，不发布 offer。来源 [S-1]，做法 [推断]
- 比较使用数值主次修订号。可选 `v` 前缀。构建元数据 `+` 不参与顺序。预发布号小于同号的正式版。任一端无法解析时比较结果为空，不提示更新。`/releases/latest` 的 `draft` 或 `prerelease` 为 true，或 tag 带预发布号、无法解析、不比当前版本新，都不产生 offer。offer 的 URL 由 tag 自己拼出，不用响应里的 `html_url`。来源 [S-1]，做法 [推断]
- 有 offer 时托盘增加 `Update available: <version>`，点击 `shell.openExternal` 打开发行页。页面在标题栏下显示横幅，侧栏页脚显示版本、自动检查开关和手动检查。检查失败或被忽略的 tag 不改变页面上的提示。手动检查发现已经是最新时，页脚可以显示一句「已是最新」。来源 [S-1]，做法 [推断]
- 自动检查关闭时不发网络请求，并清掉托盘上的旧提示。手动检查不受这个开关限制。[推断]

## 留给实现者

- 15 秒、24 小时、2 秒和托盘 5 秒刷新可以按测试稳定性微调，但启动检查必须晚于窗口出现，并且不能阻塞启动。
- 页脚开关和横幅的具体 CSS 可以贴着现有侧栏，不必新做一套视觉。

## 验收标准

1. `compareSemver` 覆盖相等、更高、更低、预发布小于正式版、预发布之间的顺序，以及无法解析时返回空。`v` 前缀和 `+` 构建元数据不改变顺序。
2. 拉取逻辑在假网络下：更新的稳定版产生 offer 和发行页 URL；更旧或相等不产生；`draft`、`prerelease`、带预发布号的 tag、无法解析的 tag 都不产生 offer；超时、抛错、非 200 得到失败状态且不抛出；`enabled: false` 时不调用 fetch；手动检查在关闭自动检查时仍然请求。请求没有 `Authorization`，并设置超时。
3. `GET /_nema/version` 在有会话时返回版本和 7 位 commit，无会话时 401。`POST /_nema/update/check` 使用假 fetch。关闭自动检查时周期路径不请求网络。
4. darwin 的应用菜单和 darwin、win32 的托盘都含 About，标签带版本和短 commit。win32 主窗口仍 `setMenu(null)`。更新状态的 URL 不是规定的发行页时，托盘不加更新项。`Check for Updates` 会写下一次手动请求。
5. 页面测试：版本和短 commit 出现在页脚；有 offer 时横幅链接到发行页；接口失败时不渲染横幅；自动检查开关调用 `PATCH`。
6. README 的升级说明和 `CHANGELOG.md` 的 `[Unreleased]` 写明：会提示新的稳定版，下载和安装仍是手动的，自动更新仍不是本项。
