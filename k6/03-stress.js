// 03 — Stress test: push request rate up until the API slows down or errors.
//
// Run:   k6 run k6/03-stress.js
//        k6 run -e MAX_RPS=2000 k6/03-stress.js     # push harder
//
// Learn here:
//   - scenarios:   several workloads in one test, each with its own executor
//   - executors:   `ramping-arrival-rate` fixes the request RATE (requests/second) and
//                  adds VUs as needed; `constant-arrival-rate` holds one rate steady.
//                  Contrast with 02-load.js, where the number of USERS is fixed and
//                  the rate depends on how fast the server answers.
//   - abortOnFail: stop the test early once a threshold is clearly broken
//   - exec:        point a scenario at a named function instead of `default`
//   - dropped_iterations: k6 reports this when it couldn't start iterations on time
//                  (not enough VUs) — a sign the server, or k6 itself, is saturated
//
// A stress test answers "where does it break, and how does it fail?"
// Run it against your local server, never against a shared or production one.

import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, COUNTIES, EMAIL, PASSWORD, authed, registerAndLogin, discoverTestData, pick } from './lib/api.js';

const MAX_RPS = Number(__ENV.MAX_RPS || 500);

export const options = {
  scenarios: {
    // Read traffic: ramp from 10 to MAX_RPS iterations/second (1 request each).
    reads: {
      executor: 'ramping-arrival-rate',
      exec: 'reads',
      startRate: 10,
      timeUnit: '1s',
      preAllocatedVUs: 20,
      maxVUs: 200,
      stages: [
        { duration: '20s', target: Math.round(MAX_RPS / 4) },
        { duration: '20s', target: Math.round(MAX_RPS / 2) },
        { duration: '20s', target: MAX_RPS },
        { duration: '20s', target: MAX_RPS }, // hold at the top
        { duration: '10s', target: 0 },
      ],
    },
    // Logins: a steady trickle. Each login verifies a scrypt password hash, which is
    // deliberately slow and CPU-heavy, so even a few per second can slow everything else.
    logins: {
      executor: 'constant-arrival-rate',
      exec: 'login',
      rate: Number(__ENV.LOGIN_RPS || 5),
      timeUnit: '1s',
      duration: '1m30s',
      preAllocatedVUs: 5,
      maxVUs: 50,
    },
  },
  thresholds: {
    // Abort if more than 5% of requests fail (after a 10 s grace period).
    http_req_failed: [{ threshold: 'rate<0.05', abortOnFail: true, delayAbortEval: '10s' }],
    // Report (but don't abort on) latency per scenario: k6 tags each request with it.
    'http_req_duration{scenario:reads}': ['p(95)<500'],
    'http_req_duration{scenario:logins}': ['p(95)<1000'],
  },
};

export function setup() {
  const token = registerAndLogin();
  return { token, ...discoverTestData(token) };
}

// No sleep() here: with arrival-rate executors the pacing comes from the scenario.
export function reads(data) {
  const { token, facilityIds, inspectionIds } = data;
  const roll = Math.random();
  let res;
  if (roll < 0.5) {
    const county = pick(COUNTIES);
    res = http.get(
      `${BASE_URL}/facilities?county=${encodeURIComponent(county)}&page=${1 + Math.floor(Math.random() * 3)}`,
      authed(token, 'GET /facilities'),
    );
  } else if (roll < 0.8) {
    res = http.get(
      `${BASE_URL}/facilities/${encodeURIComponent(pick(facilityIds))}`,
      authed(token, 'GET /facilities/:id'),
    );
  } else {
    res = http.get(`${BASE_URL}/inspections/${pick(inspectionIds)}`, authed(token, 'GET /inspections/:id'));
  }
  check(res, { 'read: 200': (r) => r.status === 200 });
}

export function login() {
  const res = http.post(`${BASE_URL}/auth/login`, JSON.stringify({ email: EMAIL, password: PASSWORD }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'POST /auth/login' },
  });
  check(res, { 'login: 200': (r) => r.status === 200 });
}
