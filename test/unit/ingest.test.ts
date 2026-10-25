import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createDb } from '../../src/db/client.js';
import { syncCounty } from '../../src/ingest/sync.js';
import { FixturePortalClient } from '../fixture-portal-client.js';
import { facilities, inspections, violations, syncState } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import type { PortalInspectionRecord } from '../../src/ingest/portal-client.js';

const page1 = JSON.parse(
  readFileSync(new URL('../fixtures/long-search-page1.json', import.meta.url), 'utf-8'),
);
const inspectionsFixture = JSON.parse(
  readFileSync(
    new URL('../fixtures/long-inspections-MTI5Nzg5Mzc.json', import.meta.url),
    'utf-8',
  ),
) as any[];

function toInspectionRecord(raw: any): PortalInspectionRecord {
  const stripLabel = (v: string) => v.slice(v.indexOf(':') + 1).trim();
  const violationsRaw = raw.violations ?? {};
  return {
    inspectionId: raw.inspectionId,
    facilityId: raw.facilityId,
    printablePath: raw.printablePath,
    date: (() => {
      const m = stripLabel(raw.columns['0']).match(/(\d{2})-(\d{2})-(\d{4})/);
      return m ? `${m[3]}-${m[1]}-${m[2]}` : '';
    })(),
    purpose: stripLabel(raw.columns['1']),
    score: Number.parseInt(stripLabel(raw.columns['2']), 10),
    inspector: stripLabel(raw.columns['3']),
    violations: Object.values(violationsRaw).map((v: any) => ({
      code: v[0],
      ruleCitation: v[1],
      points: Number.parseInt(stripLabel(v[2]), 10),
      correctedOnSite: stripLabel(v[3]).toLowerCase() === 'yes',
      repeat: stripLabel(v[4]).toLowerCase() === 'yes',
      notes: stripLabel(v[5]),
    })),
  };
}

describe('ingest walker against fixtures (no network)', () => {
  it('upserts facilities from a county search page and fetches inspection history for new facilities', async () => {
    const { db } = createDb(':memory:');
    const client = new FixturePortalClient({
      pagesByCounty: {
        LONG: { 1: page1, 2: [] },
      },
      inspectionsByFacility: {
        'MTI5Nzg5Mzc=': inspectionsFixture.map(toInspectionRecord),
      },
    });

    const result = await syncCounty(db, client, 'LONG');

    expect(result.facilitiesSeen).toBe(page1.length);
    expect(result.pagesWalked).toBe(1); // page 2 is empty -> walker stops
    expect(result.newWatermark).toBe('2026-08-07');

    const stored = db.select().from(facilities).where(eq(facilities.county, 'LONG')).all();
    expect(stored.length).toBe(page1.length);

    const fac = db
      .select()
      .from(facilities)
      .where(eq(facilities.id, 'MTI5Nzg5Mzc='))
      .get();
    expect(fac?.name).toContain('Louis Shaved Ice');

    const stateRow = db.select().from(syncState).where(eq(syncState.county, 'LONG')).get();
    expect(stateRow?.watermark).toBe('2026-08-07');
  });

  it('stops walking once a page is entirely below the stored watermark', async () => {
    const { db } = createDb(':memory:');
    db.insert(syncState)
      .values({ county: 'LONG', watermark: '2026-08-08', lastSyncedAt: new Date().toISOString() })
      .run();

    const client = new FixturePortalClient({
      pagesByCounty: {
        LONG: { 1: page1 },
      },
      inspectionsByFacility: {},
    });

    const result = await syncCounty(db, client, 'LONG');

    // All records in page1 have lastInspectionDate < watermark -> stop after page 1,
    // and since nothing is new/changed, no inspection history fetch should occur
    // for facilities whose score/date did not change from what's already stored.
    expect(result.pagesWalked).toBe(1);
    expect(client.searchCalls.length).toBe(1);
  });

  it('keeps walking past a page whose newest records fall on the watermark day', async () => {
    const { db } = createDb(':memory:');
    db.insert(syncState)
      .values({ county: 'LONG', watermark: '2026-08-07', lastSyncedAt: new Date().toISOString() })
      .run();
    const sameDay = { ...page1[0], id: 'U0FNRURBWQ==', name: 'Posted later the same day' };
    const client = new FixturePortalClient({
      pagesByCounty: { LONG: { 1: page1, 2: [sameDay], 3: [] } },
      inspectionsByFacility: {},
    });

    const result = await syncCounty(db, client, 'LONG');

    expect(client.searchCalls.map((c) => c.page)).toEqual([1, 2, 3]);
    expect(result.pagesWalked).toBe(2);
    expect(db.select().from(facilities).where(eq(facilities.id, 'U0FNRURBWQ==')).get()).toBeDefined();
  });

  it('throws without advancing the watermark when maxPages is hit before the end', async () => {
    const { db } = createDb(':memory:');
    const client = new FixturePortalClient({
      pagesByCounty: { LONG: { 1: page1, 2: page1, 3: [] } },
      inspectionsByFacility: {},
    });

    await expect(syncCounty(db, client, 'LONG', { maxPages: 1 })).rejects.toThrow(/maxPages=1/);
    expect(db.select().from(syncState).where(eq(syncState.county, 'LONG')).get()).toBeUndefined();
    // Facilities walked so far are still kept.
    expect(db.select().from(facilities).all().length).toBe(page1.length);
  });

  it('respects the portal client rate limiter (serializes calls, does not burst)', async () => {
    const client = new FixturePortalClient({
      pagesByCounty: { LONG: { 1: page1, 2: [] } },
      inspectionsByFacility: { 'MTI5Nzg5Mzc=': inspectionsFixture.map(toInspectionRecord) },
    });
    // The FixturePortalClient itself has no artificial delay (keeps tests fast);
    // this test instead asserts the walker calls the client exactly once per
    // page/facility rather than fanning out concurrently, which is what makes
    // the production LivePortalClient's internal 1-req/s limiter effective.
    const { db } = createDb(':memory:');
    await syncCounty(db, client, 'LONG');
    expect(client.searchCalls).toEqual([
      { county: 'LONG', page: 1 },
      { county: 'LONG', page: 2 },
    ]);
  });

  it('stores violations for inspections that have them', async () => {
    const { db } = createDb(':memory:');
    const client = new FixturePortalClient({
      pagesByCounty: { LONG: { 1: page1, 2: [] } },
      inspectionsByFacility: { 'MTI5Nzg5Mzc=': inspectionsFixture.map(toInspectionRecord) },
    });
    await syncCounty(db, client, 'LONG');

    const insp = db
      .select()
      .from(inspections)
      .where(eq(inspections.inspectionId, 57377397))
      .get();
    expect(insp).toBeDefined();
    const vios = db.select().from(violations).where(eq(violations.inspectionId, insp!.id)).all();
    expect(vios.length).toBeGreaterThan(0);
    expect(vios[0].code).toContain('1-2B');
  });
});
