// Shared helpers for the k6 scripts in this folder.
//
// k6 scripts are JavaScript (ES modules) but they do NOT run in Node.js: k6 has its own
// runtime, so `require`, `fs` and npm packages aren't available. Built-in modules are
// imported from 'k6', 'k6/http', 'k6/metrics', and so on.

import http from 'k6/http';
import { check, fail } from 'k6';

// __ENV holds variables passed with `k6 run -e NAME=value` or set in the shell.
export const BASE_URL = __ENV.BASE_URL || 'http://localhost:3344';
export const EMAIL = __ENV.K6_EMAIL || 'k6-tester@example.com';
export const PASSWORD = __ENV.K6_PASSWORD || 'k6-password-123';

// Counties to read from. Defaults to ones filled by the first hour of statewide sync;
// override with -e COUNTIES=LONG,BRYAN if your database has different ones.
export const COUNTIES = (__ENV.COUNTIES || 'BIBB,BARTOW,BALDWIN,BEN HILL,BRYAN')
  .split(',')
  .map((c) => c.trim())
  .filter(Boolean);

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Request params carrying the JWT. `name` groups URLs with ids under one metric tag. */
export function authed(token, name) {
  const params = { headers: { Authorization: `Bearer ${token}` } };
  if (name) params.tags = { name };
  return params;
}

/**
 * Register the test user (a 409 means it already exists, which is fine) and log in.
 * Returns the access token. Tokens last 15 minutes, so longer tests must log in again.
 */
export function registerAndLogin() {
  const body = JSON.stringify({ email: EMAIL, password: PASSWORD });

  // responseCallback marks 409 as an expected status, so it isn't counted in
  // http_req_failed (k6 otherwise treats every 4xx/5xx as a failed request).
  const reg = http.post(`${BASE_URL}/auth/register`, body, {
    headers: JSON_HEADERS,
    tags: { name: 'POST /auth/register' },
    responseCallback: http.expectedStatuses(201, 409),
  });
  check(reg, { 'register: 201 created or 409 already exists': (r) => [201, 409].includes(r.status) });

  const res = http.post(`${BASE_URL}/auth/login`, body, {
    headers: JSON_HEADERS,
    tags: { name: 'POST /auth/login' },
  });
  const ok = check(res, {
    'login: status 200': (r) => r.status === 200,
    'login: has access_token': (r) => typeof r.json('access_token') === 'string',
  });
  if (!ok) fail(`login failed (${res.status}): ${res.body}. Is the server running at ${BASE_URL}?`);
  return res.json('access_token');
}

/**
 * Collect real facility ids and inspection ids to use in later requests, so the
 * scripts work with whatever data is in your database instead of hard-coded ids.
 */
export function discoverTestData(token) {
  const facilityIds = [];
  const inspectionIds = [];
  for (const county of COUNTIES) {
    const res = http.get(
      `${BASE_URL}/facilities?county=${encodeURIComponent(county)}`,
      authed(token, 'GET /facilities'),
    );
    const results = res.status === 200 ? res.json('results') : [];
    for (const f of results.slice(0, 5)) facilityIds.push(f.id);
  }
  if (facilityIds.length === 0) {
    fail(`no facilities found for COUNTIES=${COUNTIES.join(',')}. Run a sync first or pass -e COUNTIES=...`);
  }
  for (const id of facilityIds.slice(0, 10)) {
    const res = http.get(
      `${BASE_URL}/facilities/${encodeURIComponent(id)}/inspections`,
      authed(token, 'GET /facilities/:id/inspections'),
    );
    for (const insp of (res.json('inspections') || []).slice(0, 3)) inspectionIds.push(insp.inspectionId);
  }
  return { facilityIds, inspectionIds };
}

/** Pick a random element: spreads load across different rows instead of one hot row. */
export function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}
