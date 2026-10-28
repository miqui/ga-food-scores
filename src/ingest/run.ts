import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { syncLock, syncRuns, syncState } from '../db/schema.js';
import type { AppDb } from '../db/client.js';
import type { PortalClient } from './portal-client.js';
import { syncCounty } from './sync.js';

/** A lock whose heartbeat is older than this belongs to a process that died. */
export const LOCK_STALE_MS = 2 * 60_000;
const HEARTBEAT_MS = 30_000;

export interface SyncLockInfo {
  owner: string;
  counties: string[];
  acquiredAt: string;
  heartbeatAt: string;
}

export class SyncInProgressError extends Error {
  constructor(public readonly holder: SyncLockInfo) {
    super(`sync already in progress (owner ${holder.owner}, since ${holder.acquiredAt})`);
  }
}

export interface SyncLock {
  owner: string;
  counties: string[];
  /** Refresh the heartbeat; false if another process has taken the lock over. */
  heartbeat(): boolean;
  release(): void;
}

function toInfo(row: typeof syncLock.$inferSelect): SyncLockInfo {
  return {
    owner: row.owner,
    counties: JSON.parse(row.counties) as string[],
    acquiredAt: row.acquiredAt,
    heartbeatAt: row.heartbeatAt,
  };
}

function isLive(row: typeof syncLock.$inferSelect, now: number): boolean {
  return now - Date.parse(row.heartbeatAt) < LOCK_STALE_MS;
}

/** The lock of the sync running right now, from any process, or null. */
export function currentSyncLock(db: AppDb): SyncLockInfo | null {
  const row = db.select().from(syncLock).get();
  return row && isLive(row, Date.now()) ? toInfo(row) : null;
}

/**
 * Take the DB-wide sync lock, so the CLI and the admin endpoint (or two CLIs)
 * never sync at once: overlapping runs would multiply the portal request rate
 * and race on the same rows. A lock left behind by a dead process goes stale
 * after LOCK_STALE_MS and is taken over. Throws SyncInProgressError if held.
 */
export function acquireSyncLock(db: AppDb, counties: string[]): SyncLock {
  const owner = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  db.transaction(
    (tx) => {
      const row = tx.select().from(syncLock).get();
      if (row && isLive(row, Date.now())) throw new SyncInProgressError(toInfo(row));
      const now = new Date().toISOString();
      const lock = { owner, counties: JSON.stringify(counties), acquiredAt: now, heartbeatAt: now };
      tx.insert(syncLock)
        .values({ id: 1, ...lock })
        .onConflictDoUpdate({ target: syncLock.id, set: lock })
        .run();
      // Holding the lock means no other run is live, so any run still marked
      // running was cut off (crash, kill -9) before it could record its end.
      tx.update(syncRuns)
        .set({ status: 'interrupted', finishedAt: now, error: 'process ended without finishing' })
        .where(eq(syncRuns.status, 'running'))
        .run();
    },
    { behavior: 'immediate' },
  );

  return {
    owner,
    counties,
    heartbeat: () =>
      db
        .update(syncLock)
        .set({ heartbeatAt: new Date().toISOString() })
        .where(eq(syncLock.owner, owner))
        .run().changes === 1,
    release: () => {
      db.delete(syncLock).where(eq(syncLock.owner, owner)).run();
    },
  };
}

/**
 * Order counties for a sync of the default set: never-synced (or unfinished)
 * counties first, then by oldest last_synced_at. A run that's stopped early
 * then leaves the counties it didn't reach at the front of the next run,
 * instead of starting at APPLING every time.
 */
export function orderCountiesForSync(db: AppDb, counties: string[]): string[] {
  const lastSynced = new Map(
    db
      .select({ county: syncState.county, lastSyncedAt: syncState.lastSyncedAt, resumePage: syncState.resumePage })
      .from(syncState)
      .all()
      .map((r) => [r.county, r.resumePage ? '' : (r.lastSyncedAt ?? '')]),
  );
  return [...counties].sort((a, b) => (lastSynced.get(a) ?? '').localeCompare(lastSynced.get(b) ?? ''));
}

export interface SyncRunSummary {
  ok: string[];
  failed: string[];
  /** The county being synced when the run was stopped, if it was. */
  interrupted: string | null;
}

/**
 * Sync each of the lock's counties in order, recording one sync_runs row per
 * county, and release the lock when done. One failing county doesn't stop
 * the rest. When `signal` aborts (or the lock is lost), the current county
 * stops between facilities, is recorded as interrupted, and the run ends.
 */
export async function runSync(
  db: AppDb,
  client: PortalClient,
  lock: SyncLock,
  options: { signal?: AbortSignal } = {},
): Promise<SyncRunSummary> {
  const lockLost = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, lockLost.signal]) : lockLost.signal;
  const heartbeat = setInterval(() => {
    if (!lock.heartbeat()) lockLost.abort(new Error('sync lock was taken over by another process'));
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const summary: SyncRunSummary = { ok: [], failed: [], interrupted: null };
  try {
    for (const county of lock.counties) {
      if (signal.aborted) break;
      const run = db
        .insert(syncRuns)
        .values({ county, owner: lock.owner, startedAt: new Date().toISOString(), status: 'running' })
        .returning({ id: syncRuns.id })
        .get();
      const finish = (fields: Partial<typeof syncRuns.$inferInsert>) =>
        db
          .update(syncRuns)
          .set({ finishedAt: new Date().toISOString(), ...fields })
          .where(eq(syncRuns.id, run.id))
          .run();

      console.log(`[sync] starting county=${county}`);
      try {
        const result = await syncCounty(db, client, county, { signal });
        finish({ status: 'ok', result: JSON.stringify(result) });
        console.log(`[sync] done county=${county}`, JSON.stringify(result));
        summary.ok.push(county);
      } catch (err) {
        if (signal.aborted) {
          finish({ status: 'interrupted', error: errorMessage(signal.reason) });
          console.log(`[sync] stopped during county=${county}: ${errorMessage(signal.reason)}`);
          summary.interrupted = county;
          break;
        }
        finish({ status: 'failed', error: errorMessage(err) });
        console.error(`[sync] county=${county} failed:`, err);
        summary.failed.push(county);
      }
    }
  } finally {
    clearInterval(heartbeat);
    lock.release();
  }
  return summary;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The most recent sync_runs rows, newest first, with `result` parsed. */
export function recentSyncRuns(db: AppDb, limit = 50) {
  return db
    .select()
    .from(syncRuns)
    .orderBy(desc(syncRuns.id))
    .limit(limit)
    .all()
    .map((r) => ({ ...r, result: r.result ? (JSON.parse(r.result) as unknown) : null }));
}
