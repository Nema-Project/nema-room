#!/bin/sh
# Docker injects the container hostname as HOSTNAME. Next's standalone server
# binds that name unless the listen address is set here.
export HOSTNAME=0.0.0.0
export PORT="${PORT:-3000}"
cd /app
# Same socket check as the desktop parent. HOSTNAME stays 0.0.0.0 inside the container.
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--import /opt/nema/share-peer-guard.mjs"
exec node apps/web/server.js
