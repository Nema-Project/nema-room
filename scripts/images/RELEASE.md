# Hub and web image publication

Workflow file: `.github/workflows/image-publish.yml`.

A push of a `v*` tag builds `linux/amd64` hub and web images, runs `.github/workflows/verify.yml` on that same commit, then copies the build job's OCI layout to GHCR with crane `0.22.1`. Image names:

- `ghcr.io/nema-project/nema-room-hub`
- `ghcr.io/nema-project/nema-room-web`

The version tag matches `apps/desktop`, `apps/local`, and `apps/cli`, and the `image:` tags in `docker-compose.yml`. A stable release also moves `latest`. A prerelease does not move `latest`. `workflow_dispatch` builds and smokes the images locally and does not push.

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

The tag is checked again with `scripts/desktop/release-commit.mjs --verify-remote` immediately before the push.

## One-time package visibility

The repository is public. The first Actions push can still create a private GHCR package. After that push, confirm both packages are public. If either package was created private, change it in the package settings on GitHub. Do not put a PAT in the repository or the workflow. Until the packages are public, the post-publish smoke job can still pull them because that job has `packages: read`.

The workflow token must be allowed to write packages. If the repository limits `GITHUB_TOKEN` to read, the publish job fails closed.
