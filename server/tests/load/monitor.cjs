'use strict';
// Samples Redis, MongoDB and Docker container stats every 2s -> reports/<label>/infra.jsonl
const fs = require('fs'); const path = require('path'); const { execFile } = require('child_process');
const Redis = require('ioredis'); const { MongoClient } = require('mongodb');
const label = process.argv[2] || 'run'; const dir = path.join(__dirname, 'reports', label); fs.mkdirSync(dir, { recursive: true });
const out = fs.createWriteStream(path.join(dir, 'infra.jsonl'));
const redis = new Redis({ host: '127.0.0.1', port: 6499, password: 'loadtestredis' });
const mongo = new MongoClient('mongodb://127.0.0.1:27199', { maxPoolSize: 2 });
let docker = {}; let prevCmds = null;
setInterval(() => execFile('docker', ['stats', '--no-stream', '--format', '{{json .}}', 'splitride-load-mongo', 'splitride-load-redis'], (e, so) => {
  if (e) return; docker = {}; so.trim().split('\n').forEach((l) => { try { const j = JSON.parse(l); docker[j.Name] = { cpu: j.CPUPerc, mem: j.MemUsage }; } catch {} }); }), 5000);
const parse = (txt) => Object.fromEntries(txt.split('\r\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(':')));
(async () => {
  await mongo.connect(); const admin = mongo.db('admin');
  try { await mongo.db('splitride_load').command({ profile: 1, slowms: 100 }); } catch {}
  setInterval(async () => {
    try {
      const t0 = Date.now(); await redis.ping(); const pingMs = Date.now() - t0;
      const info = parse(await redis.info()); const ss = await admin.command({ serverStatus: 1 });
      out.write(JSON.stringify({ t: Date.now(), redis: { pingMs, opsPerSec: +info.instantaneous_ops_per_sec, clients: +info.connected_clients, usedMemMB: +(info.used_memory / 1048576).toFixed(1),
        blocked: +info.blocked_clients, keyspace: info.db0 || '', evicted: +info.evicted_keys, cpuSys: +info.used_cpu_sys, cpuUser: +info.used_cpu_user },
        mongo: { connCurrent: ss.connections.current, connAvailable: ss.connections.available, connTotalCreated: ss.connections.totalCreated, opcounters: ss.opcounters,
          wtCacheMB: +(ss.wiredTiger.cache['bytes currently in the cache'] / 1048576).toFixed(1), queuedRead: ss.globalLock.currentQueue.readers, queuedWrite: ss.globalLock.currentQueue.writers },
        docker }) + '\n');
    } catch (e) { out.write(JSON.stringify({ t: Date.now(), err: String(e) }) + '\n'); }
  }, 2000);
})();
process.on('SIGINT', () => process.exit(0));
