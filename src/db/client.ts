import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function createDb(dbPath: string) {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(sqlite);
  return { db, sqlite };
}

function migrate(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS facilities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      city TEXT NOT NULL DEFAULT '',
      county TEXT NOT NULL,
      permit_type TEXT NOT NULL,
      permit_number TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      last_inspection_score INTEGER,
      last_inspection_date TEXT,
      history_pending INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS facilities_county_idx ON facilities(county);
    CREATE INDEX IF NOT EXISTS facilities_city_idx ON facilities(city);
    CREATE INDEX IF NOT EXISTS facilities_name_idx ON facilities(name);

    CREATE TABLE IF NOT EXISTS inspections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inspection_id INTEGER NOT NULL,
      facility_id TEXT NOT NULL REFERENCES facilities(id),
      inspection_date TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT '',
      score INTEGER,
      inspector TEXT NOT NULL DEFAULT '',
      report_url TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS inspections_facility_idx ON inspections(facility_id);
    CREATE UNIQUE INDEX IF NOT EXISTS inspections_inspection_id_unique ON inspections(inspection_id);

    CREATE TABLE IF NOT EXISTS violations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inspection_id INTEGER NOT NULL REFERENCES inspections(id),
      code TEXT NOT NULL,
      rule_citation TEXT NOT NULL DEFAULT '',
      points INTEGER NOT NULL DEFAULT 0,
      corrected_on_site INTEGER NOT NULL DEFAULT 0,
      repeat INTEGER NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS violations_inspection_idx ON violations(inspection_id);

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      county TEXT PRIMARY KEY,
      watermark TEXT,
      last_synced_at TEXT
    );
  `);

  const facilityColumns = sqlite.prepare('PRAGMA table_info(facilities)').all() as { name: string }[];
  if (!facilityColumns.some((c) => c.name === 'history_pending')) {
    // One-time upgrade of a DB from before history_pending. Older syncs saved
    // the portal's "No Inspections To Display" placeholder as an inspection, and
    // could mark a facility current before its history was saved, so drop the
    // placeholders and flag every facility whose history is missing its latest
    // inspection; the next sync of its county re-fetches them.
    sqlite.transaction(() => {
      sqlite.exec(`
        ALTER TABLE facilities ADD COLUMN history_pending INTEGER NOT NULL DEFAULT 0;
        DELETE FROM violations WHERE inspection_id IN
          (SELECT id FROM inspections WHERE inspection_id = 0 OR inspection_date = '');
        DELETE FROM inspections WHERE inspection_id = 0 OR inspection_date = '';
        UPDATE facilities SET history_pending = 1
        WHERE last_inspection_date IS NOT NULL AND last_inspection_date <> ''
          AND NOT EXISTS (
            SELECT 1 FROM inspections i
            WHERE i.facility_id = facilities.id AND i.inspection_date >= facilities.last_inspection_date
          );
      `);
    })();
  }
}

export type AppDb = ReturnType<typeof createDb>['db'];
