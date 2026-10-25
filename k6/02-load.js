// 02 — Load test: many users browsing at the same time, with pass/fail targets.
//
// Run:   k6 run k6/02-load.js
//        k6 run -e PEAK_VUS=50 k6/02-load.js        # more users
//
// Learn here:
//   - stages:         ramp the number of VUs up, hold, then ramp down
//   - setup():        runs once before the test; its return value is passed to every VU
//   - sleep():        "think time" between actions, like a real person reading a page
//   - tags + thresholds per endpoint: e.g. only the list endpoint must be under 200 ms
//   - custom metrics: Trend, Counter and Rate track numbers k6 doesn't measure itself
//
// A load test answers "does the API meet its targets at the traffic we expect?"

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';
import { BASE_URL, COUNTIES, authed, registerAndLogin, discoverTestData, pick } from './lib/api.js';

const PEAK_VUS = Number(__ENV.PEAK_VUS || 20);

// Custom metrics show up in the end-of-test summary next to the built-in ones.
const resultsPerPage = new Trend('facilities_results_per_page');
const facilitiesViewed = new Counter('facilities_viewed');
const emptySearches = new Rate('empty_search_rate');

export const options = {
  stages: [
    { duration: '20s', target: PEAK_VUS }, // ramp up
    { duration: '1m', target: PEAK_VUS }, // hold at peak
    { duration: '10s', target: 0 }, // ramp down
  ],
  thresholds: {
    // Fewer than 1% of requests may fail.
    http_req_failed: ['rate<0.01'],
    // 95% of all requests under 300 ms, 99% under 500 ms.
    http_req_duration: ['p(95)<300', 'p(99)<500'],
    // Per-endpoint targets use the `name` tag set in lib/api.js -> authed().
    'http_req_duration{name:GET /facilities}': ['p(95)<200'],
    'http_req_duration{name:GET /facilities/:id}': ['p(95)<100'],
    checks: ['rate>0.99'],
  },
};

// setup() runs once. Logging in here (instead of in every iteration) keeps the slow,
// CPU-heavy login (scrypt password hashing) out of the browsing numbers.
// The token lasts 15 minutes, so keep this test shorter than that.
export function setup() {
  const token = registerAndLogin();
  const data = discoverTestData(token);
  return { token, ...data };
}

// One iteration = one user session: search a county, open a facility, read its history.
export default function (data) {
  const { token, facilityIds, inspectionIds } = data;
  const county = pick(COUNTIES);

  // Search: random page and sometimes a score filter, so we don't hit one cached query.
  const page = 1 + Math.floor(Math.random() * 3);
  const minScore = Math.random() < 0.3 ? '&min_score=90' : '';
  const list = http.get(
    `${BASE_URL}/facilities?county=${encodeURIComponent(county)}&page=${page}${minScore}`,
    authed(token, 'GET /facilities'),
  );
  check(list, { 'search: 200': (r) => r.status === 200 });
  const results = list.status === 200 ? list.json('results') : [];
  resultsPerPage.add(results.length);
  emptySearches.add(results.length === 0);
  sleep(1 + Math.random() * 2); // read the results

  // Open a facility: one from this search if there was one, otherwise a known one.
  const facilityId = results.length > 0 ? pick(results).id : pick(facilityIds);
  const one = http.get(
    `${BASE_URL}/facilities/${encodeURIComponent(facilityId)}`,
    authed(token, 'GET /facilities/:id'),
  );
  check(one, { 'facility: 200': (r) => r.status === 200 });
  facilitiesViewed.add(1);
  sleep(1 + Math.random());

  const history = http.get(
    `${BASE_URL}/facilities/${encodeURIComponent(facilityId)}/inspections`,
    authed(token, 'GET /facilities/:id/inspections'),
  );
  check(history, { 'history: 200': (r) => r.status === 200 });
  sleep(1);

  // About half of users drill into one inspection's violations.
  if (Math.random() < 0.5) {
    const fromHistory = history.status === 200 ? history.json('inspections') : [];
    const inspectionId = fromHistory.length > 0 ? pick(fromHistory).inspectionId : pick(inspectionIds);
    const detail = http.get(`${BASE_URL}/inspections/${inspectionId}`, authed(token, 'GET /inspections/:id'));
    check(detail, { 'inspection: 200': (r) => r.status === 200 });
    sleep(1);
  }
}
