#!/bin/sh
set -e

# Ensure data directories exist (hostPath volume at /opt/nanoclaw must match the host path
# so Docker container volume mounts resolve correctly on the host)
mkdir -p /opt/nanoclaw/store /opt/nanoclaw/data /opt/nanoclaw/groups

# credential-proxy reads secrets from .env (not process.env) to avoid leaking to child processes
printenv > /opt/nanoclaw/.env

cd /opt/nanoclaw
exec node /app/dist/index.js
