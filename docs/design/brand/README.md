# Nema Room 品牌素材

2026-10-25：用户选择最初三方案对比稿的 **01 / ROOM / N**，作为当前开源项目的图形标志。后续 A/B 变体未被采用。

| 文件 | 用途 |
| --- | --- |
| [nema-room-original-concepts.png](nema-room-original-concepts.png) | 原始对比稿；只采用左列 01，作为造型核对基准 |
| [nema-room-icon-01.png](nema-room-icon-01.png) | 从 01 生成的独立透明背景 PNG，1254 × 1254；临时图标素材 |
| [nema-room-mark.svg](nema-room-mark.svg) | 对照原始 01 手工描绘的两个填充路径；生产图形母版，360 × 360 viewBox |
| [nema-room-preview.png](nema-room-preview.png) | 512 × 512 浅底预览，供 README 明暗主题通用 |
| [nema-room-preview.svg](nema-room-preview.svg) | 同一预览的矢量版本 |

品牌全称为 **Nema Room**。图形采用开放房间／门洞与负形 N，沿用界面的纸白、暖灰、墨黑和克制的几何语言。保留原始 01 的比例与轮廓，不沿用更尖锐的 A/B 版本。默认黑白；原稿的红色示例不是当前默认图标。

PNG 是通过内置 imagegen 根据原稿提取生成的位图，不是人工校准的矢量母版，不能保证逐像素复现。矢量化时以原始左列 01 核对；不能直接将它重命名为 SVG、ICO 或 ICNS。

生成提示摘要：提取原始左列 01；保持外轮廓、内部留白、独立内立面与原有比例；移除文字、其他方案和红色；墨黑图形、透明背景、四周留白。原始对比稿和提取图均由内置 imagegen 生成。

生产资源由 `node scripts/desktop/build-brand-assets.mjs` 从 SVG 母版统一生成；先执行 `npm ci`，脚本使用 Next 已有的 sharp 依赖，无需 ImageGen 或 API。修改造型时只编辑母版再运行脚本。生成资源应一并提交，普通打包不需要重新生成。

`apps/desktop/assets/` 包含 1024px 应用 PNG、7 档 ICO（16/24/32/48/64/128/256px）、ICNS（16–1024px）、32px Windows 托盘图与 16/32px macOS template 图。`apps/web/app/icon.png` 为 192px favicon，`apps/web/public/nema-room-mark.svg` 用于桌面标题栏。应用图标使用独立的暖灰底容器；Windows 托盘与 README 用浅底保证明暗背景对比，透明母版本身不带容器。

代码已接入桌面打包、窗口、标题栏、托盘和浏览器 favicon；显示名为 Nema Room，appId、Nema.exe 与发布文件前缀 Nema 保持兼容。小尺寸、格式与打包验证记录见实施计划。macOS 原生外观验证仍需在 Mac 上完成；Windows 系统缩放和安装升级检查须按计划记录实际结果，不以源代码测试代替。

参见 [设计规格](../../superpowers/specs/2026-10-25-nema-room-brand-design.md) 和 [实施计划](../../superpowers/plans/2026-10-25-nema-room-brand.md)。项目继续使用根目录的 MIT LICENSE；本次记录不作商标注册或名称独占声明。
