'use strict';
/**
 * Load-test preload (loaded with `node -r`). Lives OUTSIDE production code.
 * - Stubs outbound third parties so the test never reaches real Maps/Stripe/Twilio/FCM.
 * - Counts Google Maps calls and applies a configurable latency (MAPS_LATENCY_MS, default 80).
 * - Writes counters to runtime/stub-stats.json every 2s so the report can quote real numbers.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const serverRoot = path.resolve(__dirname, '..', '..');
const stats = { mapsDistanceMatrix: 0, mapsDirections: 0, pushSent: 0, sms: 0, stripeCalls: 0, blockedNet: 0 };
const MAPS_LATENCY = Number(process.env.MAPS_LATENCY_MS || 80);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- axios adapter: intercept Google Maps only
const axios = require(path.join(serverRoot, 'node_modules', 'axios'));
const realAdapter = axios.getAdapter ? axios.getAdapter(axios.defaults.adapter) : null;
axios.defaults.adapter = async (config) => {
  const url = String(config.url || '');
  if (url.includes('maps.googleapis.com')) {
    await sleep(MAPS_LATENCY);
    let data;
    if (url.includes('distancematrix')) {
      stats.mapsDistanceMatrix++;
      data = { status: 'OK', rows: [{ elements: [{ status: 'OK',
        distance: { value: 4200 }, duration: { value: 600 }, duration_in_traffic: { value: 660 } }] }] };
    } else {
      stats.mapsDirections++;
      // encoded polyline of a short 2-point path
      data = { status: 'OK', routes: [{ overview_polyline: { points: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' },
        legs: [{ distance: { value: 4200 }, duration: { value: 600 }, duration_in_traffic: { value: 660 } }] }] };
    }
    return { data, status: 200, statusText: 'OK', headers: {}, config, request: {} };
  }
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)/.test(url) && url.startsWith('http')) {
    stats.blockedNet++;
    throw new Error('load-test: outbound HTTP blocked: ' + url);
  }
  return realAdapter(config);
};

const deepStub = (counter) => new Proxy(function () {}, {
  get: (_t, p) => (p === 'then' ? undefined : deepStub(counter)),
  apply: () => { stats[counter]++; return Promise.resolve({ sid: 'SMload', id: 'stub', status: 'stub' }); },
  construct: () => deepStub(counter),
});

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'firebase-admin/app') {
    return { initializeApp: () => ({}), cert: () => ({}), getApps: () => [] };
  }
  if (request === 'firebase-admin/messaging') {
    return { getMessaging: () => ({
      sendEach: async (msgs) => { stats.pushSent += msgs.length; return { successCount: msgs.length, failureCount: 0, responses: msgs.map(() => ({ success: true })) }; },
      send: async () => { stats.pushSent++; return 'stub'; },
    }) };
  }
  if (request === 'twilio') {
    const client = { messages: { create: async () => { stats.sms++; return { sid: 'SMload' }; } },
      verify: { v2: { services: () => ({ verifications: { create: async () => { stats.sms++; return {}; } }, verificationChecks: { create: async () => ({ status: 'approved' }) } }) } } };
    const f = () => client; f.default = f; return f;
  }
  if (request === 'stripe') {
    const S = function () { return deepStub('stripeCalls'); };
    S.default = S; return S;
  }
  return origLoad.apply(this, arguments);
};


// ---- process telemetry (CPU%, RSS, heap, event-loop delay) sampled every 2s
const { monitorEventLoopDelay } = require('perf_hooks');
const h = monitorEventLoopDelay({ resolution: 10 }); h.enable();
let lastCpu = process.cpuUsage(), lastT = process.hrtime.bigint();
const samplesFile = path.join(__dirname, 'runtime', 'server-samples.jsonl');
try { fs.writeFileSync(samplesFile, ''); } catch {}
setInterval(() => {
  const now = process.hrtime.bigint(); const cpu = process.cpuUsage();
  const dtUs = Number(now - lastT) / 1000;
  const cpuPct = ((cpu.user - lastCpu.user) + (cpu.system - lastCpu.system)) / dtUs * 100; // 100 = one full core
  lastCpu = cpu; lastT = now;
  const mu = process.memoryUsage();
  const sample = { t: Date.now(), cpuPct: +cpuPct.toFixed(1), rssMB: +(mu.rss/1048576).toFixed(1), heapUsedMB: +(mu.heapUsed/1048576).toFixed(1),
    extMB: +(mu.external/1048576).toFixed(1), elP50: +(h.percentile(50)/1e6).toFixed(2), elP99: +(h.percentile(99)/1e6).toFixed(2), elMax: +(h.max/1e6).toFixed(2),
    handles: (process._getActiveHandles ? process._getActiveHandles().length : -1), ...stats };
  h.reset();
  try { fs.writeFileSync(path.join(__dirname, 'runtime', 'stub-stats.json'), JSON.stringify(sample)); fs.appendFileSync(samplesFile, JSON.stringify(sample) + String.fromCharCode(10)); } catch {}
}, 2000).unref();
console.log('[load-preload] stubs active: maps(latency ' + MAPS_LATENCY + 'ms), stripe, twilio, firebase; outbound http blocked; telemetry on');

// ---- opt-in CPU profile (CPU_PROF=1): stop+write when runtime/prof.stop appears
if (process.env.CPU_PROF === '1') {
  const inspector = require('inspector'); const session = new inspector.Session(); session.connect();
  session.post('Profiler.enable', () => session.post('Profiler.setSamplingInterval', { interval: 500 }, () => session.post('Profiler.start')));
  const stopFile = path.join(__dirname, 'runtime', 'prof.stop');
  setInterval(() => { if (fs.existsSync(stopFile)) { fs.unlinkSync(stopFile);
    session.post('Profiler.stop', (err, { profile }) => { fs.writeFileSync(path.join(__dirname, 'runtime', 'server.cpuprofile'), JSON.stringify(profile)); console.log('[load-preload] cpu profile written'); }); } }, 1000).unref();
}
