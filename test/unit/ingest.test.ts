import { describe, it, expect, vi } from 'vitest';
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

describe('CLAY search also returning CLAYTON facilities', () => {
  // The portal's county search is a substring match, so "CLAY" returns CLAYTON too.
  const record = (id: string, address: string, date: string) => ({
    ...page1[0],
    id,
    mapAddress: address,
    columns: { ...page1[0].columns, '5': `Last Inspection Date: ${date}` },
  });
  const clay = record('Q0xBWQ==', '105 S HANCOCK ST \r\nFORT GAINES, GA 39851', '09-09-2026');
  const clayton = record('Q0xBWVRPTg==', '1 MAIN ST \r\nJONESBORO, GA 30236', '10-20-2026');

  it('skips CLAYTON records and keeps them out of the CLAY watermark', async () => {
    const { db } = createDb(':memory:');
    const client = new FixturePortalClient({
      pagesByCounty: { CLAY: { 1: [clayton, clay], 2: [] } },
      inspectionsByFacility: {},
    });

    const result = await syncCounty(db, client, 'CLAY');

    expect(result.facilitiesSeen).toBe(2);
    expect(result.facilitiesSkipped).toBe(1);
    expect(result.newWatermark).toBe('2026-09-09');
    expect(db.select().from(facilities).all().map((f) => f.id)).toEqual([clay.id]);
    expect(client.inspectionCalls).toEqual([clay.id]);
  });

  it('does not relabel CLAYTON facilities when CLAY is synced after CLAYTON', async () => {
    const { db } = createDb(':memory:');
    const client = new FixturePortalClient({
      pagesByCounty: { CLAYTON: { 1: [clayton], 2: [] }, CLAY: { 1: [clayton, clay], 2: [] } },
      inspectionsByFacility: {},
    });

    await syncCounty(db, client, 'CLAYTON');
    await syncCounty(db, client, 'CLAY');

    expect(db.select().from(facilities).where(eq(facilities.id, clayton.id)).get()?.county).toBe('CLAYTON');
  });

  it('keeps walking past a page of new CLAYTON-only records', async () => {
    const { db } = createDb(':memory:');
    db.insert(syncState)
      .values({ county: 'CLAY', watermark: '2026-09-01', lastSyncedAt: new Date().toISOString() })
      .run();
    const client = new FixturePortalClient({
      pagesByCounty: { CLAY: { 1: [clayton], 2: [clay], 3: [] } },
      inspectionsByFacility: {},
    });

    const result = await syncCounty(db, client, 'CLAY');

    expect(client.searchCalls.map((c) => c.page)).toEqual([1, 2, 3]);
    expect(db.select().from(facilities).where(eq(facilities.id, clay.id)).get()).toBeDefined();
    expect(result.newWatermark).toBe('2026-09-09');
  });
});

describe('inspection history integrity', () => {
  const listing = (date: string, score: number) => ({
    ...page1[0],
    id: 'SElTVE9SWQ==',
    columns: {
      ...page1[0].columns,
      '4': `Last Inspection Score: ${score}`,
      '5': `Last Inspection Date: ${date}`,
    },
  });
  const inspection = (inspectionId: number, date: string): PortalInspectionRecord => ({
    inspectionId,
    facilityId: 'SElTVE9SWQ==',
    printablePath: '',
    date,
    purpose: 'Routine',
    score: 90,
    inspector: 'Inspector',
    violations: [],
  });
  const facility = (db: ReturnType<typeof createDb>['db']) =>
    db.select().from(facilities).where(eq(facilities.id, 'SElTVE9SWQ==')).get();
  const inspectionCount = (db: ReturnType<typeof createDb>['db']) =>
    db.select().from(inspections).where(eq(inspections.facilityId, 'SElTVE9SWQ==')).all().length;

  it('leaves the facility row unchanged when the history fetch fails, so the next run retries', async () => {
    const { db } = createDb(':memory:');
    const first = new FixturePortalClient({
      pagesByCounty: { LONG: { 1: [listing('08-01-2026', 90)], 2: [] } },
      inspectionsByFacility: { 'SElTVE9SWQ==': [inspection(1, '2026-08-01')] },
    });
    await syncCounty(db, first, 'LONG');

    const failing = new FixturePortalClient({
      pagesByCounty: { LONG: { 1: [listing('10-01-2026', 80)], 2: [] } },
      inspectionsByFacility: {},
    });
    failing.getInspections = async () => {
      throw new Error('portal down');
    };
    await expect(syncCounty(db, failing, 'LONG')).rejects.toThrow('portal down');
    expect(facility(db)?.lastInspectionDate).toBe('2026-08-01');
    expect(facility(db)?.lastInspectionScore).toBe(90);

    const recovered = new FixturePortalClient({
      pagesByCounty: { LONG: { 1: [listing('10-01-2026', 80)], 2: [] } },
      inspectionsByFacility: { 'SElTVE9SWQ==': [inspection(2, '2026-10-01'), inspection(1, '2026-08-01')] },
    });
    await syncCounty(db, recovered, 'LONG');
    expect(recovered.inspectionCalls).toEqual(['SElTVE9SWQ==']);
    expect(facility(db)?.lastInspectionDate).toBe('2026-10-01');
    expect(inspectionCount(db)).toBe(2);
  });

  it('does not store a new facility when its first history fetch fails', async () => {
    const { db } = createDb(':memory:');
    const failing = new FixturePortalClient({
      pagesByCounty: { LONG: { 1: [listing('10-01-2026', 80)], 2: [] } },
      inspectionsByFacility: {},
    });
    failing.getInspections = async () => {
      throw new Error('portal down');
    };
    await expect(syncCounty(db, failing, 'LONG')).rejects.toThrow('portal down');
    expect(facility(db)).toBeUndefined();
  });

  it('flags a history missing the listed inspection and retries it after the walk', async () => {
    const { db } = createDb(':memory:');
    const notYetPosted = new FixturePortalClient({
      pagesByCounty: { LONG: { 1: [listing('10-01-2026', 80)], 2: [] } },
      inspectionsByFacility: { 'SElTVE9SWQ==': [inspection(1, '2026-08-01')] },
    });
    const first = await syncCounty(db, notYetPosted, 'LONG');
    expect(first.historiesPending).toBe(1);
    expect(facility(db)?.historyPending).toBe(true);
    // The listing itself is still stored as the portal shows it.
    expect(facility(db)?.lastInspectionDate).toBe('2026-10-01');

    // Next run: a newer facility fills page 1 and the walk stops at the watermark
    // before reaching this one, so only the post-walk retry can pick it up.
    const newer = { ...listing('10-20-2026', 95), id: 'TkVXRVI=' };
    const older = { ...listing('01-01-2026', 95), id: 'T0xERVI=' };
    const posted = new FixturePortalClient({
      pagesByCounty: { LONG: { 1: [newer], 2: [older], 3: [] } },
      inspectionsByFacility: {
        'SElTVE9SWQ==': [inspection(2, '2026-10-01'), inspection(1, '2026-08-01')],
      },
    });
    db.update(syncState).set({ watermark: '2026-10-15' }).where(eq(syncState.county, 'LONG')).run();
    const second = await syncCounty(db, posted, 'LONG');

    expect(posted.searchCalls.map((c) => c.page)).toEqual([1, 2]);
    expect(posted.inspectionCalls).toContain('SElTVE9SWQ==');
    expect(second.historiesRetried).toBeGreaterThanOrEqual(1);
    expect(facility(db)?.historyPending).toBe(false);
    expect(inspectionCount(db)).toBe(2);
  });

  it('continues after a pending history fetch fails and retries that facility on the next sync', async () => {
    const { db } = createDb(':memory:');
    const secondId = 'UkVUUlk=';
    const initial = new FixturePortalClient({
      pagesByCounty: {
        LONG: { 1: [listing('10-01-2026', 80), { ...listing('10-01-2026', 90), id: secondId }] },
      },
      inspectionsByFacility: { 'SElTVE9SWQ==': [inspection(1, '2026-08-01')] },
    });
    await syncCounty(db, initial, 'LONG');
    const beforeFailure = facility(db);

    const retry = new FixturePortalClient({
      pagesByCounty: { LONG: { 1: [] } },
      inspectionsByFacility: {
        [secondId]: [{ ...inspection(2, '2026-10-01'), facilityId: secondId }],
      },
    });
    const error = new Error('portal down');
    const fetch = vi.spyOn(retry, 'getInspections').mockRejectedValueOnce(error);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await syncCounty(db, retry, 'LONG');

      expect(fetch.mock.calls).toEqual([['SElTVE9SWQ=='], [secondId]]);
      expect(log).toHaveBeenCalledExactlyOnceWith(
        '[sync] county=LONG facility=SElTVE9SWQ== history retry failed:',
        error,
      );
      expect(result.historiesPending).toBe(1);
      expect(result.historiesRetried).toBe(1);
      expect(result.inspectionsUpserted).toBe(1);
      expect(facility(db)).toEqual(beforeFailure);
      expect(inspectionCount(db)).toBe(1);
      expect(db.select().from(facilities).where(eq(facilities.id, secondId)).get()?.historyPending).toBe(false);

      const recovered = new FixturePortalClient({
        pagesByCounty: { LONG: { 1: [] } },
        inspectionsByFacility: {
          'SElTVE9SWQ==': [inspection(3, '2026-10-01'), inspection(1, '2026-08-01')],
        },
      });
      const next = await syncCounty(db, recovered, 'LONG');

      expect(recovered.inspectionCalls).toEqual(['SElTVE9SWQ==']);
      expect(next.historiesRetried).toBe(1);
      expect(next.historiesPending).toBe(0);
      expect(facility(db)?.historyPending).toBe(false);
      expect(inspectionCount(db)).toBe(2);
    } finally {
      log.mockRestore();
      fetch.mockRestore();
    }
  });

  it('accepts a history whose newest inspection is later than the listed date', async () => {
    const { db } = createDb(':memory:');
    const client = new FixturePortalClient({
      pagesByCounty: { LONG: { 1: [listing('03-12-2026', 88)], 2: [] } },
      inspectionsByFacility: { 'SElTVE9SWQ==': [inspection(2, '2026-09-11'), inspection(1, '2026-03-01')] },
    });
    await syncCounty(db, client, 'LONG');
    expect(facility(db)?.historyPending).toBe(false);
  });
});
