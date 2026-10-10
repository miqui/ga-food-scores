# ga-coastal-food-scores

Read-only REST API serving Georgia Coastal Health District restaurant food-inspection
scores (facilities, inspections, violations), backed by a rate-limited ingest worker
that pulls from the Georgia DPH inspection portal.

## Data source & provenance

- Portal: https://ga.healthinspections.us/stateofgeorgia/ (the Georgia DPH
  Environmental Health inspection portal). 

- Base: `https://ga.healthinspections.us/stateofgeorgia/API/index.cfm`
  - `/facilities/<page>` — 5 records/page, newest-inspection-first.
  - `/search/<url-encoded JSON>/<page>` — same 5/page shape, filtered by
    base64-encoded `county`/`city`/`keyword` fields inside a JSON blob that is itself
    URL-encoded.
  - `/inspectionsData/<url-encoded base64 facilityId>` — full inspection + violation
    history for one facility.
- This project only ingests the 8 coastal Georgia counties: Bryan, Camden, Chatham,
  Effingham, Glynn, Liberty, Long, McIntosh.
- Trimmed, real (non-fabricated) response samples are committed under
  `test/fixtures/` for a Long County search page and one facility's inspection
  history, used to keep the test suite fully offline.

## Architecture

Hono (Node/TypeScript, ESM) HTTP API + SQLite via Drizzle ORM (`better-sqlite3`
driver) for storage, a self-rolled `hono/jwt` + `zod` auth layer (scrypt password
hashing, short-lived HS256 access tokens, DB-resolved roles for instant revocation),
and a rate-limited ingest module that walks the portal's paginated county search
results and upserts facilities/inspections/violations, usable both as a CLI
(`npm run sync`) and via an authenticated `POST /admin/sync` endpoint.

## Endpoints

| Method | Path                         | Auth          | Notes                                   |
| ------ | ---------------------------- | ------------- | ---------------------------------------- |
| GET    | `/healthz`                   | none          | liveness check                           |
| POST   | `/auth/register`             | none          | creates a `viewer` user (role not client-settable) |
| POST   | `/auth/login`                | none          | returns a 15-min HS256 JWT               |
| GET    | `/counties`                  | JWT           | the 8 coastal counties this API tracks   |
| GET    | `/facilities`                | JWT           | query: `county`, `city`, `min_score`, `q`, `page` |
| GET    | `/facilities/:id`            | JWT           | single facility                          |
| GET    | `/facilities/:id/inspections`| JWT           | inspection history for a facility        |
| GET    | `/inspections/:id`           | JWT           | one inspection + its violations; `:id` is the portal `inspectionId` |
| POST   | `/admin/sync`                | JWT + admin   | triggers an async ingest run, returns 202 |

Auth: send `Authorization: Bearer <token>` from `/auth/login`. `401` = missing/invalid/expired
token; `403` = valid token but insufficient role. Role is re-resolved from the `users`
table on every request (never trusted from the JWT claims), so revoking/demoting a
user takes effect immediately without needing to invalidate already-issued tokens.

## `.env.example`

```
JWT_SECRET=change-me-to-a-long-random-string
PORT=3000
DB_PATH=./data/app.db
COASTAL_COUNTIES=BRYAN,CAMDEN,CHATHAM,EFFINGHAM,GLYNN,LIBERTY,LONG,MCINTOSH
```

`JWT_SECRET` is required — the server refuses to start without it (fail fast).

## Load the database

There is no seed file or migration step. The database is a SQLite file at `DB_PATH`
(default `./data/app.db`). Tables are created automatically on first open, and you
fill it by running the ingest against the live portal.

```bash
npm install
npm run sync -- LONG   # one county (fast, ~36 facilities)
npm run sync           # all 8 coastal counties (slow, rate-limited)
```

Notes:

- The sync CLI reads real environment variables only, not `.env`. For a non-default
  path, pass it inline: `DB_PATH=./data/app.db npm run sync -- LONG`.
- Re-running is safe: records are upserted, and a per-county watermark is kept in
  `sync_state`.
- Use the same `DB_PATH` for the server (`npm run dev`) and the sync.
- If you see `Could not locate the bindings file`, the native `better-sqlite3`
  build was skipped. Newer npm blocks install scripts by default; run
  `npm install-scripts approve better-sqlite3 && npm rebuild better-sqlite3`.
- Alternatively, an admin can trigger an ingest via `POST /admin/sync`.

Query the data directly with the `sqlite3` CLI:

```bash
sqlite3 -header -column data/app.db \
  "SELECT name, city, last_inspection_score FROM facilities WHERE county='LONG' ORDER BY last_inspection_score LIMIT 10;"
```

## Run manually

These are the exact commands run to verify this project, with real output.

### 1. Install

```bash
npm install
```
```
added 205 packages, and audited 206 packages in 6s
4 moderate severity vulnerabilities (below the --audit-level=high CI gate)
```

### 2. Typecheck, lint, build, test

```bash
npm run typecheck   # tsc --noEmit -> no output, exit 0
npm run lint        # eslint . -> no output, exit 0
npm run build        # tsc -> dist/ produced, exit 0
npm test             # vitest run
```
```
 Test Files  4 passed (4)
      Tests  19 passed (19)
```

### 3. Start the dev server

```bash
JWT_SECRET="e2e-test-secret-do-not-use-in-prod" PORT=3344 DB_PATH="./data/app.db" npx tsx src/server.ts
```
```
ga-coastal-food-scores listening on http://localhost:3344
```

### 4. Health check

```bash
curl -s http://localhost:3344/healthz
```
```
{"status":"ok"}
```

### 5. Register, log in, call a protected endpoint

```bash
curl -s -X POST http://localhost:3344/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"e2e@example.com","password":"supersecret123"}'
```
```
{"id":1,"email":"e2e@example.com","role":"viewer"}
```

```bash
curl -s -X POST http://localhost:3344/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"e2e@example.com","password":"supersecret123"}' -o /tmp/login.json
TOKEN=$(python3 -c "import json; print(json.load(open('/tmp/login.json'))['access_token'])")
curl -s http://localhost:3344/counties -H "Authorization: Bearer $TOKEN"
```
```
{"counties":["BRYAN","CAMDEN","CHATHAM","EFFINGHAM","GLYNN","LIBERTY","LONG","MCINTOSH"]}
```

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3344/facilities   # no Authorization header
```
```
401
```

### 6. Run the sync CLI against the live portal (one small county)

```bash
JWT_SECRET="e2e-test-secret-do-not-use-in-prod" DB_PATH="./data/app.db" npx tsx src/ingest/cli.ts LONG
```
```
[sync] starting county=LONG
[sync] done county=LONG {"county":"LONG","pagesWalked":8,"facilitiesSeen":36,"facilitiesUpserted":36,"facilitiesWithNewInspections":36,"inspectionsUpserted":178,"violationsUpserted":101,"newWatermark":"2026-08-07"}
```

```bash
curl -s "http://localhost:3344/facilities?county=LONG" -H "Authorization: Bearer $TOKEN"
```
```
{"page":1,"pageSize":20,"total":36, "results":[{"id":"MTMwMDg1OTI=","name":"Royal Inn (Saral & Param 729, LLC.)", ...}]}
```

### Via the running API instead of the CLI

```bash
curl -s -X POST http://localhost:3344/admin/sync -H "Authorization: Bearer <admin JWT>"
# -> 202 {"status":"accepted","counties":[...]}
```

(Admin role is assigned directly in the `users` table; there is no self-service
promotion endpoint by design.)
