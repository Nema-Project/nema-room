# macOS 原生窗口控件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** macOS 桌面窗口使用左上角系统红绿灯，并藏起自绘的最小化、最大化、关闭。Windows 和 Linux 保持右侧自绘按钮。

**Architecture:** 平台判断留在 `createSecureWindowOptions(origin, platform)`。`darwin` 在现有 `frame: false` 上增加 `titleBarStyle: 'hiddenInset'` 和 `trafficLightPosition: { x: 12, y: 11 }`。preload 用同一条件暴露 `nativeTrafficLights`。渲染进程据此不画三个按钮，并用 CSS 留出 80px 安全区；全屏时收起。

**Spec:** [macOS 原生窗口控件](../specs/2026-10-27-macos-native-traffic-lights-design.md)。

知识库里没有对应的 R 编号。任务不新编 `R-n`，完成标准是 spec 的验收标准 1–6。

## Global Constraints

- 不新增依赖。不改图表窗口、托盘、菜单栏、沙箱和 webPreferences。
- preload 不 `require` 其他应用文件。
- Windows 和 Linux 的选项对象不出现 `titleBarStyle` 或 `trafficLightPosition`。
- 真机 macOS 点击不在本计划的自动化范围内。

## Review Focus

1. 只在 `darwin` 上设置 `titleBarStyle`。设到 Windows 会改变无边框窗口的系统标题栏处理。→ 任务 1。
2. `frame: false` 必须保留。Electron 45 在无边框且 `titleBarStyle` 仍为 normal 时隐藏红绿灯；去掉 `frame: false` 又会回到系统标题栏。→ 任务 1。
3. lifecycle 的两个 `BrowserWindow` 调用都要传入 `platform`，否则测试里的平台覆盖不会生效。→ 任务 1。
4. 沙箱 preload 不能为了共享函数去 `require('./security.cjs')`。布尔表达式必须与 `usesNativeTrafficLights` 一致。→ 任务 2。
5. macOS 标题栏双击不要再调用 `toggleMaximize`，否则会和系统缩放各处理一次。→ 任务 2。

## File map

- 修改：`apps/desktop/security.cjs`、`apps/desktop/lifecycle.cjs`、`apps/desktop/preload.cjs`、`apps/desktop/window-controls.cjs`
- 修改：`apps/desktop/test/security.test.mjs`、`apps/desktop/test/lifecycle.test.mjs`、`apps/desktop/test/window-controls.test.mjs`
- 修改：`apps/web/components/DesktopTitlebar.tsx`、`apps/web/app/globals.css`
- 新建：`apps/web/test/DesktopTitlebar.test.tsx`
- 修改：`CHANGELOG.md`

### 任务 1：按平台设置窗口选项

- 修改：`apps/desktop/security.cjs`
- 修改：`apps/desktop/lifecycle.cjs`
- 修改：`apps/desktop/test/security.test.mjs`
- 修改：`apps/desktop/test/lifecycle.test.mjs`
- 满足：spec 验收标准 1、2、3

测试先写：`usesNativeTrafficLights` 仅 `'darwin'` 为 true；darwin 选项含 `hiddenInset` 与 `{ x: 12, y: 11 }`；win32 和 linux 只有 `frame: false`。lifecycle 在 `platform: 'darwin'` 时主窗口和线程窗口带同样的选项，win32 主窗口没有 `titleBarStyle`。

实现：`createSecureWindowOptions(runtimeOrigin, platform = process.platform)` 展开平台选项。两处 `new BrowserWindow` 传入 lifecycle 的 `platform`。

验证：`npx vitest run apps/desktop/test/security.test.mjs apps/desktop/test/lifecycle.test.mjs`

提交信息：`fix(desktop): choose native traffic lights on macOS`

### 任务 2：藏起 macOS 自绘按钮并留出安全区

- 修改：`apps/desktop/preload.cjs`
- 修改：`apps/desktop/window-controls.cjs`
- 修改：`apps/desktop/test/window-controls.test.mjs`
- 修改：`apps/web/components/DesktopTitlebar.tsx`
- 修改：`apps/web/app/globals.css`
- 新建：`apps/web/test/DesktopTitlebar.test.tsx`
- 修改：`CHANGELOG.md`
- 满足：spec 验收标准 4、5、6

测试先写：`nativeTrafficLights: true` 时不渲染三个按钮，标题栏有 `desktop-titlebar-macos`，双击不调用 `toggleMaximize`；false 和缺省时按钮都在；`fullScreen: true` 时有 `desktop-titlebar-fullscreen`；没有 bridge 时返回 null。CSS 含 80px、全屏 14px 和拖动区域。窗口状态发布 `fullScreen`，并在清理时移除全屏监听。

实现：preload 暴露布尔值，并转发 `fullScreen`。主进程监听进入和离开全屏。标题栏按布尔值分支。`[Unreleased]` 的 Fixed 记下这条用户可见变化。

验证：`npx vitest run apps/desktop/test/window-controls.test.mjs apps/web/test/DesktopTitlebar.test.tsx apps/desktop/test/security.test.mjs`

提交信息：`fix(desktop): hide custom window buttons on macOS`
