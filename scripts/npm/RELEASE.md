# npm release checklist

The package name is `nema`. The command name is `nema`. The workflow file is `.github/workflows/npm-publish.yml`. That filename is part of the npm trusted-publisher binding. Rename it only after the npm setting is updated to the new filename.

The repository does not store an npm token. Publication uses trusted publishing (OIDC) and `npm publish --provenance --access public`.

## First publish

Before a trusted publisher exists, a maintainer publishes one working version with their own npm account. Do not publish an empty placeholder. This manual publish is a one-time exception. It closes once the trusted publisher below is configured. After that, do not publish from a local npm login.

From a clean checkout of the release commit, with Node.js 22 or later:

```sh
npm run cli:pack
npm publish --access public ./dist-npm/nema-<version>.tgz
npx nema@<version> --version
```

`npm run cli:pack` builds `apps/cli` and writes the tarball under `dist-npm/`. The printed version must equal `apps/cli/package.json`. Then confirm the three release manifests match that tag:

```sh
node scripts/npm/check-tag.mjs v<version>
```

`check-tag.mjs` fails when the tag is not `v` plus strict SemVer, or when `apps/cli`, `apps/desktop`, and `apps/local` are not equal to each other and to the tag.

## Trusted publisher

On the npm package `nema`, add a trusted publisher for this repository:

- Repository: `Nema-Project/nema-room`
- Workflow filename: `npm-publish.yml`

## Automatic publish

Pushing a `v*` tag whose commit is on protected `main` runs `.github/workflows/npm-publish.yml`:

1. `verify.yml` must pass on that exact SHA.
2. The build job has no `id-token` permission. It runs `npm run cli:pack`, smokes the tarball, and uploads that tarball.
3. The publish job downloads the tarball. It does not check out the source, run `npm ci`, or build. It checks that the tag still points at the verified SHA, that the commit is an ancestor of `origin/main`, and that `node scripts/npm/check-tag.mjs` accepts the tag. It fetches the tag once more in that same step and aborts if the tag moved. It then runs `npm publish --provenance --access public` on the downloaded tarball. A stable tag uses the `latest` dist-tag. A prerelease tag uses `next` and does not move `latest`.

`workflow_dispatch` packs and smokes the tarball and does not publish.

## Fail closed

The publish job does not emit a package when any of these is true:

- `verify.yml` fails, is cancelled, or is skipped
- the tag no longer points at the verified SHA
- the tag commit is not an ancestor of `origin/main`
- `apps/cli`, `apps/desktop`, and `apps/local` versions differ, or they do not equal the tag
- the trusted publisher is missing or bound to a different workflow filename (the publish job fails)

Do not create a release tag from CI. Tag creation stays a separate maintainer step.
