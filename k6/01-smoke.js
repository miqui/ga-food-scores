// 01 — Smoke test: one virtual user (VU), one pass through every read endpoint.
//
// Run:   k6 run k6/01-smoke.js
//
// Learn here:
//   - options:      how many VUs, how long, and pass/fail thresholds
//   - group():      label related requests in the output
//   - check():      assertions on a response; failures are counted, not thrown
//   - thresholds:   turn results into a pass/fail exit code (useful in CI)
//
// A smoke test answers "does the API work at all?" before you add any load.

import http from 'k6/http';
import { group, check } from 'k6';
import { BASE_URL, COUNTIES, authed, registerAndLogin } from './lib/api.js';

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    // Every check must pass, otherwise k6 exits with a non-zero code.
    checks: ['rate==1.0'],
  },
};

// The default function is what each VU runs, once per iteration.
export default function () {
  group('public', () => {
    const res = http.get(`${BASE_URL}/healthz`);
    check(res, {
      'healthz: status 200': (r) => r.status === 200,
      'healthz: status ok': (r) => r.json('status') === 'ok',
    });
  });

  let token;
  group('auth', () => {
    token = registerAndLogin();
  });

  let facilityId;
  let inspectionId;

  group('read endpoints', () => {
    const counties = http.get(`${BASE_URL}/counties`, authed(token));
    check(counties, {
      'counties: status 200': (r) => r.status === 200,
      'counties: all 159 listed': (r) => r.json('counties').length === 159,
    });

    const county = COUNTIES[0];
    const list = http.get(
      `${BASE_URL}/facilities?county=${encodeURIComponent(county)}`,
      authed(token, 'GET /facilities'),
    );
    check(list, {
      'facilities: status 200': (r) => r.status === 200,
      'facilities: has results': (r) => r.json('results').length > 0,
      'facilities: pageSize is 20': (r) => r.json('pageSize') === 20,
      // r.json() takes a path, so you can reach into nested fields directly.
      [`facilities: every result is in ${county}`]: (r) =>
        r.json('results').every((f) => f.county === county),
    });
    facilityId = list.json('results.0.id');

    const filtered = http.get(
      `${BASE_URL}/facilities?county=${encodeURIComponent(county)}&min_score=95`,
      authed(token, 'GET /facilities'),
    );
    check(filtered, {
      'facilities min_score=95: every score >= 95': (r) =>
        r.json('results').every((f) => f.lastInspectionScore >= 95),
    });

    const page2 = http.get(
      `${BASE_URL}/facilities?county=${encodeURIComponent(county)}&page=2`,
      authed(token, 'GET /facilities'),
    );
    check(page2, { 'facilities page=2: page is 2': (r) => r.json('page') === 2 });

    const one = http.get(
      `${BASE_URL}/facilities/${encodeURIComponent(facilityId)}`,
      authed(token, 'GET /facilities/:id'),
    );
    check(one, {
      'facility: status 200': (r) => r.status === 200,
      'facility: id matches': (r) => r.json('id') === facilityId,
    });

    const history = http.get(
      `${BASE_URL}/facilities/${encodeURIComponent(facilityId)}/inspections`,
      authed(token, 'GET /facilities/:id/inspections'),
    );
    check(history, {
      'inspections: status 200': (r) => r.status === 200,
      'inspections: at least one': (r) => r.json('inspections').length > 0,
    });
    inspectionId = history.json('inspections.0.inspectionId');

    const detail = http.get(`${BASE_URL}/inspections/${inspectionId}`, authed(token, 'GET /inspections/:id'));
    check(detail, {
      'inspection: status 200': (r) => r.status === 200,
      'inspection: has violations array': (r) => Array.isArray(r.json('violations')),
    });
  });

  // Error cases are part of the contract too. These responses are 4xx on purpose,
  // so mark them as expected; otherwise they'd show up in http_req_failed.
  group('error cases', () => {
    const expect4xx = { responseCallback: http.expectedStatuses(400, 401, 404) };

    const noToken = http.get(`${BASE_URL}/facilities`, expect4xx);
    check(noToken, { 'no token: 401': (r) => r.status === 401 });

    const badToken = http.get(`${BASE_URL}/facilities`, {
      ...expect4xx,
      headers: { Authorization: 'Bearer not-a-real-token' },
    });
    check(badToken, { 'bad token: 401': (r) => r.status === 401 });

    const missing = http.get(`${BASE_URL}/facilities/does-not-exist`, { ...authed(token), ...expect4xx });
    check(missing, { 'unknown facility: 404': (r) => r.status === 404 });

    const badId = http.get(`${BASE_URL}/inspections/abc`, { ...authed(token), ...expect4xx });
    check(badId, { 'non-numeric inspection id: 400': (r) => r.status === 400 });

    // POST /admin/sync is deliberately not called: if K6_EMAIL is an admin account,
    // it would start a real sync against the live state portal. Role checks are
    // covered by the unit tests instead (test/unit/role-revocation.test.ts).
  });
}
