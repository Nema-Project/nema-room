# Desktop release checklist

Desktop preview releases exist for Windows x64 and macOS ARM64. This checklist separates automated verification from native installation and upgrade acceptance.

## Rollout status and supported tags

**Release-assurance rollout commit:** `2cd05930c34e5bd601a578fbc01a97e28d08401c` (`ROLLOUT_COMMIT`). That is the merge of [PR #22](https://github.com/Nema-Project/nema-room/pull/22) onto `main` (2026-10-27T02:00:51Z), the first `main` commit whose desktop publication workflow calls `verify.yml` before packaging. Its tree is `693e2552f983397e6a1284f19d5624abd283e144`, the same tree as PR head `aa2accfaa84f45712947a89aa4aa302493816064`.

Full `verify.yml` for that tree succeeded in [CI run 40433303454](https://github.com/Nema-Project/nema-room/actions/runs/40433303454): classify, docs, workflow lint, macOS and Windows platform checks, full application tests and web build, and `CI gate` all succeeded. The run checked out the pull-request merge `6b1e984f2e586fd783226216d02586852ce5fa01` (`refs/pull/22/merge`). That commit has the same parents and the same tree as `2cd05930c34e5bd601a578fbc01a97e28d08401c`, and a different message, so it is not the main SHA. The main merge SHA has no GitHub Actions check runs: `ci.yml` does not run on push to `main`, and no `verify_full=true` rehearsal was dispatched on it. Nonpublishing desktop builds of the same head are [run 40433303492](https://github.com/Nema-Project/nema-room/actions/runs/40433303492): Windows NSIS smoke and macOS staged-runtime smoke succeeded; `verify` and Publish were skipped. URLs and the ruleset re-read are in [the evidence record](../../docs/reviews/2026-10-26-p0-release-assurance.md). Do not substitute another SHA.

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
- Assets: the Windows NSIS installer (`.exe`), a separate Windows portable ZIP (`.zip`), the macOS installer (`.dmg`), two per-target checksum files, combined `SHA256SUMS-<version>.txt`, and `release-manifest-<version>.json`. The ZIP is its own download of the unpacked app. It is not an archive that also contains the installer, and no macOS ZIP is published. Each Windows file has its own checksum entry.
- Windows automation installs and smokes the NSIS installer, then lists the portable ZIP, verifies its checksum, and extracts and launches it. macOS automation checks only the staged runtime; it does not prove DMG installation or Finder startup.
- The Windows and macOS platform job also runs a disposable data-directory upgrade and restore (chats, a thread, a work package, and knowledge Git history). On 2026-10-27 that step passed on both runners in [CI 40440137400](https://github.com/Nema-Project/nema-room/actions/runs/40440137400) (`ef87a29`): darwin arm64, Node v22.23.3, and win32 x64, Node v22.23.4, each 8/8. It does not install over an existing NSIS or DMG package. Local command after `npm ci`: `npx vitest run apps/hub/test/upgradeRecovery.test.ts --maxWorkers=1`.
- On 2026-10-27 the maintainer (NullumNomen) reported a manual overwrite install on macOS and on Windows. Workspace data remained on both. That report is separate from the hosted data-directory job and from first-install smoke.

## Before an authorized release

1. Verify rollout ancestry and successful complete CI/rehearsal for the intended commit. Record exact SHAs and run URLs.
2. Check versions, changelog, payload validation and supported asset set for both targets. Review unresolved [roadmap](../../ROADMAP.md) acceptance. P0-03 and P0-05 are recorded in the 2026-10-27 review. P0-04 data-directory checks passed on hosted Windows and macOS, and the maintainer reported a 2026-10-27 overwrite install on both platforms with workspace data intact.
3. Confirm the actual main ruleset requires the observed GitHub Actions `CI gate` and an up-to-date branch; YAML alone does not activate this setting.
4. Private vulnerability reporting was enabled by an administrator on 2026-10-27 at about 11:52 Asia/Tokyo. A read at 11:54 returned HTTP 200 `{"enabled":true}`, and the public security page links to the form when signed out. A signed-in collaborator with read permission, not an administrator, reached the form at 12:18 Asia/Tokyo. Test report GHSA-mgcq-mcqv-75ff was closed at 12:27 without publication and without a CVE. P0-05 is complete for that check. Never request sensitive public reports. Re-read with `node scripts/security/reporting-status.mjs`.
5. A person with release authorization creates the new tag on the verified commit. Do not automatically tag as part of CI testing.
6. After publication, verify anonymous downloads and hashes before announcing availability.

## Native installation checks

Windows installers are unsigned; macOS packages are ad-hoc signed and not notarized. Record actual OS prompts.

- Windows x64 installer: install with NSIS to default and spaced paths, launch, create a workspace, chat with a configured provider, quit from the tray, relaunch and confirm persistence. Uninstall and confirm data is preserved.
- Windows x64 portable ZIP: unzip `Nema-<version>-win32-x64.zip` and run `Nema.exe` from that folder. The archive root is the app directory (`Nema.exe` and `resources/`). It creates no desktop shortcut, no Start menu shortcut, and no uninstaller; delete the folder to remove that copy. User data still lives in `~/.nema/desktop` (`db/`, `data/`, `instance.json`), the same directory an NSIS install uses. Electron's ordinary per-user data directory is shared as well, because both builds use the same app id. A second launch while one copy is running connects to that core instead of opening another database. Uninstalling NSIS does not delete `~/.nema/desktop` and does not delete an extracted ZIP. Deleting the ZIP folder does not uninstall NSIS. These shortcut, uninstaller, and side-by-side data checks are manual; CI does not perform them.
- macOS ARM64: install via DMG, launch from Finder, handle the OS's explicit Open Anyway flow as needed, create a workspace, chat, quit and relaunch. Check background-process cleanup separately.
- Check bundled `Nema CLI` (`report install --help`) and browser launchers. Node is bundled; system Git 2.31+ is required.
- Upgrade/recovery acceptance uses disposable backed-up data and remains separate from first-install smoke. The 2026-10-27 maintainer report covers an overwrite install on macOS and Windows with workspace data intact. It does not record a failed installer restore. Back up `~/.nema/desktop` before another overwrite.

## Anonymous download and hash verification

1. Without an authenticated session, download every asset from the release page.
2. Confirm the Windows installer, the Windows portable ZIP, the macOS installer, two per-target checksum files, combined checksums and the release manifest. There is no macOS ZIP, and the Windows ZIP does not contain the installer.
3. Verify `sha256sum -c SHA256SUMS-<version>.txt`, macOS `shasum -a 256 -c ...`, or Windows `Get-FileHash -Algorithm SHA256` against the published list.
4. Confirm manifest commit/run identity and prerelease/latest status, then record the public URLs and results.
