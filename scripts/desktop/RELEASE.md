# Desktop release checklist

No desktop release is published yet. Nothing in this repository links to a download, and this checklist does not change that. Local workflow and script validation is not a published release.

## Publication is blocked

`.github/workflows/desktop-release.yml` runs `npm run desktop:validate-release` for every target payload before it creates anything. That validator fails closed: it rejects pending, unverified or mismatched source materials. Source-correspondence review (Task 7c) is not complete, and the source plan has no entries for the macOS targets, so the publish job will refuse today. Do not push a release tag until Task 7c is resolved and the validator passes locally for all three targets. Do not work around the gate.

## How the workflow behaves

- Ordinary push and pull request: build, package (`--publish never`) and smoke Windows x64, macOS arm64 and macOS x64 natively. Nothing is published.
- Push of a `v<SemVer>` tag: the same jobs, plus source-material collection, then one `publish` job (`contents: write`) that runs only when every target succeeded.
- The tag must be strict SemVer (`v1.2.3`, `v1.2.3-rc.1`, no build metadata) and equal the version in `apps/desktop/package.json` and `apps/local/package.json`. A hyphenated version is published as a prerelease and never as latest.
- Concurrency is scoped to the ref and never cancels a tag run, so a second attempt on the same tag waits.
- The publish job refuses a tag whose release is already published. A draft left by a failed attempt is reused only if it holds nothing but assets of this release; otherwise the job refuses.
- Assets per target: installer (`.exe` or `.dmg`), portable ZIP, and `SHA256SUMS-<version>-<target>.txt`. The publish job adds `SHA256SUMS-<version>.txt` and `release-manifest-<version>.json` (sizes, hashes, commit, run id).
- macOS packaged-app smoke is not automated: only the staged-payload runtime smoke runs there. Windows runs the packaged portable ZIP smoke.

## Before the first tag

1. Task 7c is complete and `npm run desktop:validate-release -- <payload> <platform-arch> <version>` prints `Release eligible` for `win32-x64`, `darwin-arm64` and `darwin-x64`.
2. The version in both package manifests is the intended first release version; no tag has been created for it.
3. The release commit is on the intended branch and the push/PR validation runs of `desktop-release.yml` are green for all three targets.
4. The tag is created intentionally, by a person, on that commit: `git tag v<version>` then `git push origin v<version>`. Never tag automatically.
5. After the run, the release is checked as below before anyone is told it exists.

## Native first-install checks

The installers are not notarized or Developer ID signed. Expect OS prompts and record what you actually saw.

- Windows x64: run the NSIS installer. SmartScreen will likely show "Windows protected your PC" (More info, Run anyway). Install to the default and to a path with spaces. Launch, create a workspace, send a chat with a configured provider, quit from the tray, relaunch and confirm data persisted. Uninstall and confirm user data is kept. Also unzip the portable ZIP and launch it.
- macOS arm64 and macOS x64 (one native machine each): open the DMG, drag the app to Applications. Gatekeeper will block an ad-hoc signed app downloaded from the web: use System Settings, Privacy and Security, Open Anyway (or right-click Open). Launch, create a workspace, chat, quit, relaunch and confirm persistence. Repeat once from the ZIP.
- On every machine confirm `Nema CLI` (`report install --help`) and the browser launcher run from the bundled payload, and that no host Node or Git is required.

## Anonymous download and hash verification

1. In a private browser window, or with `curl` and no token, open the release page and download every asset.
2. Confirm the asset list is exactly the three installers, three ZIPs, three per-target checksum files, `SHA256SUMS-<version>.txt` and `release-manifest-<version>.json`.
3. Verify hashes: `sha256sum -c SHA256SUMS-<version>.txt` (Linux), `shasum -a 256 -c SHA256SUMS-<version>.txt` (macOS), or compare `Get-FileHash -Algorithm SHA256 <file>` output on Windows with the listed values.
4. Confirm the release is marked prerelease only for hyphenated versions and is not latest in that case.
5. Only after this passes, record the public download URLs in the README and plan as live.
