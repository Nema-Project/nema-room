#!/bin/sh
# Docker injects the container hostname as HOSTNAME. Next's standalone server
# binds that name unless the listen address is set here.
export HOSTNAME=0.0.0.0
export PORT="${PORT:-3000}"
cd /app
exec node apps/web/server.js
