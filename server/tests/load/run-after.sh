#!/usr/bin/env bash
# Re-runs the exact earlier scenarios against the optimized code (labels end in -after).
cd "$(dirname "$0")" || exit 1
./run-scenario.sh ramp-after ramp        > reports/after-ramp.log 2>&1
./run-scenario.sh stress-after stress    > reports/after-stress.log 2>&1
./run-scenario.sh spike-after spike      > reports/after-spike.log 2>&1
./run-scenario.sh login10-after login -e LOGIN_RATE=10 > reports/after-login10.log 2>&1
./run-scenario.sh login30-after login -e LOGIN_RATE=30 > reports/after-login30.log 2>&1
./run-ws.sh ws-T1-after --drivers 300 --riders 1000 --ping-ms 4000 --search-per-min-per-rider 0.15 --duration-s 180 --ramp-s 30 > reports/after-wsT1.log 2>&1
powershell -NoProfile -File stop-server.ps1 >/dev/null; sleep 2
(cd runtime && SEED_DRIVERS=1200 SEED_RIDERS=3000 node ../../../node_modules/ts-node/dist/bin.js --transpile-only -P ../../../tsconfig.json ../seed.ts > ../reports/after-seed2.log 2>&1)
./run-ws.sh ws-T2-after --drivers 1000 --riders 3000 --ping-ms 4000 --search-per-min-per-rider 0.25 --duration-s 150 --ramp-s 40 > reports/after-wsT2.log 2>&1
echo ALL-DONE > reports/after-done.txt
