# Hub and web image publication

Workflow file: `.github/workflows/image-publish.yml`.

A push of a `v*` tag builds `linux/amd64` hub and web images, runs `.github/workflows/verify.yml` on that same commit, then copies the build job's OCI layout to GHCR with crane `0.22.1`. Image names:

- `ghcr.io/nema-project/nema-room-hub`
- `ghcr.io/nema-project/nema-room-web`

Do not create a tag unless that SHA's `CI` workflow on `main` has already succeeded. A missing, in-progress, cancelled, or failed run is not a tag candidate. Publication is still blocked by `verify.yml` on the tag SHA (a failure, cancellation, skip, or missing run cannot publish), not by a separate lookup of the `main` workflow run. A SHA whose full suite failed on `main` fails that same verify.

The version tag matches `apps/desktop`, `apps/local`, and `apps/cli`, and the `image:` tags in `docker-compose.yml`. Set those three package versions with `npm run release:stamp -- <version>` (see `scripts/npm/RELEASE.md`). That command checks the tag against the three packages only. `scripts/images/check-images.mjs` still rejects a tag whose version differs from the compose pin, so the pin is updated in the same release commit. The image-version assertion joins the stamp command in phase 2. A prerelease does not move `latest`. `workflow_dispatch` builds and smokes the images locally and does not push.

Publish jobs share the concurrency group `image-publish-registry` and do not cancel each other. A stable release moves `latest` only when `org.opencontainers.image.version` on the current `latest` image is missing or older than or equal to this version. An older stable tag that reaches the registry later leaves `latest` where it is. The remote tag is checked again immediately before each version push, and again after both version tags exist and before either `latest` tag moves.

The publish job's permissions are `contents: read` and `packages: write`. It does not build an image and does not run `npm ci`. The only registry credential is `GITHUB_TOKEN`. The repository stores no long-lived registry secret. BuildKit provenance (`mode=max`) and the SBOM travel inside the OCI index. The workflow does not request `id-token` or GitHub artifact attestations.

## Fail closed

Publication does not push when any of these is true:

- `verify.yml` did not succeed for that commit
- the tag moved after the triggering event
- the tag commit is not an ancestor of protected `main`
- the tag, the three package versions, and the compose image tags disagree
- either image exceeds the size budget enforced by `scripts/images/check-images.mjs` (800 MiB)
- the build job's smoke (`scripts/images/smoke-compose.mjs --pull never`) fails
- crane cannot push the layout

The tag is checked again with `scripts/desktop/release-commit.mjs --verify-remote` immediately before each image push and before `latest` moves.

## A push that stops halfway

Both version tags are pushed before either `latest` tag moves. If the web push fails after the hub push, `latest` is unchanged and the pair is incomplete. Re-run the same tag workflow. The remote tag check runs again before each push. If GHCR refuses to overwrite the hub version tag, delete that package version in the package settings and re-run. Do not point `latest` at only one of the two images.

If `latest` moves for hub and then the web move fails, re-run the workflow. The version check treats an equal version as safe to set again, and it will not move `latest` backward. There is no automatic rollback of a tag that already moved.

## One-time package visibility

The repository is public. The first Actions push can still create a private GHCR package. After that push, confirm both packages are public. If either package was created private, change it in the package settings on GitHub. Do not put a PAT in the repository or the workflow. Until the packages are public, the post-publish smoke job can still pull them because that job has `packages: read`.

The workflow token must be allowed to write packages. If the repository limits `GITHUB_TOKEN` to read, the publish job fails closed.
