# Vendored: archify

- Upstream: https://github.com/tt-a1i/archify
- Tag: v3.2.0 (latest release tag on 2026-10-23)
- Commit: 208acba8d412335185b2056fedf54b3405df43fb
- Vendored on: 2026-10-23, from a git clone of the tag
- License: MIT — "Copyright (c) 2026 tt-a1i (Archify)", "Copyright (c) 2025 Cocoon AI" (see `LICENSE`; bundled fonts and icons in `THIRD_PARTY_NOTICES.md`)

## What was copied

Only the runtime of the CLI, from the upstream `archify/` directory:
`bin/`, `renderers/`, `schemas/`, `assets/`, `locales/`, `brand-marks/`, `explainer/`, `delta/`, `migrations/`
(statically or lazily imported by `bin/archify.mjs`), `scripts/check-render-output.mjs` (the artifact
checker `validate` spawns), `package.json`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, and one example,
`examples/web-app.architecture.json`, used by the hub tests.

Not copied: tests, docs, the remaining examples, the generator and update-check scripts.

## Runtime notes

- Pure Node (>= 18), no npm dependencies at runtime: schema validation uses the precompiled validators
  in `renderers/shared/generated-validators.mjs`, so `ajv` is not needed. `validate` and `render` need
  no browser (only `browser-check` / `visual-check` do, and the hub never calls them).
- The hub runs it with `ARCHIFY_UPDATE_CHECK_DISABLED=1`, so it never makes network calls.
- Used by `apps/hub/src/archify.ts` (`validate <type> <file> --quality showcase --json`, `render`).

## Updating

Clone the new tag, replace the directories listed above, re-run `npx vitest run apps/hub/test/archify.test.ts`,
and update the tag, commit and date here.
