#!/bin/sh
# Runs the bundled CLI with the bundled Node; every argument is forwarded and the exit code is preserved.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$ROOT/{{NODE_PATH}}" "$ROOT/{{CLI_PATH}}" "$@"
