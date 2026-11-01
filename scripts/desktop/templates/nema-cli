#!/bin/sh
# Runs the bundled CLI with Electron's Node. Every argument is forwarded and the exit code is preserved.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export ELECTRON_RUN_AS_NODE=1
exec "$ROOT/{{NODE_PATH}}" "$ROOT/{{CLI_PATH}}" "$@"
