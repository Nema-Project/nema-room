# npm release checklist

The package name is `@nema-project/nema`. The command name is `nema`. `npm pack` writes `dist-npm/nema-project-nema-<version>.tgz`. The workflow file is `.github/workflows/npm-publish.yml`. That filename is part of the npm trusted-publisher binding. Rename it only after the npm setting is updated to the new filename.

The repository does not store an npm token. Publication uses trusted publishing (OIDC) and `npm publish --provenance --access public`.

## First publish

Done on 2026-10-27. A maintainer published `@nema-project/nema@0.1.3` with their own npm account. That manual publish was a one-time exception. Nothing was published under the unscoped name `nema`. Do not publish again from a local npm login. Later versions, starting with `v0.1.4`, publish through the trusted publisher below.

The npm org `nema-project` already existed, and the publisher's npm account was a member of that org. Source checkouts update with the repository, so there is no previously published daemon that still prints `npm i -g nema@<version>`.

The commands below are the record of that publish, from a clean checkout of the release commit, with Node.js 22 or later:

```sh
npm run cli:pack
npm publish --access public ./dist-npm/nema-project-nema-0.1.3.tgz
npx @nema-project/nema@0.1.3 --version
```

If npm prompts for two-factor authentication, the same publish is run again with `--otp <code>`:

```sh
npm publish --access public --otp <code> ./dist-npm/nema-project-nema-0.1.3.tgz
```

Keep the `./` prefix on the tarball path. `npm run cli:pack` builds `apps/cli` and writes `dist-npm/nema-project-nema-<version>.tgz`. The printed version must equal `apps/cli/package.json`. Then confirm the three release manifests match that tag:

```sh
node scripts/npm/check-tag.mjs v0.1.3
```

`check-tag.mjs` fails when the tag is not `v` plus strict SemVer, or when `apps/cli`, `apps/desktop`, and `apps/local` are not equal to each other and to the tag.

## Release preparation

Feature pull requests record user-visible notes as `changelog.d/<slug>.<category>.md` fragments (`category` is `added`, `changed`, `fixed`, `removed`, or `security`). Those fragments are the source of truth between releases. Do not edit `## [Unreleased]` directly. When the fragments are complete, set the release version from the repository root:

```sh
npm run release:stamp -- <x.y.z>
npm run release:cut -- <x.y.z>
```

`<x.y.z>` is strict SemVer with no `v` prefix. `release:stamp` writes `version` in `apps/cli`, `apps/desktop`, and `apps/local` `package.json`, and the matching `package-lock.json` workspace records. It then runs its self-check, and it does not commit, tag, or publish. If the three package versions already differ from each other, or any of their `package-lock.json` records is missing or differs, the command exits non-zero before it writes. A failed self-check after a write restores those four files.

The self-check is `node scripts/npm/check-tag.mjs v<x.y.z>`, the shape assertions on the compose template, and the version assertions on that template rendered at `<x.y.z>`. `release:stamp` still does not edit or generate any compose file. The repository's `docker-compose.yml` is a template with `${NEMA_IMAGE_TAG:-latest}` in both `image:` entries, so no release commit changes an image tag in that file; the asset attached to the release is rendered from that template by `node scripts/images/stamp-compose.mjs <x.y.z>`.

`release:cut` reads `changelog.d/*.md`, checks each filename, and composes the fragments into `[Unreleased]` under Added, Changed, Fixed, Removed, and Security. Existing bullets in a category stay ahead of that category's fragments, and fragments in a category follow filename order. It then moves the merged entries into `## [<x.y.z>] - <local cut date>`, directly under an empty `[Unreleased]` heading. The date is the calendar day in the maintainer's local timezone when the command runs. It is the cut day, not the day the tag is pushed. Do not edit it later to match the publish timestamp. If the merged `[Unreleased]` section has no entries, the command refuses and leaves `CHANGELOG.md` and the fragments untouched. Consumed fragments are deleted only after that write succeeds.

Then write the ROADMAP record. Tag creation stays a separate maintainer step. Do not create a release tag from CI.

## Trusted publisher

Configured on the `@nema-project/nema` package. Validation is pending the first OIDC publish, which is tag `v0.1.4`.

- Repository: `Nema-Project/nema-room`
- Workflow filename: `npm-publish.yml`

## Automatic publish

Pushing a `v*` tag whose commit is on protected `main` runs `.github/workflows/npm-publish.yml`. The tag push verifies, packs, and smokes. It does not publish. Publishing waits for `release-promote` (see [After the tag workflows](#after-the-tag-workflows)):

Do not create a tag unless that SHA's `CI` workflow on `main` has already succeeded. A missing, in-progress, cancelled, or failed run is not a tag candidate. Publication is still blocked by `verify.yml` on the tag SHA (a failure, cancellation, skip, or missing run cannot publish), not by a separate lookup of the `main` workflow run. A SHA whose full suite failed on `main` fails that same verify.

1. `verify.yml` must pass on that exact SHA.
2. The build job has no `id-token` permission. It runs `npm run cli:pack`, smokes the tarball, and uploads that tarball as the `nema-tarball` artifact (kept 5 days). That artifact is the one that gets published; nothing is packed again.
3. `release-promote` dispatches `npm-publish.yml` on the tag with `promote_run_id` and `expected_integrity`. That dispatch skips verify and build. The publish job checks that `promote_run_id` is an in-progress `release-promote.yml` run on `main` titled `Release promote <tag>` for this same tag, whose `Candidate preflight` step succeeded, and that the tag's push run of this workflow succeeded on the same commit with its verify and build jobs. It downloads that push run's `nema-tarball` and refuses a tarball whose `sha512` is not `expected_integrity`. It does not check out the source, run `npm ci`, or build; every artifact file other than the tarball (the release scripts it runs and the package manifests) must be byte-identical to the file in the tag commit before any of it runs. It checks that the tag still points at the dispatched SHA, that the commit is an ancestor of `origin/main`, and that `node scripts/npm/check-tag.mjs` accepts the tag. `scripts/release/npm-state.mjs` then asks the registry for that exact version: already there with the same integrity ends the job as done, there with another integrity fails, and an unanswered query fails. It re-reads the channel dist-tag first: a stable version older than the current `latest` publishes under `maintenance` instead of `latest` (and is refused when `maintenance` already holds a newer version; a dist-tag value that is not a release version stops the job), and a prerelease older than the current `next` is refused (promote refuses it before dispatching, too). It fetches the tag once more in that same step and aborts if the tag moved, then runs `npm publish --provenance --access public` on `./` plus the downloaded tarball path. A stable tag uses `latest` (or `maintenance`). A prerelease tag uses `next` and does not move `latest`. A publish that fails counts as done only when the registry then holds the same integrity. Publish jobs share the concurrency group `npm-publish-registry` and do not cancel each other.

`workflow_dispatch` without `promote_run_id` packs and smokes the tarball and does not publish.

## After the tag workflows

When `npm-publish`, `image-publish`, and `desktop-release` have all finished for a tag, run the read-only check and record its output, including the exit code, in that version's ROADMAP entry:

```bash
npm run release:verify -- <x.y.z>
npm run release:verify -- --pointers <x.y.z>
```

Then promote it from `main`:

```bash
gh workflow run release-promote.yml --ref main -f tag=v<x.y.z>
```

`release-promote` runs only for a dispatcher (and re-runner) with the `maintain` or `admin` role: a first job without write permissions checks that, the job holding the write token starts only after it passes, and that job repeats the check as its first step, since re-running a failed promote job reuses the earlier check. It runs `main`'s scripts and never executes files from the tag commit. It resolves the tag commit through the API and requires it to be on `main`. `Candidate preflight` first requires the newest `image-publish` and `desktop-release` push runs of the tag commit to have succeeded with every job passed, each required job and matrix leg by its exact name, including `Pull published images` and one desktop `Build and smoke` job per release target (verify-release cannot see those smokes). Promote checks those runs again right before it publishes the draft Release, so a desktop-release rerun in progress stops it. It then runs `verify-release --stage candidate` with the integrity of the tag push run's `nema-tarball`: npm may still be absent, everything else must be complete. Then `scripts/release/promote.mjs` publishes npm (dispatch above, then waits for it), runs `verify-release --stage final`, moves the hub and web GHCR `latest` tags to the index digests that final verify read (refusing if a version tag changed since), and publishes the draft Release, marking it latest only when no newer stable Release is latest. A write whose command fails is read back; it counts as done only if the pointer now holds this version. It re-reads each pointer before it moves it, never moves one backwards, and checks the tag again before every write. Any missing or unknown answer stops it, and later pointers stay where they were. The step summary lists what moved and what did not. npm goes first by design (trusted publishing cannot move a dist-tag after the fact, and final verify needs the npm version): from the npm publish until promote finishes, npm `latest` already serves the new version while GHCR `latest` and the GitHub Release still serve the previous one, and if promote stops in between, that mixed window lasts until the rerun. Run it again after fixing the cause: steps already done are recognized and skipped, and a published stable Release that should be latest but is not is marked latest. An npm version already published while its dist-tag points at an older version stops promote, because trusted publishing cannot move a dist-tag: the summary names the `npm dist-tag add` command for a maintainer. Promote runs one at a time (concurrency group `release-promote`). GitHub keeps only one pending run per group, so promote one release at a time: a second dispatch while one is pending replaces it, the replaced run shows as cancelled, and promoting that tag again is safe. A prerelease touches no stable pointer: npm `next`, and a Release published as a non-latest prerelease. The push-run artifact expires after 5 days; after that, promote stops at its first step and names the expired artifact.

`release:verify` checks four items: the npm version and its integrity (with the provenance the registry reports, whose signature it does not verify), anonymous GHCR access to both version tags and their `linux/amd64` version labels, the GitHub Release asset set against the set derived from `scripts/desktop/release-manifest.mjs` (including `docker-compose.yml` and its hash and pin), and that the versions and the tag, release-manifest and npm-provenance commits agree. Exit 0 means every artifact exists and agrees. It is not a test, smoke, or acceptance result. Exit 1 names the missing or disagreeing item: that is a partial release to fix. Exit 2 means some answer was unavailable (timeout, 5xx, or a Release hidden from an anonymous reader). Run it again later, or with `GITHUB_TOKEN` set to see a draft. Do not treat exit 2 as missing or as ready. `--pointers` prints where `latest` points now and what a promotion would do. It moves nothing. Before promote, the three workflows leave npm unpublished, both GHCR `latest` tags unmoved, and the Release a draft, so the public install entry keeps serving the previous version. So the run before promote (default `--stage final`, with `GITHUB_TOKEN` set so the draft is visible) is expected to exit 1 with npm as the only missing item: that is the state promote starts from, not a partial release. Any other missing item, or an npm version that is already there, is a problem to fix first. promote's `Candidate preflight` runs `--stage candidate --expected-integrity <sha512 of the push-run tarball>`, which accepts npm being absent. Run `release:verify` again after promote: it should exit 0, and `--pointers` should show the new version.

## Fail closed

The publish job does not emit a package when any of these is true:

- the run was not dispatched by a live `release-promote` run for this tag past its `Candidate preflight`
- the tag's push run, or its verify or build job, did not succeed on that commit
- the push-run tarball's `sha512` is not the integrity `release-promote` expected
- the registry already holds a different tarball for that version, or cannot be read
- the tag no longer points at the verified SHA
- the tag commit is not an ancestor of `origin/main`
- `apps/cli`, `apps/desktop`, and `apps/local` versions differ, or they do not equal the tag
- the trusted publisher is missing or bound to a different workflow filename (the publish job fails)

Do not create a release tag from CI. Tag creation stays a separate maintainer step.
