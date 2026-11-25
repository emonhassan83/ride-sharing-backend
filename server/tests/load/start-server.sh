#!/usr/bin/env bash
# Starts the SERVER UNDER TEST from tests/load/runtime (its own .env => isolated Mongo/Redis).
# env: MAPS_LATENCY_MS (default 80)
cd "$(dirname "$0")/runtime" || exit 1
nohup node -r ../preload.cjs ../../../node_modules/ts-node/dist/bin.js --transpile-only -P ../../../tsconfig.json ../../../src/server.ts > server.log 2>&1 &
for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:8090/api/v1/setting/generals && { echo "server up"; exit 0; }; sleep 1; done
echo "server failed to start"; tail -20 server.log; exit 1
