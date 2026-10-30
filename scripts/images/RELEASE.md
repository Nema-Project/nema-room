# Hub and web image publication

Workflow file: `.github/workflows/image-publish.yml`. A pull request builds and smokes when it changes the Dockerfile, a Compose file, this workflow, or a non-Markdown file under `scripts/images/`. A Markdown-only change under `scripts/images/` does not start that build.

A push of a `v*` tag builds `linux/amd64` hub and web images, runs `.github/workflows/verify.yml` on that same commit, then copies the build job's OCI layout to GHCR with crane `0.22.1`. Image names:

- `ghcr.io/nema-project/nema-room-hub`
- `ghcr.io/nema-project/nema-room-web`

Do not create a tag unless that SHA's `CI` workflow on `main` has already succeeded. A missing, in-progress, cancelled, or failed run is not a tag candidate. Publication is still blocked by `verify.yml` on the tag SHA (a failure, cancellation, skip, or missing run cannot publish), not by a separate lookup of the `main` workflow run. A SHA whose full suite failed on `main` fails that same verify.

The version tag matches `apps/desktop`, `apps/local`, and `apps/cli`. Set those three package versions with `npm run release:stamp -- <version>` (see `scripts/npm/RELEASE.md`). That command's self-check is `check-tag`, the shape assertions on the compose template, and the version assertions on that template rendered at the new version. User-visible notes between releases live in `changelog.d/` fragments. `npm run release:cut -- <version>` composes them into `[Unreleased]` and deletes the consumed fragments only after that write succeeds. The `docker-compose.yml` in the repository tree is a template whose hub and web `image:` entries are `${NEMA_IMAGE_TAG:-latest}`, so the tree holds no publishable pin. The release asset is rendered from that template by `node scripts/images/stamp-compose.mjs <x.y.z>`, which pins both images to the release version; `image-publish.yml` and `desktop-release.yml` each validate the rendered asset in their own publication checks. `scripts/images/check-images.mjs` runs the shape assertions against the template and the version assertions against the asset. A prerelease does not move `latest`. `workflow_dispatch` builds and smokes the images locally and does not push.

Publish jobs share the concurrency group `image-publish-registry` and do not cancel each other. This workflow pushes only the two version tags. It does not move `latest`: `release-promote.yml` does that after npm and the whole release verify (see [scripts/npm/RELEASE.md](../npm/RELEASE.md#after-the-tag-workflows)). Promote moves a stable release's `latest` only when the `org.opencontainers.image.version` label on the current `latest` image is absent or older than or equal to this version, and stops when `latest` exists without a readable label. An older stable tag promoted later leaves `latest` where it is. The remote tag is checked again immediately before each version push.

The publish job's permissions are `contents: read` and `packages: write`. It does not build an image and does not run `npm ci`. The only registry credential is `GITHUB_TOKEN`. The repository stores no long-lived registry secret. BuildKit provenance (`mode=max`) and the SBOM travel inside the OCI index. The workflow does not request `id-token` or GitHub artifact attestations.

## Fail closed

Publication does not push when any of these is true:

- `verify.yml` did not succeed for that commit
- the tag moved after the triggering event
- the tag commit is not an ancestor of protected `main`
- the rendered asset's two image pins do not equal this release version
- either image exceeds the size budget enforced by `scripts/images/check-images.mjs` (800 MiB)
- the build job's smoke (`scripts/images/smoke-compose.mjs --pull never`) fails
- crane cannot push the layout

The tag is checked again with `scripts/desktop/release-commit.mjs --verify-remote` immediately before each image push. Promote checks it again before each `latest` move.

## After the tag workflows

When all three tag workflows have finished, run `npm run release:verify -- <x.y.z>` (see [scripts/npm/RELEASE.md](../npm/RELEASE.md#after-the-tag-workflows)). It reads both version tags anonymously and checks that the `linux/amd64` image's `org.opencontainers.image.version` label equals the version. The images carry no `org.opencontainers.image.revision` label, so it cannot compare an image to the tag commit. It is read-only and does not move `latest`; `release-promote` does.

## A push that stops halfway

This workflow never moves `latest`. If the web push fails after the hub push, `latest` is unchanged and the pair is incomplete. Re-run the same tag workflow. The remote tag check runs again before each push. If GHCR refuses to overwrite the hub version tag, delete that package version in the package settings and re-run. Do not point `latest` at only one of the two images.

If promote moves hub `latest` and then the web move fails, its summary lists hub as moved and web as not moved, and the Release stays a draft. Run `release-promote` again: a `latest` that already holds this version is recorded as done, and it will not move `latest` backward. There is no automatic rollback of a tag that already moved.

## One-time package visibility

The repository is public. The first Actions push can still create a private GHCR package. After that push, confirm both packages are public. If either package was created private, change it in the package settings on GitHub. Do not put a PAT in the repository or the workflow. Until the packages are public, the post-publish smoke job can still pull them because that job has `packages: read`.

The workflow token must be allowed to write packages. If the repository limits `GITHUB_TOKEN` to read, the publish job fails closed.
