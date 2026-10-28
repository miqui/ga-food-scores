import { describe, it, expect } from 'vitest';
import { createDb } from '../../src/db/client.js';
import { syncLock, syncRuns, syncState } from '../../src/db/schema.js';
import {
  acquireSyncLock,
  currentSyncLock,
  LOCK_STALE_MS,
  orderCountiesForSync,
  recentSyncRuns,
  runSync,
  SyncInProgressError,
} from '../../src/ingest/run.js';
import type { PortalClient } from '../../src/ingest/portal-client.js';

describe('sync lock', () => {
  it('refuses a second holder until the first releases', () => {
    const { db } = createDb(':memory:');
    const first = acquireSyncLock(db, ['LONG']);
    expect(() => acquireSyncLock(db, ['BRYAN'])).toThrow(SyncInProgressError);
    expect(currentSyncLock(db)?.counties).toEqual(['LONG']);

    first.release();
    expect(currentSyncLock(db)).toBeNull();
    expect(() => acquireSyncLock(db, ['BRYAN']).release()).not.toThrow();
  });

  it('takes over a stale lock and marks its unfinished runs interrupted', () => {
    const { db } = createDb(':memory:');
    const dead = acquireSyncLock(db, ['LONG']);
    db.insert(syncRuns)
      .values({ county: 'LONG', owner: dead.owner, startedAt: new Date().toISOString(), status: 'running' })
      .run();
    const old = new Date(Date.now() - LOCK_STALE_MS - 1000).toISOString();
    db.update(syncLock).set({ heartbeatAt: old }).run();

    const lock = acquireSyncLock(db, ['BRYAN']);
    expect(db.select().from(syncRuns).get()?.status).toBe('interrupted');
    // The dead process can no longer heartbeat or release the new holder's lock.
    expect(dead.heartbeat()).toBe(false);
    dead.release();
    expect(currentSyncLock(db)?.owner).toBe(lock.owner);
  });
});

describe('runSync', () => {
  it('records each county, keeps going after a failure, and releases the lock', async () => {
    const { db } = createDb(':memory:');
    const client: PortalClient = {
      searchCounty: async (county) => {
        if (county === 'BRYAN') throw new Error('portal down');
        return [];
      },
      getInspections: async () => [],
    };
    const summary = await runSync(db, client, acquireSyncLock(db, ['BRYAN', 'LONG']));

    expect(summary).toEqual({ ok: ['LONG'], failed: ['BRYAN'], interrupted: null });
    const runs = recentSyncRuns(db);
    expect(runs.map((r) => [r.county, r.status])).toEqual([
      ['LONG', 'ok'],
      ['BRYAN', 'failed'],
    ]);
    expect(runs[1].error).toBe('portal down');
    expect(runs[0].result).toMatchObject({ county: 'LONG', pagesWalked: 0 });
    expect(currentSyncLock(db)).toBeNull();
  });

  it('stops at the current county when aborted and records it as interrupted', async () => {
    const { db } = createDb(':memory:');
    const stop = new AbortController();
    const facility = {
      id: 'QQ==',
      name: 'A',
      mapAddress: '1 MAIN ST\r\nPEMBROKE, GA 31321',
      columns: { '5': 'Last Inspection Date: 10-01-2026' },
    };
    const client: PortalClient = {
      searchCounty: async () => {
        stop.abort(new Error('stopped by SIGTERM'));
        return [facility];
      },
      getInspections: async () => [],
    };
    const summary = await runSync(db, client, acquireSyncLock(db, ['BRYAN', 'LONG']), { signal: stop.signal });

    expect(summary).toEqual({ ok: [], failed: [], interrupted: 'BRYAN' });
    const runs = recentSyncRuns(db);
    expect(runs.map((r) => [r.county, r.status, r.error])).toEqual([['BRYAN', 'interrupted', 'stopped by SIGTERM']]);
    expect(currentSyncLock(db)).toBeNull();
  });
});

describe('orderCountiesForSync', () => {
  it('puts never-synced and unfinished counties first, then the oldest', () => {
    const { db } = createDb(':memory:');
    db.insert(syncState)
      .values([
        { county: 'APPLING', lastSyncedAt: '2026-10-27T10:00:00Z' },
        { county: 'BACON', lastSyncedAt: '2026-10-20T10:00:00Z' },
        { county: 'BAKER', lastSyncedAt: '2026-10-28T10:00:00Z', resumePage: 4 },
      ])
      .run();
    expect(orderCountiesForSync(db, ['APPLING', 'ATKINSON', 'BACON', 'BAKER'])).toEqual([
      'ATKINSON',
      'BAKER',
      'BACON',
      'APPLING',
    ]);
  });
});
