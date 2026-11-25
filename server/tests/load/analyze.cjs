'use strict';
// usage: node analyze.cjs <label> [bucketSeconds=15]
// Joins k6 points (latency/throughput) with server telemetry (CPU, event loop, heap) and infra (Redis/Mongo/docker).
const fs = require('fs'); const path = require('path'); const readline = require('readline');
const label = process.argv[2]; const B = (Number(process.argv[3]) || 15) * 1000;
const dir = path.join(__dirname, 'reports', label);
const pct = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const jl = (f) => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];

(async () => {
  const buckets = new Map(); const perEp = new Map(); let t0 = Infinity;
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, 'k6-points.json')) });
  for await (const line of rl) {
    if (!line.includes('"http_req_duration"')) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type !== 'Point' || j.metric !== 'http_req_duration') continue;
    const t = new Date(j.data.time).getTime(); if (t < t0) t0 = t;
    const k = Math.floor(t / B) * B; const b = buckets.get(k) || { d: [], err: 0 }; b.d.push(j.data.value);
    if (j.data.tags && j.data.tags.status && Number(j.data.tags.status) >= 400) b.err++; buckets.set(k, b);
    const ep = (j.data.tags && j.data.tags.name) || '?'; const e = perEp.get(ep) || []; e.push(j.data.value); perEp.set(ep, e);
  }
  const srv = jl(path.join(dir, 'server.jsonl')), inf = jl(path.join(dir, 'infra.jsonl'));
  const within = (arr, k) => arr.filter((s) => s.t >= k && s.t < k + B);
  const avg = (a, f) => a.length ? a.reduce((s, x) => s + f(x), 0) / a.length : NaN;
  const mx = (a, f) => a.length ? Math.max(...a.map(f)) : NaN;
  console.log(`\n== ${label}: bucket=${B / 1000}s (t = seconds from first request)`);
  console.log('  t   rps   p50ms   p95ms   p99ms  err | srvCPU%  elP99ms elMaxms rssMB heapMB | redisOps pingMs rClients | mongoConn mongoCPU redisCPU');
  for (const k of [...buckets.keys()].sort((a, b) => a - b)) {
    const b = buckets.get(k); const s = within(srv, k), i = within(inf, k).filter((x) => x.redis);
    const f = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '-');
    const dk = (n) => { const v = avg(i, (x) => parseFloat(((x.docker || {})[n] || {}).cpu)); return v; };
    console.log(`${String(Math.round((k - t0) / 1000)).padStart(4)} ${f(b.d.length / (B / 1000)).padStart(5)} ${f(pct(b.d, .5), 1).padStart(7)} ${f(pct(b.d, .95), 0).padStart(7)} ${f(pct(b.d, .99), 0).padStart(7)} ${String(b.err).padStart(4)} | ${f(avg(s, (x) => x.cpuPct)).padStart(7)} ${f(mx(s, (x) => x.elP99), 0).padStart(8)} ${f(mx(s, (x) => x.elMax), 0).padStart(7)} ${f(avg(s, (x) => x.rssMB)).padStart(5)} ${f(avg(s, (x) => x.heapUsedMB)).padStart(7)} | ${f(avg(i, (x) => x.redis.opsPerSec)).padStart(8)} ${f(mx(i, (x) => x.redis.pingMs)).padStart(6)} ${f(avg(i, (x) => x.redis.clients)).padStart(8)} | ${f(avg(i, (x) => x.mongo.connCurrent)).padStart(9)} ${f(dk('splitride-load-mongo')).padStart(8)} ${f(dk('splitride-load-redis')).padStart(8)}`);
  }
  console.log('\nPer-endpoint latency (ms) over the whole run:');
  console.log('  endpoint'.padEnd(36) + 'n'.padStart(7) + 'p50'.padStart(9) + 'p95'.padStart(9) + 'p99'.padStart(9) + 'max'.padStart(9));
  for (const [ep, d] of [...perEp.entries()].sort((a, b) => pct(b[1], .95) - pct(a[1], .95)))
    console.log('  ' + ep.padEnd(34) + String(d.length).padStart(7) + pct(d, .5).toFixed(0).padStart(9) + pct(d, .95).toFixed(0).padStart(9) + pct(d, .99).toFixed(0).padStart(9) + Math.max(...d).toFixed(0).padStart(9));
  if (srv.length) { const last = srv[srv.length - 1]; console.log(`\nServer peak: cpu ${mx(srv, (x) => x.cpuPct).toFixed(0)}% of 1 core, rss ${mx(srv, (x) => x.rssMB).toFixed(0)}MB (start ${srv[0].rssMB}MB), heap ${mx(srv, (x) => x.heapUsedMB).toFixed(0)}MB, event-loop p99 max ${mx(srv, (x) => x.elP99)}ms, max ${mx(srv, (x) => x.elMax)}ms, maps calls dm=${last.mapsDistanceMatrix} dir=${last.mapsDirections}`); }
  if (inf.length) { const ii = inf.filter((x) => x.redis); console.log(`Infra peak: mongo conns ${mx(ii, (x) => x.mongo.connCurrent)}, redis clients ${mx(ii, (x) => x.redis.clients)}, redis ops/s ${mx(ii, (x) => x.redis.opsPerSec)}, redis ping max ${mx(ii, (x) => x.redis.pingMs)}ms, redis mem ${mx(ii, (x) => x.redis.usedMemMB)}MB, mongo queued r/w ${mx(ii, (x) => x.mongo.queuedRead)}/${mx(ii, (x) => x.mongo.queuedWrite)}`); }
})();
