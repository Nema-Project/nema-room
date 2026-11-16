# Multi-architecture Images Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The task forbids commits, pushes and PR creation; leave changes for supervisor review.

**Goal:** Publish hub/web version and latest indices containing linux/amd64 and linux/arm64, with native smoke evidence required before promotion.

**Architecture:** Two native build legs produce tested OCI archives. One serialized publisher pushes architecture tags, resolves their digests and combines them with imagetools. The shared anonymous registry reader validates both platform configs and preserves the top digest for crane promotion.

**Tech Stack:** Node 22, node:test, GitHub Actions, Buildx, native skopeo, crane 0.22.1.

**Spec:** [Multiarch design](../specs/2026-11-16-multiarch-images-design.md).

## Global Constraints

- Native amd64 `ubuntu-24.04`, arm64 `ubuntu-24.04-arm`; no QEMU.
- Max provenance and SBOM travel with the tested bytes. Each target/platform budget is 800 MiB.
- One `image-publish-registry` transaction; remote tag checked immediately before every push/assembly.
- Both version indices and both published Compose smoke legs succeed before promote; latest never moves backward.
- Promote tags the verified top digest, never a selected platform. Legacy ordering exception ends at 0.2.6.
- No commits, pushes, PRs, real user data, live models or real registry writes.

## Review Focus

- Existing amd64 latest at 0.2.6 must allow migration but must fail strict multiarch validation (Task 1).
- A nested or duplicate platform must not be silently selected (Task 1).
- Arm64 with a different version label or actual config architecture must fail (Task 1).
- Missing/skipped arm64 smoke must stop promote even when all listed jobs pass (Task 2).
- Failed second version publication must leave latest untouched; preserve the separate promote gate (Task 2).

---

### Task 1: Registry contract and consistency tests

**Files:** `scripts/images/check-images.mjs`, `scripts/images/check-images.test.mjs`, `scripts/release/registry-read.mjs`, `scripts/release/registry-read.test.mjs`, `scripts/release/fake-registry.fixture.mjs`, `scripts/release/verify-release.mjs`, `scripts/release/verify-release.test.mjs`.

**Interfaces:** Produce `assertMultiarchManifest(manifest): void`, CLI `--manifest <json-file>` and `--registry <version-or-latest>`. Extend `readImage(io, repository, reference, { allowLegacy = false } = {})` to produce top `digest`, `platforms` evidence map (digest, label, revision per platform), common `label`, and `legacy` boolean. Keep `platformDigest` for existing callers. `readPointers` alone opts into legacy reads, marking legacy pointer output.

- [ ] Add failing tests for OCI/Docker lists, missing/duplicate platforms, nested indices, config mismatch, inconsistent labels and strict-vs-legacy latest. Expected `ok` only with both valid platform configs; existing denied/broken/outage classifications remain.
- [ ] Run `node --test scripts/release/registry-read.test.mjs scripts/release/verify-release.test.mjs`; confirm new assertions fail before changing production code.
- [ ] Implement bounded traversal, shared manifest assertions, both CLI modes and verify output. Update fake registry to serve both configs with per-arch overrides.
- [ ] Run `node --test scripts/images/*.test.mjs scripts/release/registry-read.test.mjs scripts/release/verify-release.test.mjs`. Expected pass; record unavailable Docker-dependent checks explicitly.

### Task 2: Native workflow and promotion gate

**Files:** `.github/workflows/image-publish.yml`, `scripts/ci/workflows.test.mjs`, `scripts/images/multiarch-workflow.test.mjs`, `scripts/release/promote.mjs`, `scripts/release/promote.test.mjs`.

**Interfaces:** Consume Task 1 strict validation. Matrix job names are `Build and smoke images (amd64|arm64)` and `Pull published images (amd64|arm64)`; artifact names `nema-image-layouts-amd64|arm64`. Publisher remains one job named `Publish images`; promote requires all five jobs plus plan and verify jobs.

- [ ] Add workflow matrix assertions and executable shell stubs proving tag recheck precedes each write, digest sources feed assembly, and failure stops before assembly. Add promote tests for absent/failed architecture legs. Run their Node tests and confirm new cases fail.
- [ ] Implement native build/smoke matrices. Install skopeo using apt on build runners; copy `oci-archive:` to `docker-daemon:`, inspect architecture and size, smoke with `--pull never`. Archive separately.
- [ ] Publisher downloads both archives into arch subdirectories, unwraps the single-child OCI envelope with `flattenOciLayout(root): Promise<void>` / `--flatten-layout <directory>` without altering blobs, pushes arch suffixes with crane, stores digests, rechecks tag then assembles each version via imagetools and validates with `--registry`. Published matrix asserts native pulled image architecture and smokes `--pull always`.
- [ ] Update exact job lists and workflow tests without weakening existing verify/tag/latest safety assertions. Keep `crane tag repository@digest latest` and its digest recheck.
- [ ] Run `node --test scripts/images/*.test.mjs scripts/release/*.test.mjs scripts/ci/*.test.mjs scripts/desktop/release-commit.test.mjs`; expected pass except explicitly reported missing host prerequisites. Run actionlint if installed.

### Task 3: Documentation and final verification

**Files:** `README.md`, `README.en.md`, `README.zh.md`, `README.ja.md`, `docs/guide.en.md`, `docs/guide.zh.md`, `docs/guide.ja.md`, `scripts/images/RELEASE.md`, `ROADMAP.md`, `changelog.d/multiarch-images.added.md`.

- [ ] Replace amd64-only install claims with both architectures for newly produced releases, keeping historical releases and version matching accurate in all languages. Explain assembly, migration and recovery in the runbook.
- [ ] Mark P2-08 in progress with spec/plan links and pending native/GHCR evidence. Write exactly one English changelog bullet beginning `- ` about hub/web supporting both platforms.
- [ ] Run docs-check on changed Markdown, `cmp README.md README.en.md`, `git diff --check`, and review final diff. Expected no errors.
- [ ] Report commands/results and unverified native arm64 runner, archive-copy, GHCR manifest/anonymous pull and pointer behavior. Do not claim CI, publication or native acceptance.

## Execution evidence (2026-11-16)

Implementation is present in the working tree; no commit, push or PR was made. No blocking D-items were found. The first registry assertions failed before implementation; the workflow matrix/assembly tests also failed against the original workflow. Review found an inherited-platform mismatch in nested indices; its reproducer failed before the fix and passes afterward. No other important review findings remained.

Pre-flight interface review: Task 1 supplies strict platform/index evidence and the top digest consumed by Task 2. Task 2 preserves the publication/job names consumed by promote; exact-name tests now expand both matrix legs. Task 3 documents these contracts. No conflicting interfaces were found.

Implementation clarification: before architecture publication, `flattenOciLayout(root)` removes the OCI layout's single-child index envelope. Image configs, layers, SBOMs and attestation blobs remain unchanged. Without this, assembly could expose two unlabelled child indices rather than directly selectable platform descriptors. The spec and Task 2 were updated to make this explicit.

Validation commands and outcomes:

- `node --test scripts/release/registry-read.test.mjs scripts/release/verify-release.test.mjs`: the normal isolated runner could not launch child processes in this sandbox. Tests were rerun with Node 24's `--test-isolation=none`; no test assertions were weakened to accommodate the host.
- `node --test --test-isolation=none scripts/images/*.test.mjs scripts/release/*.test.mjs scripts/ci/*.test.mjs scripts/desktop/release-commit.test.mjs`: 289 tests, 274 passed, 15 failed in child-process or Docker-dependent checks. This is not a green suite.
- `node --test --test-isolation=none --test-skip-pattern='publication shell|CLI arguments' scripts/images/multiarch-workflow.test.mjs scripts/release/promote.test.mjs scripts/release/registry-read.test.mjs scripts/release/verify-release.test.mjs`: 111 selected tests passed. Two process-dependent tests were deliberately excluded from this selected run; they remain reported as failures in the full run.
- `node --test --test-isolation=none --test-name-pattern='image publish pushes|promote requires every' scripts/ci/workflows.test.mjs`: both selected workflow/promotion gate tests passed.
- The publication shell itself was additionally executed through a Python temporary-fixture harness using the workflow's actual run block: success, moved-tag refusal, and second-target push failure all passed. Every write followed tag verification; assembly consumed recorded digests; no latest write occurred. This is stubbed shell evidence, not GHCR evidence.
- Workflow YAML parsed successfully; `bash -n` passed all 13 run blocks. `actionlint` was not installed. Docker was not installed, so no container builds or Compose smoke were run.
- `node scripts/images/check-images.mjs --manifest /tmp/nema-multiarch-manifest.json`, `node scripts/images/check-images.mjs`, and `node --check` on the four changed production scripts passed.
- `node scripts/ci/docs-check.mjs /tmp/multiarch-doc-paths.json`: zero errors. `cmp README.md README.en.md` and `git diff --check` passed. The docs checker does not validate remote URLs or anchors; existing guide anchors were retained.

Full-run failures, retained rather than suppressed:

- `scripts/ci/changes.test.mjs`: complete NUL-delimited diff; docs-only PR behind main (Git child processes denied with EPERM).
- `scripts/ci/startup-sample.test.mjs`: explicit-home usage check (Node child output unavailable).
- `scripts/desktop/release-commit.test.mjs`: release resolver (Git child denied with EPERM).
- `scripts/images/check-images.test.mjs`: latest move CLI; repository version CLI (Node child output unavailable); ports/hub URL and private web bind (Docker unavailable).
- `scripts/images/multiarch-workflow.test.mjs`: publication shell (Node's bash child denied with EPERM; separate shell fixture passed as described above).
- `scripts/images/stamp-compose.test.mjs`: check, stdout and file modes (Node child output unavailable).
- `scripts/release/cut-changelog.test.mjs`: repository changelog / bad argument (Node child output unavailable).
- `scripts/release/stamp-version.test.mjs`: usage errors (Node child output unavailable).
- `scripts/release/verify-release.test.mjs`: CLI arguments (Node child output unavailable).

The pre-existing local `yaml@2.9.1` dependency contained a zero-byte parser module. Its ignored installation was restored from the same-version primary checkout; no dependency manifest or lockfile changed. Native arm64 behavior, hosted skopeo archive loading, GHCR manifest assembly, anonymous pulls, and actual latest promotion remain unverified. ROADMAP P2-08 stays in progress.
