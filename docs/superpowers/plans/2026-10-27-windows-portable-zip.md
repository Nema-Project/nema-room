# Windows 便携 ZIP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 同一次 Windows 打包产出独立的 NSIS 安装包和便携 ZIP。ZIP 只含 `afterPack` 之后的应用目录，作为另一条下载，不把安装包套进去。

**Architecture:** electron-builder 的 `win.target` 同时包含 `nsis` 和 `zip`，命令行目标与配置一致。`afterPack` 仍只跑一次。打包后用中央目录检查 ZIP 布局，并确认安装包字节里没有便携 ZIP 的文件名。发布清单把 Windows zip 算进正式资产；darwin 的 zip 仍是意外文件。

**Tech Stack:** 现有 Node 桌面脚本、electron-builder、`node --test`、Vitest。不新增依赖。

**Spec:** `docs/superpowers/specs/2026-10-27-windows-portable-zip-design.md`

**Base:** `0bd830acf08e02361f6866c3fb7932d89ce9dcfb`。不改 NSIS 解压模板。不发布 macOS ZIP。

## Global Constraints

- ZIP 和 exe 是两个发布资产。ZIP 根上是 `Nema.exe` 和 `resources/`。
- 嵌套 `.zip`、`.7z`、`.rar` 一律失败。PGlite 的 `.tar.gz` 扩展包留在应用里。
- 名单外的发布文件仍然拒绝。macOS 不复制、不期望 zip。
- 不把真实 Windows 上的快捷方式、卸载项或共用数据目录写成已验证。

## Review Focus

1. 命令行目标必须带上 `zip`，否则配置里的 `win.target` 不会生效。→ 任务 2。
2. 校验器要抓住「安装包 + 另一份 ZIP」的套装，也要抓住安装包里出现便携 ZIP 文件名。→ 任务 1。
3. darwin 目录里的 zip 仍然是意外文件。→ 任务 3。
4. `--zip` 冒烟解压后走现有应用检查，但不跑 NSIS 安装。→ 任务 4。

---

### 任务 1：ZIP 布局校验
- 新建：nema-room:scripts/desktop/portable-zip.mjs
- 新建：nema-room:scripts/desktop/portable-zip.test.mjs
- 修改：nema-room:.github/workflows/verify.yml
- 满足：R-2、R-3

- [x] **Step 1:** 用存储法 ZIP fixture 断言合法布局通过；缺根上的 `Nema.exe`、嵌套 `Nema.exe`、安装包文件名、嵌套 `.zip` 失败。安装包字节含 ZIP 文件名（包括跨过读取边界）或自身是 ZIP 时失败。
- [x] **Step 2:** 跑 `node --test scripts/desktop/portable-zip.test.mjs` → 新断言 FAIL。
- [x] **Step 3:** 实现中央目录读取（普通 ZIP 与 ZIP64 哨兵）、布局断言，以及安装包文件名扫描。
- [x] **Step 4:** 同一条测试 PASS。把该测试加进 `verify.yml` 的桌面单测步骤。

### 任务 2：同一次 make 打出 exe 和 zip
- 修改：nema-room:scripts/desktop/make.mjs
- 修改：nema-room:scripts/desktop/payload-size.mjs
- 修改：nema-room:apps/desktop/test/make.test.mjs
- 满足：R-1、D-2、D-5

- [x] **Step 1:** 断言 Windows `win.target` 和 `builderCliArgs` 都是 `nsis` 加 `zip`，macOS 只有 `dmg`。
- [x] **Step 2:** 跑 `npx vitest run apps/desktop/test/make.test.mjs` → FAIL。
- [x] **Step 3:** 改配置和命令行参数。Windows 打包成功后调用两个断言。体积报告包含 `.zip`。
- [x] **Step 4:** 同一条测试 PASS。

### 任务 3：发布清单接受 Windows ZIP
- 修改：nema-room:scripts/desktop/release-manifest.mjs
- 修改：nema-room:scripts/desktop/release.test.mjs
- 满足：R-4

- [x] **Step 1:** 断言收包含 Windows zip、不含 darwin zip；缺 zip、意外文件、校验和不匹配、`verify` 被改字节时失败。
- [x] **Step 2:** 跑 `node --test scripts/desktop/release.test.mjs` → FAIL。
- [x] **Step 3:** `expectedAssets` 只给 win32-x64 加上 zip。注释改成两条独立下载，不再写「便携 ZIP 因重复而不发布」。增加 `verify` 子命令。
- [x] **Step 4:** 同一条测试 PASS。

### 任务 4：工作流、解压冒烟
- 修改：nema-room:.github/workflows/desktop-release.yml
- 修改：nema-room:scripts/desktop/smoke-desktop.mjs
- 修改：nema-room:scripts/desktop/smoke-desktop.test.mjs
- 修改：nema-room:scripts/ci/workflows.test.mjs
- 满足：R-5、R-6

- [x] **Step 1:** 断言 `--zip` 与 `--installer` 互斥，默认仍是安装包。Windows 上断言解压进 `東京` 路径。工作流断言含 `--zip` 冒烟、`verify`，且 zip 只在 win32 分支复制。
- [x] **Step 2:** 跑 `node --test scripts/desktop/smoke-desktop.test.mjs scripts/ci/workflows.test.mjs` → FAIL。
- [x] **Step 3:** 恢复 `extractPortableZip`。`--zip` 解压后进入现有应用检查。工作流在 NSIS 冒烟之后增加 ZIP 冒烟，并在上传集里带上 Windows zip。
- [x] **Step 4:** 上述测试 PASS。非 Windows 的解压测试跳过。

### 任务 5：文档
- 修改：nema-room:scripts/desktop/RELEASE.md
- 修改：nema-room:scripts/desktop/README.md
- 修改：nema-room:README.md
- 修改：nema-room:README.en.md
- 修改：nema-room:README.zh.md
- 修改：nema-room:README.ja.md
- 修改：nema-room:docs/guide.en.md
- 修改：nema-room:docs/guide.zh.md
- 修改：nema-room:docs/guide.ja.md
- 修改：nema-room:CHANGELOG.md
- 满足：R-7

- [x] **Step 1:** 发布说明改资产集合和 ZIP 的本机检查。README 下载节写成二选一。指南的 Windows 行和构建产物补上 ZIP。变更记录写在 `[Unreleased]`。
- [x] **Step 2:** 两份英文 README 字节相同。文档检查不报缺链接。
