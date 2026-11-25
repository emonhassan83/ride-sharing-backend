#!/usr/bin/env bash
# usage: run-ws.sh <label> [realtime.cjs args...]   fresh server + telemetry + socket load
cd "$(dirname "$0")" || exit 1
label=$1; shift; mkdir -p reports/$label
powershell -NoProfile -File stop-server.ps1 >/dev/null; sleep 2
docker exec splitride-load-redis redis-cli -a loadtestredis FLUSHALL >/dev/null 2>&1
docker exec splitride-load-mongo mongosh --quiet --eval 'db.getSiblingDB("splitride_load").setProfilingLevel(0); db.getSiblingDB("splitride_load").system.profile.drop()' >/dev/null 2>&1
./start-server.sh || exit 1
node monitor.cjs $label & MON=$!
sleep 3
node sockets/realtime.cjs $label "$@" > reports/$label/ws-console.txt 2>&1
sleep 4; kill $MON 2>/dev/null
cp runtime/server-samples.jsonl reports/$label/server.jsonl; cp runtime/stub-stats.json reports/$label/stub-final.json
docker exec splitride-load-mongo mongosh --quiet --eval '
const d=db.getSiblingDB("splitride_load");
printjson(d.system.profile.aggregate([{ $group:{_id:{ns:"$ns",op:"$op",plan:"$planSummary"},n:{$sum:1},avgMs:{$avg:"$millis"},maxMs:{$max:"$millis"},docs:{$avg:"$docsExamined"}}},{ $sort:{n:-1}},{ $limit:12}]).toArray())' > reports/$label/mongo-slow.txt 2>&1
cat reports/$label/ws-console.txt | tail -45
