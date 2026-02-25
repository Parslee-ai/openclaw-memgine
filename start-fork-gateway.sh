#!/bin/bash
# Memgine Fork Gateway — runs on port 18790 alongside mainline (18789)
# Usage: ./start-fork-gateway.sh

export OPENCLAW_GATEWAY_PORT=18790
export OPENCLAW_HOME="$HOME/.openclaw-fork-home"
export MEMGINE_CONVEX_URL=https://necessary-gecko-572.convex.cloud
export MEMGINE_CONVEX_SITE_URL=https://necessary-gecko-572.convex.site

echo "🧠 Starting Memgine Fork Gateway on port $OPENCLAW_GATEWAY_PORT"
echo "   Convex: $MEMGINE_CONVEX_URL"
echo "   Mainline: http://localhost:18789 (untouched)"

cd "$(dirname "$0")"
exec node dist/index.js gateway --port "$OPENCLAW_GATEWAY_PORT"
