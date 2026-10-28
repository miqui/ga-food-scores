import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const facilities = sqliteTable(
  'facilities',
  {
    id: text('id').primaryKey(), // stable portal facilityId (base64)
    name: text('name').notNull(),
    address: text('address').notNull(),
    city: text('city').notNull().default(''),
    county: text('county').notNull(),
    permitType: text('permit_type').notNull(),
    permitNumber: text('permit_number').notNull().default(''),
    phone: text('phone').notNull().default(''),
    lastInspectionScore: integer('last_inspection_score'),
    lastInspectionDate: text('last_inspection_date'), // ISO yyyy-mm-dd
    // The stored history doesn't yet include lastInspectionDate; sync retries it.
    historyPending: integer('history_pending', { mode: 'boolean' }).notNull().default(false),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    countyIdx: index('facilities_county_idx').on(t.county),
    cityIdx: index('facilities_city_idx').on(t.city),
    nameIdx: index('facilities_name_idx').on(t.name),
  }),
);

export const inspections = sqliteTable(
  'inspections',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    inspectionId: integer('inspection_id').notNull(), // portal inspectionId
    facilityId: text('facility_id')
      .notNull()
      .references(() => facilities.id),
    inspectionDate: text('inspection_date').notNull(), // ISO yyyy-mm-dd
    purpose: text('purpose').notNull().default(''),
    score: integer('score'),
    inspector: text('inspector').notNull().default(''),
    reportUrl: text('report_url').notNull().default(''),
  },
  (t) => ({
    facilityIdx: index('inspections_facility_idx').on(t.facilityId),
    inspectionIdUnique: uniqueIndex('inspections_inspection_id_unique').on(t.inspectionId),
  }),
);

export const violations = sqliteTable(
  'violations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    inspectionId: integer('inspection_id')
      .notNull()
      .references(() => inspections.id),
    code: text('code').notNull(),
    ruleCitation: text('rule_citation').notNull().default(''),
    points: integer('points').notNull().default(0),
    correctedOnSite: integer('corrected_on_site', { mode: 'boolean' }).notNull().default(false),
    repeat: integer('repeat', { mode: 'boolean' }).notNull().default(false),
    notes: text('notes').notNull().default(''),
  },
  (t) => ({
    inspectionIdx: index('violations_inspection_idx').on(t.inspectionId),
  }),
);

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['viewer', 'admin'] })
    .notNull()
    .default('viewer'),
  createdAt: text('created_at').notNull(),
});

export const syncState = sqliteTable('sync_state', {
  county: text('county').primaryKey(),
  watermark: text('watermark'), // ISO yyyy-mm-dd of the most recent inspection date seen
  lastSyncedAt: text('last_synced_at'),
  // Checkpoint of an unfinished walk: the next page to fetch, and the newest
  // date seen on the pages already walked. Both null once a walk completes.
  resumePage: integer('resume_page'),
  resumeNewest: text('resume_newest'),
});

/** At most one row (id 1): the process currently running a sync, kept fresh by heartbeats. */
export const syncLock = sqliteTable('sync_lock', {
  id: integer('id').primaryKey(),
  owner: text('owner').notNull(),
  counties: text('counties').notNull(), // JSON array
  acquiredAt: text('acquired_at').notNull(),
  heartbeatAt: text('heartbeat_at').notNull(),
});

/** One row per county per sync run. */
export const syncRuns = sqliteTable(
  'sync_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    county: text('county').notNull(),
    owner: text('owner').notNull(),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
    status: text('status', { enum: ['running', 'ok', 'failed', 'interrupted'] }).notNull(),
    result: text('result'), // JSON SyncResult when status is ok
    error: text('error'),
  },
  (t) => ({
    startedIdx: index('sync_runs_started_idx').on(t.startedAt),
  }),
);
