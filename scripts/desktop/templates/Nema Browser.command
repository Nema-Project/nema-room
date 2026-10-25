#!/bin/sh
# The browser entry validates launch URLs and accepts --no-open for automated smoke.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$ROOT/{{NODE_PATH}}" "$ROOT/app/node_modules/@nema/local/dist/src/browser.js" --assetsDir "$ROOT" "$@"
