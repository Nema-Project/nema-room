# Task 8 implementation report

Implemented hub-only `recordSourceCheck`, workspace-scoped freshness upserts, and read-only `freshness`, `reviewNeeded`, and `unconfirmedSnapshot` projections on Room list/detail and UI list/detail.

Read projections compare both reference revisions and snapshot hashes. Consumed confirmation events must match the snapshot revision/hash, and `confirmedRevision` must agree. Null revision snapshots cannot report `current`. Decision files are not rewritten.

KnowledgeStore now exposes `listEntries()` for one full-entry directory scan; `list()` keeps its original summary contract via exported `summarizeEntry`. API list responses preserve summaries and UI diagram status.

Validation:
- Initial focused regression run failed because the new module did not exist.
- Eight pure projection regressions and one four-interface integration regression pass (9 tests). Integration covers persisted changed/timeout checks, cross-workspace/non-source 404s, confirmation/reimport retaining stated basis, and null-revision hash changes without changing decision bytes.
- `npm run typecheck` passed.
- `git diff --check` passed.
- Initial combined `npx vitest run --project @nema/hub sourceFreshness roomApi`: 72 passed and 1 failed in 117.83 seconds. All 64 existing Room tests and 8 pure projection tests passed; the newly added integration fixture failed because its confirmation POST omitted JSON content headers/body. After correcting the fixture, the final filtered combined run passed all 9 new regressions (8 projection tests plus the integration test), with 64 existing Room tests skipped. The coordinating agent will rerun the combined/full suites against the final fixture.

No dependencies or public write endpoints added. Root full-suite verification remains with the coordinating agent.
