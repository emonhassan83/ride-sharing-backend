#!/usr/bin/env bash
# usage: run-scenario.sh <label> <profile> [k6 -e args]
# Fresh server + empty Redis per scenario; collects server/infra telemetry + Mongo slow-op profile.
cd "$(dirname "$0")" || exit 1
label=$1; profile=$2; shift 2
mkdir -p reports/$label
powershell -NoProfile -File stop-server.ps1 >/dev/null; sleep 2
docker exec splitride-load-redis redis-cli -a loadtestredis FLUSHALL >/dev/null 2>&1
docker exec splitride-load-mongo mongosh --quiet --eval 'db.getSiblingDB("splitride_load").setProfilingLevel(0); db.getSiblingDB("splitride_load").system.profile.drop()' >/dev/null 2>&1
./start-server.sh || exit 1
node monitor.cjs $label & MON=$!
sleep 3
date -u +%FT%TZ > reports/$label/started.txt
./run-k6.sh $label $profile "$@" > reports/$label/k6-console.txt 2>&1
date -u +%FT%TZ > reports/$label/ended.txt
sleep 4; kill $MON 2>/dev/null
cp runtime/server-samples.jsonl reports/$label/server.jsonl; cp runtime/stub-stats.json reports/$label/stub-final.json
docker exec splitride-load-mongo mongosh --quiet --eval '
const d=db.getSiblingDB("splitride_load");
printjson(d.system.profile.aggregate([{ $group:{_id:{ns:"$ns",op:"$op",plan:"$planSummary"},n:{$sum:1},avgMs:{$avg:"$millis"},maxMs:{$max:"$millis"},docs:{$avg:"$docsExamined"}}},{ $sort:{n:-1}},{ $limit:15}]).toArray())' > reports/$label/mongo-slow.txt 2>&1
grep -c . runtime/server.log > reports/$label/server-log-lines.txt
echo "== $label done"; sed -n '/THRESHOLDS/,$p' reports/$label/k6-console.txt | head -60
