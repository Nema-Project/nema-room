# Multi-architecture hub and web images

## Purpose and scope

Implement [issue #50](https://github.com/Nema-Project/nema-room/issues/50) with native Linux builds and smoke tests. Under the [product north star](https://github.com/Nema-Project/nema-room/issues/45), this removes an installation barrier to the shared project knowledge while retaining evidence about which artifact was tested. It adds no product integration or acceptance claim.

The issue and task have already chosen native `ubuntu-24.04-arm`, per-architecture build → smoke → push, and a combined version manifest. No emulation or image rebuild in the publishing job. Desktop packaging, npm, application behavior and existing published versions are out of scope.

## Current evidence

At `f21843e`, `image-publish.yml` builds one amd64 OCI archive per target, smokes those bytes through a disposable local registry, then a serialized publishing job uses crane 0.22.1 to push the version tags. Only release-promote moves latest. The registry reader follows one unlabelled child index and reads only the amd64 config. Verify-release reports the platform image digest but retains the top digest. Promote already checks that the version tag still resolves to that top digest and uses `crane tag repository@digest latest`; it must continue doing so without platform selection.

## Design

### Native builds and evidence

Build and post-publication smoke jobs each have two explicit matrix entries: `amd64` on `ubuntu-24.04`, and `arm64` on `ubuntu-24.04-arm`, with fail-fast disabled. Build only `linux/${arch}` and assert the host and loaded image architecture. Keep BuildKit max provenance, SBOM, and the 800 MiB budget for each target on each architecture. Archive artifacts include the architecture in their name.

Use the runner distribution's native `skopeo` to copy the exact OCI archive into Docker's image store for the pre-publication Compose smoke (`--pull never`). This removes the build runner's x86-only crane download and local registry dependency. The publishing job still installs the existing checksum-pinned x86 crane and holds the only package-write token. It downloads both tested artifacts, pushes each to `:<version>-amd64` or `:<version>-arm64`, and records each registry digest. Before pushing, remove only the layout's single-child index envelope so assembly receives a platform index; image and attestation blobs remain unchanged. It builds no images.

### Assembly and pointer safety

Keep `image-publish-registry` serialization across the entire publication transaction. Revalidate the remote Git tag immediately before every architecture push and every version-manifest write. Assemble each version using `docker buildx imagetools create` from the recorded repository@digest sources, flattening their platform and attestation descriptors. Validate the resulting version manifest. Both hub and web version manifests must exist and pass validation before the publish job succeeds. Partial failure leaves latest unchanged; rerun the same tag to finish. No automatic rollback or new version immutability policy.

Image publishing never writes latest. Promote requires both native build jobs, both published-image smoke jobs, verification, and publication to have succeeded. Its final verification checks both version indices before either latest move. Keep the remote tag recheck, fresh pointer read, monotonic SemVer comparison, version-digest recheck, and `crane tag` of the verified top digest. Never use `--platform` on digest/tag or copy a platform child to latest. Post-move pointer rereads must validate both architectures and the same top digest. Stable tags only move stable pointers; prereleases retain their current behavior.

### Registry validation

`check-images.mjs` exports `assertMultiarchManifest(manifest)` for OCI indices and Docker manifest lists, requiring linux/amd64 and linux/arm64 descriptors. Ignore unknown/unknown attestation descriptors; reject single images, missing platforms and duplicate required platforms. Add `--manifest <json-file>` and `--registry <version-or-latest>`; the latter uses the anonymous release registry reader to validate both repositories, their platform configs, and matching version labels.

`registry-read.mjs:readImage` walks bounded nested indices (maximum three index levels), retaining the top digest and collecting platform leaf descriptors. Read both platform configs and require actual config OS/architecture to agree with descriptors; require their version labels to agree. Missing children/configs are missing evidence, transport or unparsable answers are unknown. Verify-release checks these indices for the candidate version; its output names both platforms and top digests. Registry validation of latest uses the same strict reader. These checks are artifact consistency, not passing tests or acceptance.

Compatibility: existing releases through 0.2.6 are not retroactively multi-arch. Only pointer-ordering reads may accept their existing amd64-only index with a readable strict SemVer label at most 0.2.6, explicitly marked legacy in evidence/output. A version candidate, strict latest registry check, or a newer latest never gets this exception. This allows the first migration without guessing that an unreadable current pointer is absent. No old artifacts are rewritten.

### Documentation and recovery

Update the four READMEs and three guides without claiming historical releases gained arm64. Describe architecture support for releases produced by the new workflow and automatic Docker platform selection; retain version matching with the host daemon. Update the image release runbook, add the requested single-bullet changelog, and mark ROADMAP P2-08 in progress pending native runner and registry evidence.

## Maintainer decisions

No blocking D-items. Native runners, the build/smoke/push ordering and pointer safety are specified by the task. Choosing imagetools, distribution skopeo and a bounded legacy ordering read are implementation/compatibility details; they neither authorize publication nor change release ordering.

## Acceptance and limits

- Fixture tests reject missing/duplicate platforms, wrong config architecture, disagreeing labels, broken children, and attestations masquerading as executable images. Exercise OCI and Docker lists plus nested layouts.
- Workflow tests require both native legs, unique artifacts, digest-bound assembly and revalidation before writes; promote tests require every matrix leg and retain moved-tag, backward-pointer and partial-failure cases.
- Run images/release Node tests, CI policy/workflow tests and release-commit tests; actionlint if available; docs links and English parity checks.
- Actual arm64 builds and Compose runs, skopeo archive loading on hosted runners, GHCR assembly/anonymous pulls and real latest moves require CI or a release rehearsal. Local fixture tests do not prove them. No push, commit or PR in this task.

Implementation references: [Buildx imagetools create](https://docs.docker.com/reference/cli/docker/buildx/imagetools/create/) and [crane 0.22.1 index source](https://github.com/google/go-containerregistry/blob/v0.22.1/cmd/crane/cmd/index.go).
