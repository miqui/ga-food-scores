# k6 tests for the API

[k6](https://grafana.com/docs/k6/latest/) scripts that test the API and teach k6 along
the way. Each script builds on the previous one and is commented line by line, so read
them in order:

| Script | Kind | Question it answers | Runs for |
|---|---|---|---|
| `01-smoke.js` | Smoke | Does every endpoint work, including error cases? | ~1 s |
| `02-load.js` | Load | Does the API meet its latency targets with the traffic we expect? | ~1.5 min |
| `03-stress.js` | Stress | At what request rate does it slow down or fail, and what does login cost? | ~1.5 min |
| `lib/api.js` | Helpers | Settings, login, and finding real ids to request | — |

## 1. Set up

Install k6 (macOS: `brew install k6`; other systems: see the k6 install docs). These
scripts were written against k6 v2.2.

Start the API in another terminal. To keep the test user out of your real database,
run against a copy:

```bash
cp data/app.db /tmp/k6.db
JWT_SECRET=k6-local-secret PORT=3344 DB_PATH=/tmp/k6.db npm run dev
```

The scripts need synced data. By default they read BIBB, BARTOW, BALDWIN, BEN HILL and
BRYAN (all done by the first hour of a statewide sync). If your database has other
counties, pass them: `-e COUNTIES=LONG,CHATHAM`.

## 2. Run

```bash
k6 run k6/01-smoke.js
k6 run k6/02-load.js
k6 run k6/03-stress.js
```

Settings, passed with `-e NAME=value`:

| Variable | Default | Used by |
|---|---|---|
| `BASE_URL` | `http://localhost:3344` | all |
| `K6_EMAIL` / `K6_PASSWORD` | `k6-tester@example.com` / `k6-password-123` | all (registered automatically) |
| `COUNTIES` | `BIBB,BARTOW,BALDWIN,BEN HILL,BRYAN` | all |
| `PEAK_VUS` | `20` | `02-load.js` |
| `MAX_RPS` | `500` | `03-stress.js` |
| `LOGIN_RPS` | `5` | `03-stress.js` |

Useful flags:

- `--quiet` hides the progress bar.
- `--vus 5 --duration 30s` overrides a script's own load settings for a quick try.
- `--summary-export=summary.json` saves the end-of-test numbers as JSON.
- `K6_WEB_DASHBOARD=true k6 run ...` opens a live dashboard at http://localhost:5665.

**Never point these at a shared or production server**, and never run them as an admin
user: `POST /admin/sync` starts a real sync against the state portal.

## 3. Read the results

k6 prints a summary at the end. The lines that matter most:

- **THRESHOLDS**: each target with ✓ or ✗. If any fails, k6 exits with a non-zero code,
  which is what makes these usable in CI.
- **checks_succeeded**: the share of `check()` assertions that passed. A failed check
  doesn't stop the test; it's counted.
- **http_req_duration**: response time. Look at `p(95)`, "95% of requests were at least
  this fast", rather than the average, which hides slow outliers. Lines like
  `{ name:GET /facilities }` break it down per endpoint.
- **http_req_failed**: the share of requests that failed. By default any 4xx/5xx counts;
  the scripts mark expected errors (like the 401 checks) so they don't.
- **iterations** / **vus**: how much work was done, and by how many virtual users.
- **dropped_iterations** (stress test): iterations k6 couldn't start on time. It means
  either the server or k6 itself couldn't keep up.

## 4. k6 ideas, by script

**01-smoke.js**
- `options`: `vus` (virtual users, each running the default function in a loop) and
  `iterations` or `duration`.
- `check(res, { name: fn })`: assertions on a response.
- `group()`: labels for related requests.
- `thresholds`: pass/fail rules; `checks: ['rate==1.0']` means every check must pass.
- `responseCallback: http.expectedStatuses(...)`: which statuses aren't failures.

**02-load.js**
- `stages`: ramp VUs up, hold, ramp down.
- `setup()`: runs once; its return value is passed to every VU. Used here to log in
  once and to look up real ids.
- `sleep()`: think time between steps, so VUs behave like people.
- Tags: `tags: { name: 'GET /facilities/:id' }` groups URLs that contain ids, so
  per-endpoint thresholds like `'http_req_duration{name:GET /facilities}'` work.
- Custom metrics: `Trend` (a distribution), `Counter` (a total), `Rate` (a percentage).

**03-stress.js**
- `scenarios`: several workloads at once, each with its own `exec` function.
- Executors: `ramping-vus` (02) fixes the number of users; `ramping-arrival-rate` and
  `constant-arrival-rate` fix the request rate and add VUs as needed. Use arrival rate
  when you want to know "can it handle N requests per second?"
- `abortOnFail`: stop early once a threshold is clearly broken.
- Built-in `scenario` tag: compare `{scenario:reads}` with `{scenario:logins}`.

## 5. What the first runs showed

Measured locally on 2026-10-24 (Apple Silicon laptop, about 3,000 facilities):

- **Smoke:** all 24 checks pass.
- **Load:** 20 users, ~1,100 requests, 0 failures; p95 about 3 ms, far under the
  200 ms target.
- **Stress at 500 req/s:** reads p95 under 1 ms; logins p95 about 36 ms. Login is
  about 80 times slower than a read because it checks a scrypt password hash, which is
  slow on purpose. That's why `02-load.js` logs in once in `setup()`, and why a login
  flood is the first thing that would hurt this API.

- **Stress at 3,000 req/s peak and 20 logins/s:** still no breaking point. About
  152,000 requests, 0 failures, no dropped iterations; reads p95 0.29 ms, logins p95
  22 ms. With this little data, SQLite answers from memory.

So the default `MAX_RPS=500` won't find a limit on a laptop. To find your machine's
limit, raise `MAX_RPS` and `LOGIN_RPS` until thresholds fail or `dropped_iterations`
appears. At very high rates k6 itself can become the bottleneck, since it runs on the
same machine as the server; watch CPU for both. Results will change as the database
grows with the statewide sync.

## 6. Ideas to try next

- Add a `04-soak.js`: modest load for an hour to look for memory growth or slowdowns.
  The 15-minute token means each VU will need to log in again; handle it in the script.
- Run `01-smoke.js` in CI after deploys: it exits non-zero if anything breaks.
- Raise `PEAK_VUS` in `02-load.js` until a threshold fails, and see which endpoint
  fails first.
