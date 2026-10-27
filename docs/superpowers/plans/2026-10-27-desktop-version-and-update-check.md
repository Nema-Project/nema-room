# 桌面版本号与更新检查 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 桌面应用在 macOS 应用菜单、两端托盘和侧栏显示版本（有则带短 commit），并在有更新的稳定版时用托盘项和页面横幅链到 GitHub 发行页。不自动下载。

**Architecture:** 版本比较和 `GET /repos/Nema-Project/nema-room/releases/latest` 放在本地核心。核心把结果写入桌面 home 的 `update-status.json`。Electron 只读这个文件来刷新托盘，并用 `update-check.json` 的 `checkRequestedAt` 请求手动检查。页面走已有的会话接口。

**Spec:** [桌面版本号与更新检查](../specs/2026-10-27-desktop-version-and-update-check-design.md)。

知识库里没有对应的 R 编号。任务不新编 `R-n`，完成标准是 spec 的验收标准 1–6。

## Global Constraints

- 不新增依赖，不使用 `autoUpdater` 或 `electron-updater`。
- 不改 `scripts/desktop/make.mjs` 的 Windows 目标、`scripts/desktop/release-manifest.mjs`、`scripts/desktop/RELEASE.md`。
- `/_nema/version` 和 `/_nema/update` 仍要求会话。失败不提示。
- 预发布和 draft 不提示。发行页 URL 只允许 `https://github.com/Nema-Project/nema-room/releases/tag/` 下与版本一致的稳定 tag。
- P2-01 保持待办。

## Review Focus

1. 稳定用户不能看到预发布。`prerelease: true`、`draft: true`，以及 tag 自带预发布号，都要丢掉。→ 任务 1。
2. 关闭自动检查时不能发请求。手动检查是例外。→ 任务 1、2。
3. 托盘不能打开响应里自带的任意 `html_url`。URL 由 tag 拼出，打开前再校验。→ 任务 1、3。
4. 非 darwin 仍要 `setMenu(null)`。About 加在应用菜单和托盘上，不要为了 Windows 把窗口菜单加回来。→ 任务 3。
5. Vitest 启动本地核心时不能打到 GitHub。计时器在 `VITEST` 下不启动。→ 任务 2。

## File map

- 新建：`apps/local/src/releaseCheck.ts`、`apps/local/src/appRelease.ts`、`apps/local/test/releaseCheck.test.ts`、`apps/local/test/appRelease.test.ts`
- 修改：`apps/local/src/gateway.ts`、`apps/local/src/runtime.ts`、`scripts/desktop/stage-runtime.mjs`、`scripts/desktop/staging.test.mjs`
- 修改：`apps/desktop/lifecycle.cjs`、`apps/desktop/test/lifecycle.test.mjs`
- 新建：`apps/web/components/AppRelease.tsx`、`apps/web/test/AppRelease.test.tsx`
- 修改：`apps/web/components/Sidebar.tsx`、`apps/web/app/layout.tsx`、`apps/web/app/globals.css`、`apps/web/messages/en.json`、`apps/web/messages/zh.json`、`apps/web/messages/ja.json`、`apps/web/test/Sidebar.test.tsx`
- 修改：`CHANGELOG.md`、`README.md`、`README.en.md`、`README.zh.md`、`README.ja.md`、`docs/guide.en.md`、`docs/guide.zh.md`、`docs/guide.ja.md`、`ROADMAP.md`

### 任务 1：版本比较和发行拉取

- 新建：`nema-room:apps/local/src/releaseCheck.ts`
- 新建：`nema-room:apps/local/test/releaseCheck.test.ts`
- 满足：spec 验收标准 1、2

测试先写：相等、更高、更低、预发布小于正式版、预发布标识顺序、无法解析返回空、`v` 与 `+build` 不改变顺序。假 fetch：更新的稳定版给出 `https://github.com/Nema-Project/nema-room/releases/tag/vX.Y.Z`；更旧、相等、draft、prerelease、`1.2.3-rc.1`、坏 tag 都没有 offer；网络错误和超时是 `error` 且不抛；`enabled: false` 不调用 fetch；手动检查在关闭时仍调用。请求头没有 `Authorization`。

实现：纯函数 `compareSemver`、`releaseOffer`、`fetchLatestRelease`。超时 8 秒，`redirect: "error"`，只发 GET。

验证：`npx vitest run apps/local/test/releaseCheck.test.ts`

提交信息：`feat(local): compare stable GitHub releases`

### 任务 2：本地版本接口和检查调度

- 新建：`nema-room:apps/local/src/appRelease.ts`
- 新建：`nema-room:apps/local/test/appRelease.test.ts`
- 修改：`nema-room:apps/local/src/gateway.ts`
- 修改：`nema-room:apps/local/src/runtime.ts`
- 修改：`nema-room:scripts/desktop/stage-runtime.mjs`
- 修改：`nema-room:scripts/desktop/staging.test.mjs`
- 满足：spec 验收标准 3

测试先写：有会话时 `GET /_nema/version` 返回版本和 7 位 commit；无会话 401。`POST /_nema/update/check` 在假 fetch 下返回 offer，并写入 `update-status.json`。`enabled: false` 时自动路径不调用 fetch。显式 commit 写入运行清单；坏 commit 不写。

实现：`createAppReleaseService` 读清单和 `build-metadata.json`。偏好文件 `update-check.json` 的 `enabled`。网关在设置分发之前把这四个路径交给该服务。核心启动服务；`VITEST` 下不排程。`stage-runtime` 仅当源码根就是 Git 顶层时写入 40 位 commit。

验证：`npx vitest run apps/local/test/releaseCheck.test.ts apps/local/test/appRelease.test.ts`

提交信息：`feat(local): serve desktop version and update status`

### 任务 3：About 和托盘更新项

- 修改：`nema-room:apps/desktop/lifecycle.cjs`
- 修改：`nema-room:apps/desktop/test/lifecycle.test.mjs`
- 满足：spec 验收标准 4

测试先写：darwin 应用菜单和托盘含 `About Nema Room 0.1.3 (abc1234)`；win32 托盘同样含 About，且主窗口 `setMenu(null)`。状态 URL 不是规定发行页时没有更新项。合法更新项点击 `openExternal`。`Check for Updates` 调用请求函数。

实现：菜单第一项是 About。从 `app.getVersion()` 和清单读版本与短 commit。刷新时只替换菜单，不新建托盘图标。`VITEST` 下不轮询；生产环境每 5 秒读一次状态文件。

验证：`npx vitest run apps/desktop/test/lifecycle.test.mjs`

提交信息：`feat(desktop): show version and update notice in menus`

### 任务 4：页面横幅、页脚和说明

- 新建：`nema-room:apps/web/components/AppRelease.tsx`
- 新建：`nema-room:apps/web/test/AppRelease.test.tsx`
- 修改：`nema-room:apps/web/components/Sidebar.tsx`
- 修改：`nema-room:apps/web/app/layout.tsx`
- 修改：`nema-room:apps/web/app/globals.css`
- 修改：`nema-room:apps/web/messages/en.json`
- 修改：`nema-room:apps/web/messages/zh.json`
- 修改：`nema-room:apps/web/messages/ja.json`
- 修改：`nema-room:apps/web/test/Sidebar.test.tsx`
- 修改：`nema-room:CHANGELOG.md`
- 修改：`nema-room:README.md`
- 修改：`nema-room:README.en.md`
- 修改：`nema-room:README.zh.md`
- 修改：`nema-room:README.ja.md`
- 修改：`nema-room:docs/guide.en.md`
- 修改：`nema-room:docs/guide.zh.md`
- 修改：`nema-room:docs/guide.ja.md`
- 修改：`nema-room:ROADMAP.md`
- 满足：spec 验收标准 5、6

测试先写：页脚显示版本和短 commit；有 offer 时横幅指向发行页；接口失败时没有横幅；开关发送 `PATCH /_nema/update`。侧栏原有测试不发这个请求。

实现：横幅放在标题栏下，版本和 `updateCheck.enabled` 开关放在侧栏页脚。三种语言都写文案。升级说明写明只提示、不安装。P2-01 仍为待办，并注明本检查不计入该项。

验证：`npx vitest run apps/web/test/AppRelease.test.tsx apps/web/test/Sidebar.test.tsx`

提交信息：`feat(web): show desktop version and update banner`
