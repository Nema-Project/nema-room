# Nema Room Brand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record the selected identity now, then carry the original 01 mark and Nema Room display name through desktop and browser surfaces.

**Architecture:** Keep the original concept board as the visual reference and the extracted PNG as a provisional asset. Derive reviewed production resources from a vector master, then connect them to existing Electron packaging/runtime and Next metadata without changing runtime identity or storage.

**Tech Stack:** Markdown, SVG/PNG/ICO/ICNS, existing Node.js scripts, Electron, electron-builder, Next.js.

**Spec:** [Nema Room brand design](../specs/2026-10-25-nema-room-brand-design.md).

## Global Constraints

- 品牌全称为 **Nema Room**。
- 保留原始 01 的比例与轮廓，不沿用更尖锐的 A/B 版本。
- 不得更改 appId `org.nema-project.nema-room`、数据目录、CLI 命令、包名或运行核心标识。
- Preserve other agents' changes; read current titlebar and packaging code before editing.
- User authorized execution with “开始做”. Source integration is implemented; native checks remain separate and must be recorded honestly.

## Review Focus

1. Dark tray backgrounds: verify a contrasting/template icon in Task 3.
2. Small sizes and display scaling: inspect 16/20/24/32px and 100/150/200% Windows scaling in Tasks 2–3.
3. Packaged paths: inspect installed resources and launch without the source checkout in Task 3.
4. Existing installation/data: verify preserved appId, launch paths and existing workspace discovery in Task 3.
5. Visual drift during tracing: compare the master against original left-column 01, not the A/B board, in Task 2.

## Task 1: Record the selected identity

**Files:** `docs/design/brand/README.md`, the two PNGs in that folder, the linked spec, this plan, and the three root READMEs.

**Interfaces:** Consumes the user's original-01 selection; produces the canonical reference paths used by Task 2.

- [x] Save the original board and provisional transparent PNG; document source, selection and generation limitations.
- [x] Write the design spec and this plan, separating completed documentation from pending integration.
- [x] Add matching brand/material links to Chinese, English and Japanese README files.
- [x] Check local Markdown links, PNG signature/dimensions/alpha channel, and `git diff --check`; inspect only this task's diff. Verification: 47 local links across six documents resolve; extracted PNG is 1254 × 1254 RGBA; original board is 1536 × 1024 RGB. No runtime integration or native icon checks were performed.

## Task 2: Produce platform assets from the selected mark

**Files:** Create `docs/design/brand/nema-room-mark.svg`, `apps/desktop/assets/icon.png`, `icon.ico`, `icon.icns`, `tray.png`, `trayTemplate.png`, `trayTemplate@2x.png` in the same assets directory, and `apps/web/app/icon.png`, `apps/web/public/nema-room-mark.svg`, and `scripts/desktop/build-brand-assets.mjs`. Update the brand README with export provenance and actual dimensions.

**Interfaces:** Consumes Task 1 reference paths; produces local image resources consumed by Task 3.

- [x] Trace the original 01 into a minimal SVG master; compare silhouette, proportions and negative space side by side. Do not trace A/B or assume generated extraction is exact. Prefer native vector editing for this step.
- [x] Export a square 1024px PNG, real multiresolution ICO including 16/24/32/48/256px, and real ICNS from the master. Verify actual file formats and alpha rather than extensions.
- [x] Export the Web 192px PNG and tray resources (Windows 32px; macOS template 16px and 32px @2x). Preserve the mark and optical clearance; use contrasting tray presentation for both taskbar themes.
- [x] Inspect light/dark previews at 16/20/24/32px and a README preview; document results. If small details disappear, record the necessary optical adjustment before adopting it.

## Task 3: Integrate display branding and verify packages

**Files:** Modify `scripts/desktop/make.mjs`, `apps/desktop/lifecycle.cjs`, `apps/desktop/security.cjs`, `apps/web/components/DesktopTitlebar.tsx` and existing desktop tests `apps/desktop/test/{make,lifecycle,security}.test.mjs`; inspect `apps/web/app/layout.tsx` and existing metadata before adding duplicate declarations. Refresh root README previews and brand asset status after verification.

**Interfaces:** Consumes Task 2 assets. Packaging must include `assets/**/*` inside the application; Electron resolves those resources relative to `__dirname` in development and the packaged app.

- [x] Read current files and search display names and executable/artifact references. Add meaningful regression assertions for unchanged appId, packaged asset inclusion, platform icon configuration, window title/icon and tray resource selection before changing runtime behavior.
- [x] Run `node node_modules/vitest/vitest.mjs run apps/desktop/test` and confirm new assertions fail for the intended missing behavior.
- [x] Set builder `productName` to `Nema Room`, retaining `executableName: 'Nema'` for launcher compatibility; wire `win.icon` and `mac.icon` to the assets. Include assets in the application file list. Keep `appId` unchanged and retain the `Nema-` artifact prefix for existing smoke-tool compatibility.
- [x] Use packaged image resources for BrowserWindow and Tray instead of extracting the executable's icon. Use the macOS template variant and verify Windows dark/light contrast. Update visible window/titlebar naming to Nema Room; preserve existing window controls, close-to-tray and security boundaries.
- [x] Let Next discover `app/icon.png`, preserve the existing Nema Room metadata title, and confirm the favicon response and visual appearance in browser mode.
- [ ] Rerun the desktop tests above plus the included window-controls tests; inspect packaged Windows install/shortcut/taskbar/tray resources at 100/150/200% scaling, reopen from tray, and confirm existing workspace data remains discoverable. Perform native macOS icon/template checks on a macOS host; report unavailable native checks as pending.
- [ ] After verification, embed reviewed light/dark-safe README previews, update the asset status, and commit only relevant files when integration is ready; do not publish a release as part of branding.
