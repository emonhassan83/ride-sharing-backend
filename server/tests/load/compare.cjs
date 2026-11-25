'use strict';
// usage: node compare.cjs  -> markdown comparison tables built ONLY from files in reports/<label>/
const fs = require('fs'); const path = require('path');
const R = (l, f) => path.join(__dirname, 'reports', l, f);
const jl = (f) => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean) : [];
const f1 = (v, d = 0) => (v == null || !Number.isFinite(v) ? 'n/a' : v >= 1000 ? (v / 1000).toFixed(2) + ' s' : v.toFixed(d) + ' ms');
const num = (v, d = 0) => (v == null || !Number.isFinite(v) ? 'n/a' : Number(v).toFixed(d));

function infraStats(label) {
  const s = jl(R(label, 'server.jsonl')); const i = jl(R(label, 'infra.jsonl')).filter((x) => x.redis);
  const busy = s.slice(3, Math.max(4, s.length - 3));
  const avg = (a, g) => (a.length ? a.reduce((t, x) => t + g(x), 0) / a.length : NaN);
  const loaded = busy.filter((x) => x.cpuPct > 5);
  const lastS = s[s.length - 1] || {};
  return {
    cpuAvg: avg(loaded, (x) => x.cpuPct), cpuPeak: Math.max(...busy.map((x) => x.cpuPct)), rssPeak: Math.max(...s.map((x) => x.rssMB)),
    heapPeak: Math.max(...s.map((x) => x.heapUsedMB)), elP99: Math.max(...busy.map((x) => x.elP99)),
    mongoConns: Math.max(...i.map((x) => x.mongo.connCurrent)), mongoCpu: avg(i.filter((x) => x.docker && x.docker['splitride-load-mongo']), (x) => parseFloat(x.docker['splitride-load-mongo'].cpu)),
    redisOps: Math.max(...i.map((x) => x.redis.opsPerSec)), redisKeys: undefined, maps: lastS.mapsDistanceMatrix,
  };
}
function rest(label) {
  const p = R(label, 'k6-summary.json'); if (!fs.existsSync(p)) return null;
  const m = JSON.parse(fs.readFileSync(p, 'utf8')).metrics; const d = m.http_req_duration; const fail = m.http_req_failed;
  return { label, n: m.http_reqs.count, rps: m.http_reqs.rate, p50: d.med, p95: d['p(95)'], p99: d['p(99)'], max: d.max,
    fail: (fail.value ?? fail.rate ?? 0) * 100, dropped: (m.dropped_iterations || {}).count || 0, ...infraStats(label) };
}
function table(title, labels) {
  console.log(`\n### ${title}\n`);
  const rows = labels.map(rest).filter(Boolean);
  const cols = [['run', (r) => r.label], ['reqs done', (r) => num(r.n)], ['req/s', (r) => num(r.rps, 1)], ['p50', (r) => f1(r.p50)], ['p95', (r) => f1(r.p95)], ['p99', (r) => f1(r.p99)], ['max', (r) => f1(r.max)],
    ['err %', (r) => num(r.fail, 2)], ['dropped', (r) => num(r.dropped)], ['srv CPU avg/peak (% of 1 core)', (r) => `${num(r.cpuAvg)}/${num(r.cpuPeak)}`], ['RSS peak MB', (r) => num(r.rssPeak)], ['heap peak MB', (r) => num(r.heapPeak)],
    ['evloop p99 max', (r) => f1(r.elP99)], ['Mongo conns', (r) => num(r.mongoConns)], ['Mongo CPU avg %', (r) => num(r.mongoCpu)], ['Redis ops/s peak', (r) => num(r.redisOps)]];
  console.log('| ' + cols.map((c) => c[0]).join(' | ') + ' |\n|' + cols.map(() => '---').join('|') + '|');
  rows.forEach((r) => console.log('| ' + cols.map((c) => c[1](r)).join(' | ') + ' |'));
}
function ws(title, labels) {
  console.log(`\n### ${title}\n`);
  console.log('| run | sockets ok / conn errors | ping p50 | ping p95 | ping p99 | nearby searches ok | nearby timeouts | nearby p50 | nearby p95 | nearby p99 | Maps calls (stub) | events received | srv CPU avg/peak | RSS peak MB | Mongo CPU avg % | Redis ops/s peak |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const l of labels) {
    const p = R(l, 'sockets.json'); if (!fs.existsSync(p)) continue; const j = JSON.parse(fs.readFileSync(p, 'utf8')); const s = infraStats(l); const L = j.latencyMs; const c = j.counts;
    console.log(`| ${l} | ${c.connected} / ${c.connectErr} | ${f1(L['location-update'].p50, 1)} | ${f1(L['location-update'].p95)} | ${f1(L['location-update'].p99)} | ${c.nearbyCalls} | ${c.timeouts['get-nearby']} | ${f1(L['get-nearby'].p50)} | ${f1(L['get-nearby'].p95)} | ${f1(L['get-nearby'].p99)} | ${num(s.maps)} | ${num(c.pushesIn)} | ${num(s.cpuAvg)}/${num(s.cpuPeak)} | ${num(s.rssPeak)} | ${num(s.mongoCpu)} | ${num(s.redisOps)} |`);
  }
}
table('Gradual ramp 10→200 req/s (read mix)', ['ramp', 'ramp-idx', 'ramp-after']);
table('Stress: step to 2000 req/s target', ['stress-idx', 'stress-after']);
table('Spike: 30→800→30 req/s', ['spike-idx', 'spike-after']);
table('Login (bcrypt 12) 10 /s and 30 /s', ['login10', 'login10-after', 'login30', 'login30-after']);
ws('Realtime T1 (300 drivers / 1000 riders)', ['ws-T1', 'ws-T1-after']);
ws('Realtime T2 (1000 drivers / 3000 riders)', ['ws-T2', 'ws-T2-after']);
