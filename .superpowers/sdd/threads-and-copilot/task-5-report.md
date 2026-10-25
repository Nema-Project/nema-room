# Task 5 report: Copilot prompt

Implemented the Chinese copilot persona, write-versus-answer guidance, unconditional user-stated/decided recording, proposal basis constraints, explicit override handling, and question creation for other conflicts with `related`, `quotes`, and `sourceMessages`. Main and thread prompts share the same numbered knowledge rules; main-only discussion guidance and thread title/anchor/follow-up guidance are separate sections. User-opened threads can request a better title through `open_thread`. Removed the summary-only and automatic-question fallback wording while preserving work-package, report, quote, edit, language, and grill behavior.

Files changed: `apps/hub/src/prompt.ts`; `apps/hub/test/prompt.test.ts`.

RED: `npx vitest run --project @nema/hub prompt` — failed as expected, 7 failed / 21 passed. Failures covered absent copilot/thread behavior, missing conflict rules, and old summary-only wording.

GREEN: `npx vitest run --project @nema/hub prompt` — 1 file passed, 28 tests passed. Vite emitted existing `configLoader: 'native'` compatibility warnings.

Typecheck: `npm run typecheck` — passed (`tsc -b`). `git diff --check` — passed.

Concern: the shared thread context now displays the anchor in its dedicated thread section and omits its duplicate from `# 最近消息`; the anchor plus latest 50 replies remain available. The controller-owned plan file had pre-existing edits and was left untouched.
