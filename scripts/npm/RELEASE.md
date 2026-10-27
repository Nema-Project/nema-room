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
