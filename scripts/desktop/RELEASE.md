# Desktop release checklist

Desktop preview releases exist for Windows x64 and macOS ARM64. This checklist separates automated verification from native installation and upgrade acceptance.

## Rollout status and supported tags

**Release-assurance rollout is not activated yet.** After the reviewed implementation is merged, record its actual main deployment SHA and successful verification/rehearsal runs in [the evidence record](../../docs/reviews/2026-10-26-p0-release-assurance.md). Do not use a placeholder SHA or create a release tag before that checkpoint.

GitHub executes the workflow stored in the tagged commit. New safeguards cannot protect earlier commits retroactively. Supported release targets must descend from the recorded rollout commit and be reachable from `origin/main`; pre-rollout tags are unsupported. Historical releases are unchanged. This is not an organization-wide immutable policy against writers changing workflows.

Before intentionally creating any tag, fetch main and check both ancestry relations, substituting the **recorded real SHAs**:

```sh
git fetch origin main
git merge-base --is-ancestor "$ROLLOUT_COMMIT" "$RELEASE_COMMIT"
git merge-base --is-ancestor "$RELEASE_COMMIT" origin/main
```

Both commands must exit 0. `ROLLOUT_COMMIT` must come from the deployment evidence, never an arbitrary older commit. Tag creation and publication require separate authorization.

## Publication gate

The tag preflight resolves lightweight or annotated tags, rejects a moved tag and off-main commits, and records one immutable commit. The reusable `verify.yml` suite checks that exact SHA before expensive builds. Failed, cancelled, skipped or missing required verification blocks both tag builds and publication. Build and publish checkouts use that same SHA, and release metadata is checked against it. The remote tag is re-fetched before draft operations and immediately before making the release public; movement or deletion fails closed. GitHub has no atomic tag-compare/publication operation, so deliberate concurrent writer interference is outside this workflow guarantee.

The complete Windows/macOS platform checks and Ubuntu application tests, web build and Compose checks are retained. Existing version/changelog preflight, payload/license/source validation, asset hashes, draft handling and refusal to overwrite a published release remain required. `desktop:validate-release` must report `Release eligible` for both targets. Node (MIT), Inter and JetBrains Mono (OFL), and Electron ffmpeg (LGPL) retain their notices; ffmpeg remains a separate library. Do not bypass any validator.

## Workflow behavior and safe rehearsal

- Branch pushes do not run desktop builds. PRs touching `apps/desktop/` or `scripts/desktop/` build both targets without publication. Workflow/lockfile-only changes use CI and an explicit rehearsal.
- Manual runs build selected targets and **never publish, including dispatches on tags**. Set `verify_full=true` for complete verification before packaging:

  ```sh
  gh workflow run desktop-release.yml --ref <reviewed-branch> -f target=all -F verify_full=true
  ```

  GitHub may require the workflow on the default branch before this input is available. Record a deferred rehearsal instead of creating a release tag. Manual rehearsals do not run tag-only source collection or publication payload/asset validation; record this limit separately. Normal manual builds default to `verify_full=false`; `target` may be `all`, `win32-x64` or `darwin-arm64`.
- Only a push of a strict `v<SemVer>` tag can publish. Version must equal both desktop/local manifests and have changelog notes; no build metadata. Hyphenated versions are prereleases and never latest.
- Tag runs build both targets and collect source materials; publication additionally validates every payload and asset. Only publish receives `contents:write`. Verification is read-only and uses no secrets.
- Concurrency is scoped to each workflow/ref; tag runs are never cancelled by superseded PR runs.
- Existing published releases are never overwritten. A previous draft is reused only if its assets belong to this release.
- Assets: two installers (`.exe`, `.dmg`), two per-target checksum files, combined `SHA256SUMS-<version>.txt`, and `release-manifest-<version>.json`. No portable ZIP is published.
- Windows automation installs and smokes the NSIS installer. macOS automation checks only the staged runtime; it does not prove DMG installation, Finder startup, or in-place installer overwrite.
- The Windows and macOS platform job also runs a disposable data-directory upgrade and restore (chats, a thread, a work package, and knowledge Git history). On 2026-10-27 that step passed on both runners in [CI 40440137400](https://github.com/Nema-Project/nema-room/actions/runs/40440137400) (`ef87a29`): darwin arm64, Node v22.23.3, and win32 x64, Node v22.23.4, each 8/8. It does not install over an existing NSIS or DMG package. Local command after `npm ci`: `npx vitest run apps/hub/test/upgradeRecovery.test.ts --maxWorkers=1`.

## Before an authorized release

1. Verify rollout ancestry and successful complete CI/rehearsal for the intended commit. Record exact SHAs and run URLs.
2. Check versions, changelog, payload validation and supported asset set for both targets. Review unresolved [roadmap](../../ROADMAP.md) acceptance, including P0-03. P0-05 is recorded in the 2026-10-27 review. P0-04 data-directory checks passed on hosted Windows and macOS; installer overwrite remains open.
3. Confirm the actual main ruleset requires the observed GitHub Actions `CI gate` and an up-to-date branch; YAML alone does not activate this setting.
4. Private vulnerability reporting was enabled by an administrator on 2026-10-27 at about 11:52 Asia/Tokyo. A read at 11:54 returned HTTP 200 `{"enabled":true}`, and the public security page links to the form when signed out. A signed-in collaborator with read permission, not an administrator, reached the form at 12:18 Asia/Tokyo. Test report GHSA-mgcq-mcqv-75ff was closed at 12:27 without publication and without a CVE. P0-05 is complete for that check. Never request sensitive public reports. Re-read with `node scripts/security/reporting-status.mjs`.
5. A person with release authorization creates the new tag on the verified commit. Do not automatically tag as part of CI testing.
6. After publication, verify anonymous downloads and hashes before announcing availability.

## Native installation checks

Windows installers are unsigned; macOS packages are ad-hoc signed and not notarized. Record actual OS prompts.

- Windows x64: install with NSIS to default and spaced paths, launch, create a workspace, chat with a configured provider, quit from the tray, relaunch and confirm persistence. Uninstall and confirm data is preserved.
- macOS ARM64: install via DMG, launch from Finder, handle the OS's explicit Open Anyway flow as needed, create a workspace, chat, quit and relaunch. Check background-process cleanup separately.
- Check bundled `Nema CLI` (`report install --help`) and browser launchers. Node is bundled; system Git 2.31+ is required.
- Upgrade/recovery acceptance uses disposable backed-up data and remains separate from first-install smoke. Quit the tray, back up `~/.nema/desktop`, install the new package over the old one, launch, and check chats, threads, work packages, and knowledge Git history. Separately restore that backup after a simulated failure. The hosted data-directory job does not replace this installer overwrite check.

## Anonymous download and hash verification

1. Without an authenticated session, download every asset from the release page.
2. Confirm exactly two installers, two per-target checksum files, combined checksums and the release manifest.
3. Verify `sha256sum -c SHA256SUMS-<version>.txt`, macOS `shasum -a 256 -c ...`, or Windows `Get-FileHash -Algorithm SHA256` against the published list.
4. Confirm manifest commit/run identity and prerelease/latest status, then record the public URLs and results.
