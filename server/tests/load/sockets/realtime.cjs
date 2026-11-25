'use strict';
// Realtime load: drivers go online + ping location; riders search for nearby drivers.
// usage: node sockets/realtime.cjs <label> [--drivers N] [--riders N] [--ping-ms 4000] [--search-per-min-per-rider 0.5]
//        [--duration-s 180] [--ramp-s 30] [--url http://127.0.0.1:8090]
const path = require('path'); const fs = require('fs');
const { io } = require('socket.io-client');
const args = process.argv.slice(2); const label = args[0];
const opt = (n, d) => { const i = args.indexOf('--' + n); return i > -1 ? Number(args[i + 1]) : d; };
const url = (() => { const i = args.indexOf('--url'); return i > -1 ? args[i + 1] : 'http://127.0.0.1:8090'; })();
const N_D = opt('drivers', 300), N_R = opt('riders', 300), PING = opt('ping-ms', 4000), SPM = opt('search-per-min-per-rider', 0.5);
const DUR = opt('duration-s', 180) * 1000, RAMP = opt('ramp-s', 30) * 1000;
const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'runtime', 'tokens.json'), 'utf8'));
const dir = path.join(__dirname, '..', 'reports', label); fs.mkdirSync(dir, { recursive: true });

const lat = { connect: [], 'go-online': [], 'location-update': [], 'get-nearby': [] };
const cnt = { connected: 0, connectErr: 0, disconnects: 0, timeouts: { 'go-online': 0, 'location-update': 0, 'get-nearby': 0 }, ackFail: { 'go-online': 0, 'location-update': 0, 'get-nearby': 0 }, nearbyDrivers: 0, nearbyCalls: 0, pushesIn: 0 };
const timeline = []; let winLat = { 'location-update': [], 'get-nearby': [] }; let winTimeouts = 0;
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1); };
const stat = (a) => ({ n: a.length, p50: pct(a, .5), p95: pct(a, .95), p99: pct(a, .99), max: a.length ? +Math.max(...a).toFixed(1) : null });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const live = []; let stop = false;

function emit(s, ev, payload, key) {
  const t0 = performance.now();
  s.timeout(10000).emit(ev, payload, (err, res) => {
    const dt = performance.now() - t0;
    if (err) { cnt.timeouts[key]++; winTimeouts++; return; }
    lat[key].push(dt); if (winLat[key]) winLat[key].push(dt);
    if (res && res.success === false) cnt.ackFail[key]++;
    if (key === 'get-nearby') { cnt.nearbyCalls++; const d = res && (res.data && (res.data.drivers || res.data)); if (Array.isArray(d)) cnt.nearbyDrivers += d.length; }
  });
}
const walk = (d) => ({ lat: d.lat + (Math.random() - 0.5) * 0.002, lng: d.lng + (Math.random() - 0.5) * 0.002 });
function open(u) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const s = io(url, { transports: ['websocket'], auth: { token: u.token }, reconnection: false, forceNew: true });
    s.on('connect', () => { lat.connect.push(performance.now() - t0); cnt.connected++; resolve(s); });
    s.on('connect_error', () => { cnt.connectErr++; resolve(null); });
    s.on('disconnect', () => { cnt.disconnects++; });
    s.onAny(() => { cnt.pushesIn++; });
    setTimeout(() => resolve(null), 20000);
  });
}
async function driverLoop(d, startDelay) {
  await sleep(startDelay); const s = await open(d); if (!s) return; live.push(s);
  emit(s, 'driver:go-online', { lat: d.lat, lng: d.lng }, 'go-online');
  let pos = { lat: d.lat, lng: d.lng }; await sleep(Math.random() * PING);
  while (!stop) { pos = walk(pos); emit(s, 'driver:location-update', { lat: pos.lat, lng: pos.lng, speed: 8, heading: 90 }, 'location-update'); await sleep(PING); }
}
async function riderLoop(r, startDelay) {
  await sleep(startDelay); const s = await open(r); if (!s) return; live.push(s);
  if (SPM <= 0) return; const every = 60000 / SPM;
  await sleep(Math.random() * every);
  const day = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  while (!stop) {
    const a = { lat: data.center.lat + (Math.random() - 0.5) * 0.12, lng: data.center.lng + (Math.random() - 0.5) * 0.14 };
    const b = { lat: data.center.lat + (Math.random() - 0.5) * 0.12, lng: data.center.lng + (Math.random() - 0.5) * 0.14 };
    emit(s, 'ride:get-nearby-drivers', { pickup: a, destination: b, rideType: 'private', passengers: 1, departureDate: day, departureTime: '10:00' }, 'get-nearby');
    await sleep(every * (0.7 + Math.random() * 0.6));
  }
}
(async () => {
  console.log(`[${label}] drivers=${N_D} riders=${N_R} ping=${PING}ms search/min/rider=${SPM} dur=${DUR / 1000}s ramp=${RAMP / 1000}s`);
  const t0 = Date.now();
  data.drivers.slice(0, N_D).forEach((d, i) => driverLoop(d, (i / N_D) * RAMP));
  data.riders.slice(0, N_R).forEach((r, i) => riderLoop(r, (i / N_R) * RAMP));
  const tick = setInterval(() => {
    timeline.push({ t: Math.round((Date.now() - t0) / 1000), connected: cnt.connected - cnt.disconnects, ping: stat(winLat['location-update']), nearby: stat(winLat['get-nearby']), timeouts: winTimeouts });
    winLat = { 'location-update': [], 'get-nearby': [] }; winTimeouts = 0;
  }, 10000);
  await sleep(DUR + RAMP); stop = true; clearInterval(tick); await sleep(PING + 1500);
  const out = { label, config: { N_D, N_R, PING, SPM, DUR, RAMP }, counts: cnt, latencyMs: Object.fromEntries(Object.entries(lat).map(([k, v]) => [k, stat(v)])), timeline };
  fs.writeFileSync(path.join(dir, 'sockets.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ counts: cnt, latencyMs: out.latencyMs }, null, 1));
  live.forEach((s) => s.close()); setTimeout(() => process.exit(0), 500);
})();
