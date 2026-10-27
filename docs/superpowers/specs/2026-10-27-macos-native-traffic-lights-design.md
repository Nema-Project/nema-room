# macOS 原生窗口控件

日期：2026-10-27。实现计划：[2026-10-27-macos-native-traffic-lights.md](../plans/2026-10-27-macos-native-traffic-lights.md)。

维护者反馈：桌面应用在 macOS 上把最小化、最大化、关闭画在右上角，是 Windows 风格的自绘按钮，而不是左上角的系统红绿灯。

上游是 [自定义窗口外壳](2026-10-25-custom-window-chrome-design.md)。那份设计在 2026-10-25 选定全平台自绘按钮。本 spec 只改 macOS。Windows 和 Linux 仍按那份设计。

## 意图与原因

macOS 用户拿到的是右上角自绘方块按钮，和系统红绿灯不一致，系统的关闭、最小化、缩放和全屏也不落在用户预期的位置。

桌面壳是 Electron 45。主窗口和线程窗口都走 `apps/desktop/security.cjs` 的 `createSecureWindowOptions`，固定 `frame: false`，不设 `titleBarStyle`。Electron 45 把 `has_frame()` 定义为 `frame !== false && titleBarStyle === normal`。无边框且样式仍是 `normal` 时，`native_window_mac.mm` 调用 `InternalSetWindowButtonVisibility(false)`，红绿灯被藏掉。渲染进程只要存在 `window.nemaWindowControls`，`DesktopTitlebar` 就在右侧画出三个按钮。所以 Mac 上看到的是 Windows 风格按钮。

`titleBarStyle` 为 `hidden` 或 `hiddenInset` 时，同一段代码会创建按钮代理并显示红绿灯。`hiddenInset` 未指定坐标时，Electron 45 自己的边距是 `(12, 11)`。

## 目标

- macOS 主窗口和线程窗口显示系统红绿灯，位于左上角。
- macOS 不渲染自绘的最小化、最大化/还原、关闭按钮。
- 36px 标题栏为红绿灯留出左侧安全区，标题不与红绿灯重叠。标题栏空白处仍可拖动。
- 全屏时收起这块安全区。绿色按钮进入系统全屏。
- Windows 和 Linux 仍是无边框窗口加右侧自绘按钮。
- 图表弹窗仍用系统标题栏，不套这套自定义壳。

## 非目标

- 不改 Windows 和 Linux 的自绘按钮、拖动、关闭到托盘。
- 不改图表窗口。
- 不在本环境做真机 macOS 点击验收。红绿灯位置、拖动和全屏由维护者在 Mac 上确认。
- 不改菜单栏、托盘、签名或打包目标。
- 不引入新依赖，不启用 Window Controls Overlay。

## 反目标

做到了也算失败：

1. Windows 或 Linux 带上 `titleBarStyle`，或失去 `frame: false` 和自绘按钮。
2. macOS 仍渲染自绘最小化、最大化或关闭。
3. 标题栏上的 “Nema Room” 压在红绿灯上。
4. 为了红绿灯关掉沙箱、上下文隔离，或让 preload 能 `require` 任意模块。
5. 普通浏览器出现桌面标题栏。

## 约束

- Electron 45.0.0。红绿灯代理只在无边框路径创建。macOS 必须设置非 `normal` 的 `titleBarStyle`，否则按钮保持隐藏。
- `apps/desktop/preload.cjs` 在沙箱里运行，不能 `require` 其他应用模块。平台布尔值就地写成 `process.platform === 'darwin'`，与 `usesNativeTrafficLights` 同一条件。
- `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`、`webSecurity: true` 保持不变。
- 代码和注释用英文。安全区是固定像素：标题栏高度或系统按钮尺寸变了，要同时改坐标和 CSS。

## 已定的做法

- macOS（`darwin`）的安全窗口保持 `frame: false`，并设置 `titleBarStyle: 'hiddenInset'` 与 `trafficLightPosition: { x: 12, y: 11 }`。主窗口和线程窗口都把 lifecycle 的 `platform` 传入 `createSecureWindowOptions`。Windows 和 Linux 只有 `frame: false`，不设 `titleBarStyle`，也不设 `trafficLightPosition`。[推断]
- 不把 macOS 改回 `frame: true` 且保留默认 `titleBarStyle`。那样会回到系统标题栏，和现有 36px 自定义标题栏叠成两层。`hiddenInset` 让页面铺满窗口并保留红绿灯。坐标 `(12, 11)` 与 Electron 45 源码里 `hiddenInset` 的默认边距相同，用来对准 36px 标题栏。[推断]
- preload 暴露 `nativeTrafficLights: process.platform === 'darwin'`。该值为 `true` 时不渲染三个自绘按钮，标题栏增加 `desktop-titlebar-macos`（左内边距 80px）。全屏时再增加 `desktop-titlebar-fullscreen`，左内边距回到 14px。拖动仍使用 `.desktop-titlebar` 的 `-webkit-app-region: drag`。macOS 上标题栏双击不再调用 `toggleMaximize`，避免和系统缩放各处理一次。[推断]
- 窗口状态增加 `fullScreen`。主进程监听 `enter-full-screen` 和 `leave-full-screen`。preload 仍只在 `maximized` 为布尔时转发状态，并且只有 `fullScreen === true` 才视为全屏。[推断]
- 80px 是固定安全区：按钮容器从 x=12 起，三颗灯大约 54px，再留空隙。这不是 Window Controls Overlay，不会跟着系统按钮尺寸变。已知上限写在 CSS 和 `security.cjs` 的注释里。[推断]

## 留给实现者

- 80px 与 `(12, 11)` 可以按 36px 栏高微调，只要 “Nema Room” 不压住红绿灯。测试要钉住最终采用的那一组数。
- 全屏类名用 `desktop-titlebar-fullscreen`。全屏时左内边距回到普通标题栏的 14px。

## 验收标准

1. `createSecureWindowOptions(origin, 'darwin')` 含 `frame: false`、`titleBarStyle: 'hiddenInset'`、`trafficLightPosition: { x: 12, y: 11 }`。`'win32'` 和 `'linux'` 为 `frame: false`，且没有 `titleBarStyle` 和 `trafficLightPosition`。三种平台的 webPreferences 仍关闭 Node、打开上下文隔离、沙箱和 web security。
2. `usesNativeTrafficLights` 只对 `'darwin'` 为 true。preload 源码含 `nativeTrafficLights: process.platform === 'darwin'`。
3. lifecycle 在 `platform: 'darwin'` 时创建的主窗口和线程窗口带上述选项。`platform: 'win32'` 的主窗口不带 `titleBarStyle`。
4. 渲染测试：`nativeTrafficLights: true` 时没有最小化、最大化、关闭按钮，标题栏带 macOS 安全区类，双击不调用 `toggleMaximize`。值为 false 或未设置时三个按钮都在。`fullScreen: true` 时加上全屏类。没有 bridge 时不渲染标题栏。
5. CSS 含 `.desktop-titlebar-macos` 的 80px 左内边距、全屏时的 14px，以及 `.desktop-titlebar` 的拖动区域。
6. 现有窗口控制的来源校验测试仍通过。

真机确认（本环境做不到）：红绿灯在左上角且不压标题；空白标题栏可拖动；双击缩放不来回跳；绿色按钮全屏后标题左侧不空出一块；红色按钮仍是关闭窗口并留下托盘。
