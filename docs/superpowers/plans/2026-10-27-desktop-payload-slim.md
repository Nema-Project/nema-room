# 桌面安装包瘦身 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 缩小 darwin-arm64 与 win32-x64 的桌面载荷：去掉 Node 头文件、npm、Corepack、重复的 Python 解释器、未被引用的 `libpython3.11.dylib`、多余的 Chromium 声明、源映射、冷门 tree-sitter 语法，以及 sharp。

**Architecture:** 工具缓存仍是完整 Node。载荷 `copyTree` 用 `nodePayloadExcluded` 跳过。Graphify 在物化符号链接后删掉与 `python3.11` 字节相同的副本，安装 wheel 后再扫描 Mach-O。锁文件只留 21 个 wheel。托管 Next 配置关图片优化，打包再删 sharp。`afterPack` 只多删 Chromium 声明的副本。体积报告只警告。

**Tech Stack:** 现有 Node 桌面脚本、electron-builder、Vitest（Next 配置）、`node --test`。不新增依赖。

**Spec:** `docs/superpowers/specs/2026-10-27-desktop-payload-slim-design.md`

**Base:** `5ff8cf96c8071fd9da2423303d7a6108150e9c9e`。不改 `DesktopTitlebar.tsx`、`globals.css`、`DesktopTitlebar.test.tsx`。

## Global Constraints

- 不新增 npm 依赖。不改标题栏组件。载荷里不放符号链接。
- 工具缓存的 `fetch-tools` 拷贝不跳过 `include/` 或 npm。
- Windows 的 `python.exe` 与 `python311.dll` 保留。numpy 保留。
- 体积警告不改变退出码。前缀是 `payload size warning:`。
- 不改 README 里的产品安装步骤，不写会死的安装包字节数。

## Review Focus

1. 跳过函数只作用于载荷拷贝。`npm ci` 仍从缓存里的 npm 启动。→ 任务 1。
2. `python3` 被删之后启动器必须指向 `python3.11`。字节不同不能删。→ 任务 2。
3. Mach-O 解析失败要留下 dylib。`LC_ID_DYLIB` 不算引用。→ 任务 2。
4. `afterPack` 在载荷声明缺失时不能删掉最后一份。→ 任务 3。
5. 锁文件留下的 wheel 哈希不变。缺 verilog 时提取仍为 0。→ 任务 4。
6. 不要为了 sharp 去改 `DesktopTitlebar.tsx`。→ 任务 3。

---

### 任务 1：Node 载荷排除
- 修改：nema-room:scripts/desktop/fetch-tools.mjs
- 修改：nema-room:scripts/desktop/stage-runtime.mjs
- 修改：nema-room:scripts/desktop/staging.test.mjs
- 修改：nema-room:scripts/desktop/source-materials.mjs
- 修改：nema-room:scripts/desktop/source-materials.test.mjs
- 修改：nema-room:scripts/desktop/source-materials-policy.json
- 满足：R-1、R-2

- [x] **Step 1:** 断言 `nodePayloadExcluded` 对 `include`、npm、Corepack 和垫片为真，对 `node/bin/node` 与 `LICENSE` 为假。fixture 写入这些文件以及 web 的 `sharp`、`@img`、`a.js.map` 后，staged 树里没有它们，Node 二进制、LICENSE、Chromium 声明还在。
- [x] **Step 2:** 跑 `node --test scripts/desktop/staging.test.mjs` → 新断言 FAIL。
- [x] **Step 3:** 导出 `nodePayloadExcluded`。`copyTree` 增加可选 `skip`。载荷拷贝传入它。`fetch-tools` 的缓存拷贝加注释，不跳过。`node-source` 的 files-coverage 必填键改为 `['node-runtime']`。策略理由改为 Node 的 MIT 声明，并写明 npm 与 Corepack 不进载荷。fixture 不再把 npm/Corepack 文件放进 node 树。
- [x] **Step 4:** 同一条测试 PASS。

### 任务 2：一个 Python，以及未引用的 libpython
- 修改：nema-room:scripts/desktop/fetch-graphify.mjs
- 修改：nema-room:scripts/desktop/graphify.test.mjs
- 满足：R-3、R-4

- [x] **Step 1:** 断言字节相同的 `python` / `python3` 被删；不同则抛错。断言 `LC_ID_DYLIB` 不计入加载名，FAT 切片里的 `LC_LOAD_DYLIB` 计入。无引用时删除 dylib；截断的 Mach-O 保留 dylib。启动器匹配 `python/bin/python3.11`。
- [x] **Step 2:** 跑 `node --test scripts/desktop/graphify.test.mjs` → FAIL。
- [x] **Step 3:** 物化之后删相同副本。检查 `bin/python3.11`。darwin 上在 prune 之后扫描并按规则删除 dylib。`prunePythonRuntime` 不改这个行为。
- [x] **Step 4:** 同一条测试 PASS。

### 任务 3：声明、源映射、sharp
- 新建：nema-room:scripts/desktop/after-pack.cjs
- 新建：nema-room:scripts/desktop/after-pack.test.mjs
- 修改：nema-room:scripts/desktop/make.mjs
- 修改：nema-room:scripts/desktop/stage-runtime.mjs
- 修改：nema-room:apps/web/next.config.ts
- 新建：nema-room:apps/web/test/next-config.test.ts
- 满足：R-5、R-7

- [x] **Step 1:** `afterPack` 测试：有载荷副本时删掉其它副本；没有载荷副本时抛错且其它副本还在。Next 测试：托管构建的 `images.unoptimized` 为 true。
- [x] **Step 2:** 跑 `node --test scripts/desktop/after-pack.test.mjs` 与 `npx vitest run --project @nema/web next-config` → FAIL。
- [x] **Step 3:** 实现 hook，并把它放进 `builderConfig` 的 `afterPack`。staged 树删除源映射和 sharp / `@img`。只在托管配置上加 `images.unoptimized` 与 tracing 排除。
- [x] **Step 4:** 上述测试 PASS。`git diff -- apps/web/components/DesktopTitlebar.tsx apps/web/app/globals.css` 为空。

### 任务 4：语法锁和缺语法测试
- 修改：nema-room:scripts/desktop/graphify-lock.json
- 修改：nema-room:scripts/desktop/graphify.test.mjs
- 新建：nema-room:scripts/desktop/graphify-languages.test.mjs
- 满足：R-6

- [x] **Step 1:** 锁测试断言每个目标 21 个 wheel，留下的前缀都在，去掉的前缀不在，两条 Python SHA-256 不变。
- [x] **Step 2:** 语言测试用 `python3 -m pip install --target` 安装 `graphifyy==0.9.95 --no-deps`，加上 `tree-sitter==0.25.2`、`tree-sitter-javascript==0.25.0`、`networkx==3.6.1`、`numpy==2.4.6`、`rapidfuzz==3.14.6`、`pyyaml==6.0.3`。不装 verilog。对 `hello.js`（`function smokeGreet`）和 `chip.v` 跑 `python -m graphify extract --code-only`，`PYTHONPATH` 指向该目录，`GRAPHIFY_BACKEND=none`。退出码 0，`graph.json` 含 `smokeGreet`，输出含 `not installed`，且无 `Traceback`。超时 180 秒。
- [x] **Step 3:** 从两个目标的 wheel 数组去掉 spec 列出的 10 个前缀。其余对象原样保留。
- [x] **Step 4:** `node --test scripts/desktop/graphify.test.mjs scripts/desktop/graphify-languages.test.mjs` PASS。

### 任务 5：体积报告和冒烟
- 新建：nema-room:scripts/desktop/payload-size.mjs
- 新建：nema-room:scripts/desktop/payload-size.test.mjs
- 修改：nema-room:scripts/desktop/stage-runtime.mjs
- 修改：nema-room:scripts/desktop/make.mjs
- 修改：nema-room:scripts/desktop/smoke-runtime.mjs
- 修改：nema-room:scripts/desktop/smoke-desktop.mjs
- 修改：nema-room:.github/workflows/desktop-release.yml
- 修改：nema-room:.github/workflows/verify.yml
- 满足：R-8、R-9

- [x] **Step 1:** 用 151 MiB 的数字断言 node 警告，用小于预算的数字断言没有警告。不创建大文件。
- [x] **Step 2:** `node --test scripts/desktop/payload-size.test.mjs` → FAIL，然后实现格式化、目录测量、CLI。
- [x] **Step 3:** `stageRuntime` 成功返回前打印分段。`make` 在 electron-builder 之后打印 dmg、exe 和 `.app`。冒烟打印载荷或安装包大小。`smoke-runtime` 增加一次 Graphify 提取。desktop workflow 在 stage 之后运行 `node scripts/desktop/payload-size.mjs`。verify 增加这些 `node --test` 文件。
- [x] **Step 4:** `node --test scripts/desktop/payload-size.test.mjs scripts/ci/workflows.test.mjs` PASS。

### 任务 6：文档
- 修改：nema-room:CHANGELOG.md
- 修改：nema-room:scripts/desktop/README.md
- 修改：nema-room:docs/guide.en.md
- 修改：nema-room:docs/guide.zh.md
- 修改：nema-room:docs/guide.ja.md
- 修改：nema-room:docs/reference.zh-CN.md
- 修改：nema-room:docs/superpowers/specs/2026-10-25-graphify-package-design.md
- 满足：R-3、R-6

- [x] **Step 1:** `[Unreleased]` 的 Changed 写明载荷去掉了什么。桌面 README 写明缓存与载荷的差别、`python3.11`、留下的语法、体积报告。三份指南和中文参考在「启动器只用相对路径」之后加一句解释器和语法范围。旧 Graphify 打包 spec 顶部加一段「部分被取代」，不改历史正文。
- [x] **Step 2:** 路径和句子与脚本一致。不改产品 README 的安装步骤。
