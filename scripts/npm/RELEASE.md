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

`<x.y.z>` is strict SemVer with no `v` prefix. `release:stamp` writes `version` in `apps/cli`, `apps/desktop`, and `apps/local` `package.json`, and the matching `package-lock.json` workspace records. It then runs `node scripts/npm/check-tag.mjs v<x.y.z>` only. It does not commit, tag, or publish. If the three package versions already differ from each other, or any of their `package-lock.json` records is missing or differs, the command exits non-zero before it writes. A failed `check-tag` after a write restores those four files.

The image-version assertion joins in phase 2, when the compose template and its split assertions land. Until then `check-images` still requires the literal `image:` tags in `docker-compose.yml` to equal the package version. The stamp command does not edit that pin and does not run `check-images`. Update the pin in the same release commit.

`release:cut` reads `changelog.d/*.md`, checks each filename, and composes the fragments into `[Unreleased]` under Added, Changed, Fixed, Removed, and Security. Existing bullets in a category stay ahead of that category's fragments, and fragments in a category follow filename order. It then moves the merged entries into `## [<x.y.z>] - <local cut date>`, directly under an empty `[Unreleased]` heading. The date is the calendar day in the maintainer's local timezone when the command runs. It is the cut day, not the day the tag is pushed. Do not edit it later to match the publish timestamp. If the merged `[Unreleased]` section has no entries, the command refuses and leaves `CHANGELOG.md` and the fragments untouched. Consumed fragments are deleted only after that write succeeds.

Then write the ROADMAP record. Tag creation stays a separate maintainer step. Do not create a release tag from CI.

## Trusted publisher

Configured on the `@nema-project/nema` package. Validation is pending the first OIDC publish, which is tag `v0.1.4`.

- Repository: `Nema-Project/nema-room`
- Workflow filename: `npm-publish.yml`

## Automatic publish

Pushing a `v*` tag whose commit is on protected `main` runs `.github/workflows/npm-publish.yml`:

Do not create a tag unless that SHA's `CI` workflow on `main` has already succeeded. A missing, in-progress, cancelled, or failed run is not a tag candidate. Publication is still blocked by `verify.yml` on the tag SHA (a failure, cancellation, skip, or missing run cannot publish), not by a separate lookup of the `main` workflow run. A SHA whose full suite failed on `main` fails that same verify.

1. `verify.yml` must pass on that exact SHA.
2. The build job has no `id-token` permission. It runs `npm run cli:pack`, smokes the tarball, and uploads that tarball.
3. The publish job downloads the tarball. It does not check out the source, run `npm ci`, or build. It checks that the tag still points at the verified SHA, that the commit is an ancestor of `origin/main`, and that `node scripts/npm/check-tag.mjs` accepts the tag. It fetches the tag once more in that same step and aborts if the tag moved. It then runs `npm publish --provenance --access public` on `./` plus the downloaded tarball path. A stable tag uses the `latest` dist-tag. A prerelease tag uses `next` and does not move `latest`.

`workflow_dispatch` packs and smokes the tarball and does not publish.

## Fail closed

The publish job does not emit a package when any of these is true:

- `verify.yml` fails, is cancelled, or is skipped
- the tag no longer points at the verified SHA
- the tag commit is not an ancestor of `origin/main`
- `apps/cli`, `apps/desktop`, and `apps/local` versions differ, or they do not equal the tag
- the trusted publisher is missing or bound to a different workflow filename (the publish job fails)

Do not create a release tag from CI. Tag creation stays a separate maintainer step.
