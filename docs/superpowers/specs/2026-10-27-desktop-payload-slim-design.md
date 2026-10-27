# 桌面安装包瘦身

日期：2026-10-27。实现计划：[2026-10-27-desktop-payload-slim.md](../plans/2026-10-27-desktop-payload-slim.md)。

**设计所对照的 HEAD**：`5ff8cf96c8071fd9da2423303d7a6108150e9c9e`（`main`，Merge pull request #29）。#29 已改过 `apps/web/components/DesktopTitlebar.tsx`、`apps/web/app/globals.css`、`apps/web/test/DesktopTitlebar.test.tsx`。本设计不改这三个文件。

用户在 v0.1.2 的 `Nema-0.1.2-darwin-arm64.dmg` 上量过：下载约 261 MB，解包后的 `Nema.app` 约 764 MiB。分段（用户安装包，单位 MiB）：Electron Framework 250；Graphify 的 Python 217，其中 tree-sitter 72（verilog 约 18，julia / fortran / objc / c_sharp 各约 6–7）、numpy 48；Node 189，其中 `include/` 59、npm 与 Corepack 约 12；web 37，其中 sharp / `@img` 18。这些是安装包实测，不是本 spec 实现之后的 CI 产物。

上游 darwin `install_only` 归档（`cpython-3.11.17+20261021`）里，`python/bin/python3.11` 是普通文件 17835304 字节，`python/bin/python` 与 `python/bin/python3` 是指向它的符号链接；`materializeSymlinks` 会把符号链接复制成第二、第三份相同字节。`python/lib/libpython3.11.dylib` 是 17835184 字节。这份归档字节是上游包实测。装进 `.app` 之后的节省要等 darwin-arm64 CI 产物，在那之前标成估算。

本次读过的代码，都在上面的 SHA 上：

- `scripts/desktop/fetch-tools.mjs` 把完整 Node 家目录拷进工具缓存，含 `include/`、npm、Corepack。`tools-source.json` 记录 `npmVersion` 和 `corepackVersion`。
- `scripts/desktop/stage-runtime.mjs` 的 `makeBuildSnapshot` 用这份缓存里的 npm 做 `npm ci`。随后 `copyTree` 把整个工具目录拷进 `payload/runtime/<target>`。载荷拒绝符号链接。
- CLI 启动器只执行随包的 `node` 和 CLI 入口。运行时不 spawn `npm` 或 `corepack`。
- `scripts/desktop/fetch-graphify.mjs` 的 POSIX 启动器执行 `python/bin/python3`。Windows 启动器执行 `python\python.exe`。`prunePythonRuntime` 去掉 Tcl/Tk 和安装器，不去掉 `libpython3.11.dylib`，也不去 Windows 的 `python311.dll`。
- `scripts/desktop/graphify-lock.json` 每个目标 31 个 wheel。安装器只解压锁里的 wheel，不跑 pip 解析。
- graphifyy 0.9.95 的 `extractors/engine.py` 在语法包 `ImportError` 时返回 `error` 含 `not installed`。`extract.py` 把这类文件记成警告（`#1745`），`extract --code-only` 仍写 `graphify-out/graph.json` 并以 0 退出。整次提取抛出未捕获异常时才以非 0 退出。
- `apps/web/next.config.ts` 只在 `NEMA_MANAGED_LOCAL_BUILD=1` 时设置 `output: "standalone"`。`DesktopTitlebar.tsx` 的 `Image` 已经带 `unoptimized`。本设计不改该组件。
- 源材料策略要求载荷里有一份 `runtime/licenses/electron/LICENSES.chromium.html`，正文含 `ffmpeg` 和 `LGPL v2.1`。Electron Framework 里还有另一份。

## 意图

安装包里有运行时用不到的头文件、包管理器、重复解释器、冷门语法和图片原生库。把这些从发布载荷拿掉，桌面下载和安装占用会下降。构建缓存仍要能 `npm ci`。许可证该留的留下。缺一个语法包时，索引要跳过该文件，不能把整个提取打崩。

## 目标

- darwin-arm64 与 win32-x64 的载荷不再包含 Node 的 `include/`、npm、Corepack 及其命令垫片。工具缓存里这些仍然在。`tools-source.json` 仍记录 npm 与 Corepack 的版本。
- POSIX 载荷只留 `python/bin/python3.11` 这一份解释器字节。启动器执行它。Windows 仍执行 `python\python.exe`。
- macOS 上，安装完 wheel 并剪过 Tcl/Tk 之后，若没有任何 Mach-O 的加载命令点名 `libpython3.11`，则删除 `lib/libpython3.11.dylib`。解析不了或有引用则保留。Windows 的 `python311.dll` / `python3.dll` 不动。
- 打包后的应用只留载荷里那一份 `LICENSES.chromium.html`。源映射（`*.js.map` 等）不进载荷。
- 锁文件只保留下面「留下的语法」。缺语法时 `extract --code-only` 退出码为 0，并留下警告。
- 托管的 Next 构建设置 `images.unoptimized`，并从载荷删掉 `node_modules/sharp` 与 `node_modules/@img`。开发与 Compose 构建不关图片优化。
- 打包和 CI 打印分段大小。超过预算只写警告，退出码仍是 0。已有冒烟仍覆盖应用启动、CLI 启动器、一次 Graphify、网页渲染。

## 非目标

- 不改 `DesktopTitlebar.tsx`、`globals.css`、`DesktopTitlebar.test.tsx`。不改 #29 的分支（该分支已合入上面的 HEAD）。
- 不删 numpy。不删 Windows Python DLL。不把 `python` / `python3` 换成符号链接。
- 不改 `tools-manifest.json` 里的 Node 版本，不改 Graphify 的 Python 版本或 graphifyy 版本。
- 不把体积预算做成构建失败。不在 README 里写一个会过期的安装包字节数。
- 不改界面文案。不改 `ROADMAP.md`。

## 反目标

做到了也算失败：

1. 工具缓存里没有 npm 或 `include/`，导致 `desktop:stage` 的 `npm ci` 不能跑。
2. 载荷里出现符号链接，或 POSIX 启动器仍执行已删除的 `python/bin/python3`。
3. 有 Mach-O 引用 `libpython3.11` 时仍删掉该库，或 Windows 上删了 `python311.dll`。
4. 应用包里一份 Chromium 声明都不剩，或载荷路径上的那份被删。
5. 缺 verilog 语法时 `extract` 非 0 退出，或留下的 JavaScript 语法抽不出符号。
6. 为了去掉 sharp 去改标题栏组件的结构。

## 约束

- 代码和注释用英文。体积警告的前缀是 `payload size warning:`。
- 载荷继续拒绝符号链接。相同字节的解释器副本用删除，不用链接。
- Node 声明仍是 notice-only。`source-materials.mjs` 里 `node-source` 的 files-coverage 必填键只留 `node-runtime`。策略理由不再声称载荷带了 npm 和 Corepack。
- Mach-O 扫描在 wheel 安装和 `prunePythonRuntime` 之后做。只认 `LC_LOAD_DYLIB`（`0xC`）、`LC_LOAD_WEAK_DYLIB`（`0x80000018`）、`LC_REEXPORT_DYLIB`（`0x8000001F`）、`LC_LOAD_UPWARD_DYLIB`（`0x80000023`）。`LC_ID_DYLIB` 不算引用。FAT（`0xCAFEBABE`）要读每个切片。解析失败则保留 dylib。
- `images.unoptimized` 和 `outputFileTracingExcludes` 只加在 `NEMA_MANAGED_LOCAL_BUILD=1` 的分支上。打包仍要删除 web 树里的 `sharp` 和 `@img`，因为 Next 的文件追踪仍可能带上它们。
- 体积预算是警告线，不是目标体积：node 135 MiB，graphify 175 MiB，web 30 MiB，合计 620 MiB。用户量的 764 MiB 会触发合计警告；按上面分段估算的瘦身后体积不应触发。

## 已定的做法

- 工具缓存继续拷完整 Node 家目录。载荷拷贝跳过 `node/include/**`、`node/lib/node_modules/{npm,corepack}/**`、`node/node_modules/{npm,corepack}/**`、`node/bin/{npm,npx,corepack}`，以及 Windows 的 `npm` / `npx` / `corepack` 的 `.cmd` 和 `.ps1`。不跳过 `node` 可执行文件和 `LICENSE`。（D-1，推断）
- 运行时和 CLI 启动器不调用 npm 或 Corepack。`@electron/rebuild` 的 node-gyp 只在含 devDependency 的那次 `npm ci` 里用到头文件，所以头文件留在缓存、不进载荷。（D-2，推断）
- `materializeSymlinks` 之后，若 `bin/python` 或 `bin/python3` 与 `bin/python3.11` 字节相同，则删除前两者。字节不同则构建失败，不删。POSIX 启动器改为 `python/bin/python3.11`。Windows 启动器仍是 `python\python.exe`。（D-3，推断）
- 只在 darwin 上、且扫描不到 `libpython3.11` 的加载名时，删除 `lib/libpython3.11.dylib`。Windows DLL 保留。`prunePythonRuntime` 本身仍不删这个库。（D-4，推断）
- 载荷里的 `runtime/licenses/electron/LICENSES.chromium.html` 保留。`afterPack` 删除应用输出目录里其余同名文件；这份载荷副本缺失、不是普通文件、或出现两份时，不删任何副本并让打包失败。源映射只删 `*.js.map`、`*.mjs.map`、`*.cjs.map`、`*.css.map`、`*.ts.map`、`*.tsx.map`、`*.jsx.map`。（D-5，推断）
- 留下的 wheel 前缀：`graphifyy`、`networkx`、`numpy`、`pyyaml`、`rapidfuzz`、`tree_sitter`（运行时，不是语法）、`tree_sitter_bash`、`tree_sitter_c`、`tree_sitter_c_sharp`、`tree_sitter_cpp`、`tree_sitter_go`、`tree_sitter_java`、`tree_sitter_javascript`、`tree_sitter_json`、`tree_sitter_kotlin`、`tree_sitter_php`、`tree_sitter_python`、`tree_sitter_ruby`、`tree_sitter_rust`、`tree_sitter_swift`、`tree_sitter_typescript`。TypeScript 与 TSX 都由 `tree_sitter_typescript` 提供。每个目标 21 个 wheel。已留下的 wheel 的 URL 和 SHA-256 不改。[D-6]
- 去掉的语法 wheel 前缀：`tree_sitter_elixir`、`tree_sitter_fortran`、`tree_sitter_groovy`、`tree_sitter_julia`、`tree_sitter_lua`、`tree_sitter_objc`、`tree_sitter_powershell`、`tree_sitter_scala`、`tree_sitter_verilog`、`tree_sitter_zig`。graphifyy 0.9.95 没有 YAML、TOML、HTML、CSS、Markdown 的 tree-sitter wheel（YAML 走 PyYAML）。这五项不是本次留下或去掉的对象。（D-6，推断）
- 去掉 `tree_sitter_objc` 之后，Objective-C 的 `.m` 和 `.h` 会带着警告被跳过。混有 ObjC 与 Swift 的 iOS 仓库，ObjC 部分的索引质量会下降。（D-6，推断）
- C# 的 `tree_sitter_c_sharp` 留下。[D-6]
- 托管 Next 配置增加 `images: { unoptimized: true }`，并用 `outputFileTracingExcludes` 排除 `node_modules/sharp/**` 与 `node_modules/@img/**`。打包再删 web 树里父目录为 `node_modules` 的 `sharp` 和 `@img`。不改 `DesktopTitlebar.tsx`。[D-7]
- `stage-runtime`、`payload-size.mjs`、`desktop:make`（dmg / exe / `.app`）、`desktop:smoke-runtime`、`desktop:smoke` 打印大小。警告写 stderr，前缀 `payload size warning:`，不把退出码改成非 0。darwin-arm64 与 win32-x64 的 desktop workflow 在 stage 之后有单独一步打印载荷分段。[D-8]
- `desktop:smoke-runtime` 在 CLI 检查之后跑一次随包启动器：`extract <临时目录> --code-only`，环境 `GRAPHIFY_BACKEND=none`。语料有 `function smokeGreet` 的 `hello.js` 和 `chip.v`。要求退出码 0，`graph.json` 含 `smokeGreet`，输出无 `Traceback`，且出现 verilog 的 `not installed`。超时 120 秒。启动器缺失时，只有 linux 可以跳过；darwin 与 win32 缺失即失败。（D-9，推断）

## 留给实现者

- Mach-O 解析器只实现上面列出的加载命令和 FAT 切片。更稀有的二进制格式解析失败时按「保留 dylib」处理。
- 警告预算的数字以本 spec 的约束为准。CI 量到的 `.app` 与 dmg 字节写进 PR 说明，不写进 README。

## 验收标准

- R-1：fixture 载荷含 `include/node.h` 时，staged 树里没有该文件；工具缓存的拷贝逻辑不调用跳过函数。Node 可执行文件和 `LICENSE` 仍在载荷里。
- R-2：同一 fixture 里 npm 与 Corepack 的目录和 `npm` / `npx` / `corepack` 垫片不在载荷里。`npmCliPathFor` 的路径算法不变。
- R-3：字节相同的 `python` 与 `python3` 被删除；`python3.11` 保留。启动器文本匹配 `python/bin/python3.11`。Windows 启动器源码仍匹配 `python\python.exe`。字节不同时函数抛错且不删除。
- R-4：没有加载名含 `libpython3.11` 时 dylib 被删；有加载名、或 Mach-O 截断无法解析时保留。`prunePythonRuntime` 的现有断言仍认为它自己不删该库和 `python3`。Windows 保留项仍含 `python311.dll`。
- R-5：`afterPack` 删掉 Framework 里的副本和指向它的符号链接，载荷副本还在。载荷副本缺失时抛错且 Framework 副本还在。staged web 树没有 `sharp`、`@img` 和 `*.js.map`。Chromium 声明正文仍能被现有通知测试读到。
- R-6：两个目标的 wheel 数是 21，去掉的前缀不在锁里，留下的前缀都在，两条 Python SHA-256 与现在相同。`graphify-languages` 测试在不安装 verilog 的环境里跑 `extract --code-only`，退出码 0，图里有 `smokeGreet`，输出含 `not installed`。
- R-7：`NEMA_MANAGED_LOCAL_BUILD=1` 时 Next 配置含 `output: "standalone"`、`images.unoptimized === true`，以及 sharp / `@img` 的 tracing 排除。`DesktopTitlebar.tsx` 与 `globals.css` 的 diff 为空。
- R-8：用数字调用格式化函数，超过预算的段产生 `payload size warning:`，不超过的不产生。函数不改退出码。desktop workflow 含对 `payload-size.mjs` 的一步。
- R-9：`smoke-runtime.mjs` 在 CLI 用法检查之后调用 Graphify 提取。现有启动、CLI、网页资源检查仍在。

CI 上 darwin-arm64 与 win32-x64 的构建冒烟是 R-1 到 R-5 的打包证明。本机跑不了 macOS 安装包。PR 说明要分开写：脚本测试、估算节省、CI 实测的 app 与安装包大小。维护者仍需在 Mac 上打开应用看标题栏图标，并对一个 `.js` 和一个 `.v` 跑索引；在 Windows 上确认 `python311.dll` 还在、`graphify.exe` 能启动。
