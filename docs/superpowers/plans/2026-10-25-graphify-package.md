# Packaged Graphify runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A desktop release payload built on GitHub Actions includes a relocatable Graphify runtime.

**Architecture:** `graphify-lock.json` pins CPython and graphifyy wheels. `fetch-graphify.mjs` verifies SHA-256, extracts, materializes symlinks, and writes a relative launcher. `stage-runtime.mjs` runs that step for the release targets. Fixture tests stub the download.

**Tech Stack:** Node, the existing desktop staging scripts, Clang on Windows.

## Global Constraints

- Do not copy a developer uv install or any absolute home path into the payload.
- Do not download Graphify at app runtime.
- Do not add extras.
- Do not change the runtime-manifest schema.
- Task 7c stays pending. Do not commit unless asked.

---

### Task 1: Pin and fetch

**Files:**
- Create: `scripts/desktop/graphify-lock.json`
- Create: `scripts/desktop/graphify-launcher.c`
- Create: `scripts/desktop/fetch-graphify.mjs`
- Create: `scripts/desktop/graphify.test.mjs`

- [x] Commit the lock for win32-x64 and darwin-arm64 with hashes taken from the downloaded bytes and the upstream digest.
- [x] Build `tools/graphify/graphify.exe` or `graphify` so it runs `python -m graphify` relative to itself.
- [x] Reject a bad checksum, a symlink left in the tree, and this machine's home path.

### Task 2: Stage and docs

**Files:**
- Modify: `scripts/desktop/stage-runtime.mjs`
- Modify: `scripts/desktop/staging.test.mjs`
- Modify: `scripts/desktop/README.md`, `README.md`, `README.en.md`, `README.ja.md`, `CHANGELOG.md`, `docs/reference.zh-CN.md`
- Modify: the Graphify and bind specs that said a rebuild does not create `tools/graphify/`

- [x] Fixture staging writes the launcher without hitting the network.
- [x] Document that `desktop:stage` creates the runtime and first launch still does not download it.
