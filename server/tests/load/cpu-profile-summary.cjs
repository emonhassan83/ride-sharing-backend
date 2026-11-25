'use strict';
// usage: node cpu-profile-summary.cjs <file.cpuprofile>  -> top self-time by function and by package/area
const fs = require('fs'); const p = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const self = new Map(); const byId = new Map(p.nodes.map((n) => [n.id, n]));
const dt = p.timeDeltas; p.samples.forEach((id, i) => self.set(id, (self.get(id) || 0) + (dt[i] || 0)));
const total = [...self.values()].reduce((a, b) => a + b, 0);
const area = (u) => { u = (u || '').split(String.fromCharCode(92)).join('/'); if (!u) return '(native/gc/idle)'; const m = u.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)\//); if (m) return 'pkg:' + m[1]; if (u.includes('/src/app/')) return 'app:' + (u.split('/src/app/')[1].split('/').slice(0, 2).join('/')); if (u.startsWith('node:')) return 'node-internal'; return u.slice(-40); };
const fn = new Map(), ar = new Map();
for (const [id, t] of self) { const n = byId.get(id); const cf = n.callFrame; const key = `${cf.functionName || '(anon)'} ${area(cf.url)}:${cf.lineNumber}`;
  fn.set(key, (fn.get(key) || 0) + t); const a = area(cf.url); ar.set(a, (ar.get(a) || 0) + t); }
const top = (m, k) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([n, t]) => `${(t / total * 100).toFixed(1).padStart(5)}%  ${n}`).join('\n');
console.log(`total sampled ${(total / 1e6).toFixed(1)}s\n-- by package/area --\n${top(ar, 18)}\n-- top functions (self) --\n${top(fn, 22)}`);
