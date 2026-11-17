# Knowledge tags Tasks 6–11: local implementation record

Date: 2026-11-17. Branch: `feat/162-tags`, starting commit `8c23c95` (Tasks 1–5 already implemented). Scope: [plan Tasks 6–11](../superpowers/plans/2026-11-17-knowledge-tags.md), [decided design](../superpowers/specs/2026-11-16-knowledge-tags-design.md), [#162](https://github.com/Nema-Project/nema-room/issues/162). No commit, push, merge, Task 12, identity work, real-model or native acceptance.

## Per-task changes and verification

| Task | Files changed | Before / after checks |
| --- | --- | --- |
| 6 | `apps/hub/src/mentionContext.ts`, `apps/hub/test/mentionContext.test.ts` | New tag group and route regressions failed (2 failed, 21 passed); original expanded suite passed 23/23. Added overflow/null-row coverage; final combined hub run passed 93/93 (24 mention-context, 41 prompt, 28 share tests). |
| 7 | `apps/hub/src/prompt.ts`, `apps/hub/test/prompt.test.ts`, `apps/hub/test/fixtures/untagged-prompt.txt` | Four tag-index regressions failed before implementation. Prompt suite passed 42/42 after final four-byte exact-boundary case. Fixture was captured using the pre-change `HEAD` prompt source, which is unchanged from main. `daemonSocket.test.ts` was attempted and interrupted after several minutes without a completed test result; its setup binds a real local socket. |
| 8 | `apps/hub/src/shares.ts`, `apps/hub/test/shares.test.ts`; web `lib/sharePage.ts`, `components/ShareView.tsx`, `test/sharePage.test.ts`, `test/ShareView.test.tsx`; three message files; share design amendment | Projection regression failed before implementation; initial web run overlapped implementation, so a web RED result is not claimed. Combined hub/share-page/view suite passed 66/66. Untagged exact-shape assertion remained unchanged. Added public-route tag assertions for the final share rerun. |
| 9 | CLI `src/direct/tools.ts`, `src/mcp/server.ts`, `src/room/client.ts`, `test/direct/tools.test.ts`, `test/mcpServer.test.ts`, `test/mcpTags.test.ts` | Schema regression failed because Zod output-mode conversion cannot serialize normalization transforms. Direct tests passed 12/12 after review fix; two in-memory MCP tests passed. Existing socket-based MCP suite failed at `listen 127.0.0.1` with sandbox `EPERM`, both before and after implementation. |
| 10 | Web `lib/hub.ts`, `lib/mentions.ts`; `components/EntryDetail.tsx`, `KnowledgePanel.tsx`, `MentionMenu.tsx`, `Composer.tsx`; three message files; corresponding tests plus `HistoryTab.test.tsx` and `WorkPackageDetail.test.tsx` fixture corrections | Initial targeted web run: 6 failed, 117 passed. Seven-file run subsequently passed 129/129. Final combined prompt/CLI/web run passed 220/220 after review fixes; a separate later prompt boundary test raised its own suite to 42. Web fixtures needed `tags: []` because root typecheck excludes web. |
| 11 | Four READMEs, three guides, `docs/reference.zh-CN.md`, plan checkboxes, this record, `changelog.d/knowledge-tags.added.md` | English README byte comparison, docs checker and `git diff --check` passed. Root/CLI typechecks and standalone web TypeScript check passed. Web lint passed with the existing `WorkspaceShell.tsx:321` warning. Production build compiled, then failed parsing TypeScript `--showConfig` output. The full-suite attempt was interrupted after the failures listed below. |

Commands used: `npm run typecheck`; `npm run typecheck -w apps/cli`; targeted `npx vitest run <files above> --maxWorkers=1`; `npx tsc -p apps/web --noEmit`; `npm run lint -w apps/web`; `npm run build -w apps/web`; `npm test -- --maxWorkers=2`; `node scripts/ci/docs-check.mjs <changed-Markdown-JSON-file>`; `cmp README.md README.en.md`; `git diff --check`. Test logs are under `/tmp/tags-work/` in this workspace. CodeRabbit CLI was not available.

## Deviations and limits

- JSON Schema generation uses input mode plus explicit `maxItems: 8`, because the already-implemented normalization transforms cannot be serialized in output mode. Hub validation still owns normalization and deduplication.
- Tag editing follows the existing ordinary-entry edit affordance. Diagram and work-package details have no tag editor: their generic entry PUT rebuilds frontmatter without their specialized metadata. Adding controls using that route would lose metadata; this portion needs a separate preservation/API change before those editors can safely be offered. Their tags still display in panel rows and participate in filters, mentions and public projections.
- ROADMAP is unchanged. Task 11 explicitly requires its #162 note **after merge**, with a PR link; this session has no merge authorization. Supervisor must add the post-merge note and retain pending acceptance.
- Plan checkboxes record implemented/attempted steps, not a green full verification or acceptance. Windows/macOS upgrade harness, packaging, real models and Task 12 were not run.

## Review fixes

A fresh read-only reviewer found two P2 issues. Both were reproduced as failing tests and fixed: clearing remains available when refresh removes the selected workspace's final tag; the old-hub notice precedes the entry so the direct transport's 64 KiB cap cannot erase it. No minor findings were deferred. The review did not independently re-audit committed Tasks 1–5 or judge excluded native/real-environment acceptance; those remain supervisor scope.


## Full-suite attempt

`npm test -- --maxWorkers=2` was started after both required typechecks and interrupted after failures in `apps/cli/test/mcpServer.test.ts` (8), `apps/cli/test/secrets/permissions.test.ts` (6, with 2 skipped) and `apps/cli/test/repos/handlers.test.ts` (7). MCP failures were independently observed as sandbox `EPERM` on `listen 127.0.0.1`. The other failures have not been reproduced against the starting commit and are not classified as baseline defects. The full run did not complete and is not a passing check. The supervisor needs an unrestricted authoritative rerun. Final share-route assertions passed 28/28; final standalone web TypeScript and lint checks passed (the existing lint warning remains).
