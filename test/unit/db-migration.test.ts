import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '../../src/db/client.js';

describe('history_pending upgrade of an existing DB', () => {
  it('adds the column, drops placeholder inspections and flags incomplete histories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ga-food-scores-'));
    const dbPath = join(dir, 'old.db');
    try {
      // Schema and data as written by a sync from before history_pending.
      const old = new Database(dbPath);
      old.exec(`
        CREATE TABLE facilities (id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT NOT NULL,
          city TEXT NOT NULL DEFAULT '', county TEXT NOT NULL, permit_type TEXT NOT NULL,
          permit_number TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
          last_inspection_score INTEGER, last_inspection_date TEXT, updated_at TEXT NOT NULL);
        CREATE TABLE inspections (id INTEGER PRIMARY KEY AUTOINCREMENT, inspection_id INTEGER NOT NULL,
          facility_id TEXT NOT NULL REFERENCES facilities(id), inspection_date TEXT NOT NULL,
          purpose TEXT NOT NULL DEFAULT '', score INTEGER, inspector TEXT NOT NULL DEFAULT '',
          report_url TEXT NOT NULL DEFAULT '');
        CREATE UNIQUE INDEX inspections_inspection_id_unique ON inspections(inspection_id);
        CREATE TABLE violations (id INTEGER PRIMARY KEY AUTOINCREMENT,
          inspection_id INTEGER NOT NULL REFERENCES inspections(id), code TEXT NOT NULL,
          rule_citation TEXT NOT NULL DEFAULT '', points INTEGER NOT NULL DEFAULT 0,
          corrected_on_site INTEGER NOT NULL DEFAULT 0, repeat INTEGER NOT NULL DEFAULT 0,
          notes TEXT NOT NULL DEFAULT '');

        INSERT INTO facilities (id, name, address, county, permit_type, last_inspection_date, updated_at) VALUES
          ('complete', 'A', '', 'LONG', 'Food Service', '2026-08-01', ''),
          ('newer', 'B', '', 'LONG', 'Food Service', '2026-03-12', ''),
          ('stale', 'C', '', 'LONG', 'Food Service', '2026-10-07', ''),
          ('orphan', 'D', '', 'LONG', 'Food Service', '2026-09-14', ''),
          ('never', 'E', '', 'LONG', 'Food Service', '', '');
        INSERT INTO inspections (id, inspection_id, facility_id, inspection_date) VALUES
          (1, 101, 'complete', '2026-08-01'),
          (2, 102, 'newer', '2026-09-11'),
          (3, 103, 'stale', '2026-04-10'),
          (4, 0, 'orphan', '');
        INSERT INTO violations (inspection_id, code) VALUES (4, 'X'), (1, 'Y');
      `);
      old.close();

      const { sqlite } = createDb(dbPath);
      const pending = sqlite
        .prepare('SELECT id FROM facilities WHERE history_pending = 1 ORDER BY id')
        .all()
        .map((r: any) => r.id);
      expect(pending).toEqual(['orphan', 'stale']);
      expect(sqlite.prepare('SELECT COUNT(*) n FROM inspections WHERE inspection_id = 0').get()).toEqual({ n: 0 });
      expect(sqlite.prepare('SELECT code FROM violations').all()).toEqual([{ code: 'Y' }]);
      sqlite.close();

      // Opening again must not re-run the upgrade (the column now exists).
      createDb(dbPath).sqlite.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
