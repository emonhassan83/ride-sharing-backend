// k6 REST load profile. Run via run-k6.sh (docker grafana/k6), see README.md.
//   -e PROFILE=smoke|ramp|stress|spike|soak|login   -e BASE=http://host.docker.internal:8090
import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';

const BASE = __ENV.BASE || 'http://host.docker.internal:8090';
const API = `${BASE}/api/v1`;
const data = JSON.parse(open('../runtime/tokens.json'));
const riders = new SharedArray('riders', () => data.riders);
const drivers = new SharedArray('drivers', () => data.drivers);
const P = __ENV.PROFILE || 'smoke';

const profiles = {
  smoke: { scenarios: { mix: { executor: 'constant-arrival-rate', rate: 20, timeUnit: '1s', duration: '30s', preAllocatedVUs: 20, maxVUs: 100, exec: 'mixed' } } },
  // gradual increase, then hold at the top step
  ramp: { scenarios: { mix: { executor: 'ramping-arrival-rate', startRate: 10, timeUnit: '1s', preAllocatedVUs: 50, maxVUs: 600, exec: 'mixed',
    stages: [{ target: 50, duration: '1m' }, { target: 100, duration: '1m' }, { target: 200, duration: '1m' }, { target: 200, duration: '2m' }, { target: 0, duration: '20s' }] } } },
  // keep stepping up until the system breaks (aborts when error rate > 30%)
  stress: { scenarios: { mix: { executor: 'ramping-arrival-rate', startRate: 50, timeUnit: '1s', preAllocatedVUs: 200, maxVUs: 2500, exec: 'mixed',
    stages: [{ target: 200, duration: '45s' }, { target: 400, duration: '45s' }, { target: 700, duration: '45s' }, { target: 1000, duration: '45s' }, { target: 1500, duration: '45s' }, { target: 2000, duration: '45s' }, { target: 0, duration: '15s' }] } } },
  spike: { scenarios: { mix: { executor: 'ramping-arrival-rate', startRate: 30, timeUnit: '1s', preAllocatedVUs: 100, maxVUs: 2500, exec: 'mixed',
    stages: [{ target: 30, duration: '30s' }, { target: 800, duration: '10s' }, { target: 800, duration: '60s' }, { target: 30, duration: '10s' }, { target: 30, duration: '60s' }] } } },
  soak: { scenarios: { mix: { executor: 'constant-arrival-rate', rate: 60, timeUnit: '1s', duration: __ENV.SOAK_DURATION || '30m', preAllocatedVUs: 60, maxVUs: 400, exec: 'mixed' } } },
  steady: { scenarios: { mix: { executor: 'constant-arrival-rate', rate: Number(__ENV.RATE || 100), timeUnit: '1s', duration: __ENV.DURATION || '60s', preAllocatedVUs: 100, maxVUs: 800, exec: 'mixed' } } },
  login: { scenarios: { login: { executor: 'constant-arrival-rate', rate: Number(__ENV.LOGIN_RATE || 10), timeUnit: '1s', duration: '60s', preAllocatedVUs: 20, maxVUs: 400, exec: 'login' } } },
};

export const options = {
  ...profiles[P],
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<800', 'p(99)<1500'],
    ...(P === 'stress' ? { http_req_failed: [{ threshold: 'rate<0.30', abortOnFail: true, delayAbortEval: '20s' }] } : {}),
  },
};

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const H = (t) => ({ headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' } });
function get(path, tok, name) {
  const r = http.get(`${API}/${path}`, { ...H(tok), tags: { name } });
  check(r, { [`${name} 2xx`]: (x) => x.status >= 200 && x.status < 300 });
  return r;
}

// Read mix approximating app polling behaviour: riders 70% / drivers 30%
export function mixed() {
  if (Math.random() < 0.7) {
    const t = pick(riders).token; const x = Math.random();
    if (x < 0.25) get('user/me', t, 'GET user/me');
    else if (x < 0.50) get('ride/rider-rides', t, 'GET ride/rider-rides');
    else if (x < 0.70) get('notification', t, 'GET notification');
    else if (x < 0.85) get('bookings/my-bookings', t, 'GET bookings/my-bookings');
    else if (x < 0.95) get('setting/generals', t, 'GET setting/generals');
    else get('chats/my-chat-list', t, 'GET chats/my-chat-list');
  } else {
    const t = pick(drivers).token; const x = Math.random();
    if (x < 0.30) get('user/me', t, 'GET user/me (driver)');
    else if (x < 0.60) get('ride/driver-rides', t, 'GET ride/driver-rides');
    else if (x < 0.85) get('passenger/ride-requests', t, 'GET passenger/ride-requests');
    else get('notification', t, 'GET notification (driver)');
  }
}

// bcrypt(12) login: CPU-bound on the libuv threadpool
export function login() {
  const u = pick(riders);
  const r = http.post(`${API}/auth/login-with-email`, JSON.stringify({ email: u.email, password: 'LoadTest#123' }),
    { headers: { 'Content-Type': 'application/json' }, tags: { name: 'POST auth/login-with-email' } });
  check(r, { 'login 200': (x) => x.status === 200 });
}
export default mixed;
