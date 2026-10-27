# Windows 便携 ZIP

日期：2026-10-27。实现计划：[2026-10-27-windows-portable-zip.md](../plans/2026-10-27-windows-portable-zip.md)。

**设计所对照的 HEAD**：`0bd830acf08e02361f6866c3fb7932d89ce9dcfb`（`main`）。对照过的删除提交是 `efb9e9c3d0c7d504429d8138600f9e6b95ccfcf0`。

## 历史

`efb9e9c` 去掉了 Windows 和 macOS 的 electron-builder `zip` 目标。`scripts/desktop/release-manifest.mjs` 里留下的注释，以及该提交的说明，都写成：便携 ZIP 和安装包重复了整份应用，所以不再发布。Issue #34 沿用了这个说法，把它当成「决定不提供便携渠道，以避免每次发布再多一整份应用」。

维护者在实现 #34 时澄清：这个说法不是当时的决定。便携 ZIP 被拿掉，是因为之前的实现误解了要求，把 NSIS 安装包和应用程序 ZIP 打进了**同一个** ZIP。那种套装从来不是想要的下载。想要的一直是另一条独立的分发渠道。

仓库里能直接对上的记录只有删除本身和「避免再发一整份」这句理由。没有另一个提交展示那个套装的打包脚本。本设计以维护者的说明纠正这段历史：删除套装是对的；把删除理解成「不提供便携渠道」是错的。

这次恢复的只是 Windows 的独立便携 ZIP。macOS 仍然只发 DMG，不恢复 macOS ZIP。

体积成本：每个 Windows 发布会同时带上安装包和便携 ZIP。两者都是同一份已打包应用的压缩副本，所以发布物大约再多一整份应用。用户只下载其中一条。这个成本是两条渠道的代价，不是把两个文件再套进一个压缩包的理由。

## 意图

Windows 用户可以不走 NSIS。NSIS（`oneClick: false`）会把同一份应用落盘多次，进度条还会在解压阶段被拉回起点。便携 ZIP 解压一次就能运行 `Nema.exe`。安装包继续负责快捷方式、卸载和覆盖安装。两条都是正式发布资产，各自有校验和。用户选一条。

## 目标

- 同一次 `desktop:make --platform win32 --arch x64` 用 electron-builder `win.target: ['nsis', 'zip']` 打出两个文件。不另开流水线。macOS 目标仍只有 `dmg`。
- 命令行传给 electron-builder 的目标与配置一致：Windows 是 `nsis` 和 `zip`，macOS 是 `dmg`。只改配置、命令行仍只传 `nsis` 时，构建器会丢掉 ZIP。
- 资产名是 `Nema-<version>-win32-x64.exe` 和 `Nema-<version>-win32-x64.zip`。ZIP 的根上有 `Nema.exe` 和 `resources/`，也就是 `afterPack` 之后的 `win-unpacked` 内容。`afterPack` 只跑一次，安装包和 ZIP 用的是同一份瘦身载荷和许可声明。
- ZIP 里没有 NSIS 安装包，没有嵌套的 zip / 7z / rar / tar 归档，也不是「安装包加另一份 ZIP」的套装。安装包文件本身不是 ZIP，内容里也不出现便携 ZIP 的文件名。
- 发布清单把 Windows 的 exe 和 zip 都算正式资产，各自进每目标 `SHA256SUMS-<version>-<target>.txt` 和合并的 `SHA256SUMS-<version>.txt`。darwin 的 ZIP、`latest.yml`，以及其他名单外的文件仍然拒绝。缺 ZIP 也拒绝。
- Windows CI 列出 ZIP、按校验和核对，并解压后走与 NSIS 冒烟相同的已打包应用检查。NSIS 静默安装冒烟保留。
- README 的中英日下载节把两者写成二选一。`RELEASE.md` 写明资产集合，以及 ZIP 的本机检查：数据目录、没有快捷方式或卸载程序、和已安装的 NSIS 副本共用 `~/.nema/desktop`。

## 非目标

- 不改 electron-builder 的 NSIS 解压模板，包括 `extractAppPackage.nsh`。不把压缩改成 `store`，不改 `nsis.useZip`。
- 不拿掉 NSIS。不改 `oneClick`、`differentialPackage`、快捷方式或 `deleteAppDataOnUninstall`。
- 不发布 macOS 便携 ZIP。
- 不在 README 里写会死的安装包字节数。ZIP 的实测大小只出现在 CI 日志和 PR 说明。
- 不改 `ROADMAP.md`。本机「没有快捷方式、没有卸载项、与 NSIS 副本共用数据」的检查不能写成已经验过。

## 反目标

做到了也算失败：

1. 一个 ZIP 里同时有 `Nema-<version>-win32-x64.exe` 和另一份 `.zip`。
2. 便携 ZIP 的根上没有 `Nema.exe`，或者没有 `resources/`。
3. 安装包里嵌了便携 ZIP 的文件名，或安装包本身是 ZIP。
4. 发布目录多一个名单外的文件时仍然收包成功，或 darwin 目录里的 ZIP 被当成正式资产。
5. 命令行目标与 `win.target` 不一致，导致只打出 NSIS。
6. 文档把 ZIP 写成安装包的附件，或者把尚未在真实 Windows 上做过的快捷方式 / 共用数据检查写成已通过。

## 约束

- 代码和注释用英文。
- 便携 ZIP 由 electron-builder 的 Windows `zip` 目标生成。该目标对非 macOS 使用 `withoutDir`，归档的是 `win-unpacked` 目录里的内容，所以 `Nema.exe` 在 ZIP 根上，不在再套一层的目录里。
- 嵌套的分发归档后缀是 `.zip`、`.7z`、`.rar`，路径任意深度都拒绝。PGlite 随应用带 PostgreSQL 扩展的 `.tar.gz`，那是运行时文件，不是第二条下载，不拒绝。若依赖带了 `.zip` / `.7z` / `.rar`，从载荷排除，而不是放宽这条检查。
- NSIS 安装包的判定名是 `Nema-<version>-win32-x64.exe` 这种文件名（`Nema-` 开头、`-win32-x64.exe` 结尾）。应用自己的 `Nema.exe`、`node.exe`、`python.exe` 不是安装包。
- 解压冒烟沿用系统 `System32\tar.exe`：先解到 ASCII 临时目录，再复制到带空格和非 ASCII 字符的证明目录。`tar.exe` 不能直接进入英文代码页下的 `東京` 路径。解压超过 15 分钟则失败。
- 两条 Windows 构建使用同一个 `appId` 和产品名。数据目录都是 `~/.nema/desktop`。Electron 的普通 user-data 目录也相同。第二个进程连到已经在跑的核心，不另开一份数据库。NSIS 卸载不删除该数据目录（`deleteAppDataOnUninstall: false`），也不删除用户另行解压的 ZIP 目录。删掉 ZIP 目录不会卸载 NSIS。

## 已定的做法

- `builderConfig` 的 Windows 目标是 `['nsis', 'zip']`。macOS 目标保持 `['dmg']`。`builderCliArgs` 按同一份名单拼 electron-builder 参数。[D-1]
- 打包成功后、打印体积之前，Windows 构建调用 `assertPortableAppZip` 和 `assertInstallerOmitsPortableZip`。前者读 ZIP 中央目录（含 ZIP64 哨兵值），不把压缩后的文件体解进内存。后者确认安装包不是 ZIP，并在文件字节里搜索便携 ZIP 的文件名。[D-2]
- `expectedAssets('win32-x64')` 返回 exe 再返回 zip。`expectedAssets('darwin-arm64')` 只返回 dmg。每目标校验和与合并校验和都覆盖这份名单。`verify` 子命令按这份名单重算哈希，供 PR 构建使用；发布 job 的 `collect` 仍拒绝名单外文件。[D-3]
- 桌面工作流在 Windows 上复制 exe、zip 和每目标校验和；macOS 不复制 zip。复制前运行 `checksums` 和 `verify`。NSIS 冒烟之后再跑 `--zip` 冒烟。`--zip` 解压后走现有的已打包应用检查（就绪、页面资源、假 Provider 对话、浏览器回退、重启），不执行 NSIS 安装。[D-4]
- 体积报告把 `.zip` 和现有的 `.exe` / `.dmg` 一起打印，前缀仍是 `payload size:`。[D-5]

## 留给实现者

- ZIP64 只在中央目录的 16 位条目数或 32 位偏移/长度是哨兵值时跟随。普通 ZIP 仍走 EOCD。中央目录超过 64 MiB 则拒绝。
- 真实安装包和 ZIP 的字节布局要等 win32-x64 的 desktop-release 构建。在那之前，fixture 只证明校验器。PR 说明分开写脚本测试和 CI 日志里的 ZIP 大小。没有看到该日志就不写大小。

## 验收标准

- R-1：`builderConfig` 的 Windows 目标是 `nsis` 与 `zip`，macOS 仍只有 `dmg`。`builderCliArgs` 的 Windows 参数含 `nsis` 和 `zip`，macOS 参数不含 `zip`。NSIS 选项和 `afterPack` 还在。
- R-2：根上有 `Nema.exe` 和 `resources/` 的 ZIP 通过。根上没有 `Nema.exe`、只有嵌套目录里的 `Nema.exe`、含 `Nema-1.2.3-win32-x64.exe`、或任意深度含 `.zip` / `.7z` 时失败。
- R-3：安装包字节里没有便携 ZIP 文件名时通过；文件名跨过读取边界时仍能发现。安装包以 ZIP 本地文件头开头时失败。
- R-4：收包结果含 Windows exe、Windows zip、macOS dmg、两份每目标校验和、合并校验和和清单。缺 Windows zip、darwin 目录里的 zip、`latest.yml`、校验和不匹配、校验和多记或少记，都失败。`verify` 对被动过的 zip 失败。
- R-5：`desktop:smoke` 默认仍是 NSIS 安装包。`--zip <file>` 和 `--installer <file>` 各接受一个路径。两者一起传、或缺少路径时失败。Windows 上的解压测试把文件放到带 `東京` 和空格的目录里。
- R-6：desktop-release 工作流在 Windows 上执行 `--installer` 冒烟和 `--zip` 冒烟，运行 `verify`，并且只在 `win32` 上复制 zip。
- R-7：`RELEASE.md` 不再写「不发布便携 ZIP」，并写明数据目录、无快捷方式、无卸载程序、与 NSIS 共用数据目录。中英日 README 的下载节把 exe 和 zip 写成二选一。`[Unreleased]` 有对应条目。两份英文 README 字节相同。

win32-x64 的 desktop-release 构建是 R-2 在真实归档上的证明，也是解压后启动的证明。本机不打包。快捷方式、卸载项，以及和已安装 NSIS 副本共用 `~/.nema/desktop`，留到真实 Windows 机器上检查，在此之前保持未完成。
