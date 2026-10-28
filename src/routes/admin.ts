import { Hono } from 'hono';
import { requireAdmin } from '../auth/middleware.js';
import { LivePortalClient } from '../ingest/live-portal-client.js';
import type { PortalClient } from '../ingest/portal-client.js';
import { defaultSyncCounties, normalizeCounty } from '../ingest/counties.js';
import {
  acquireSyncLock,
  currentSyncLock,
  orderCountiesForSync,
  recentSyncRuns,
  runSync,
  SyncInProgressError,
  type SyncLock,
} from '../ingest/run.js';
import type { AppDb } from '../db/client.js';

export function adminRoutes(getDb: () => AppDb, makeClient: () => PortalClient = () => new LivePortalClient()) {
  const app = new Hono();

  app.post('/sync', requireAdmin(), async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { county?: unknown };
    const db = getDb();
    let counties: string[];
    if (body?.county !== undefined) {
      const county = normalizeCounty(body.county);
      if (!county) return c.json({ error: 'unknown Georgia county' }, 400);
      counties = [county];
    } else {
      counties = orderCountiesForSync(db, defaultSyncCounties());
    }

    // The lock lives in the DB, so this also refuses while a CLI sync is running.
    let lock: SyncLock;
    try {
      lock = acquireSyncLock(db, counties);
    } catch (err) {
      if (err instanceof SyncInProgressError) {
        return c.json({ error: 'sync already in progress', counties: err.holder.counties }, 409);
      }
      throw err;
    }

    // Fire-and-forget async run; respond 202 immediately per spec. Progress is
    // recorded in sync_runs (GET /admin/sync).
    void runSync(db, makeClient(), lock).catch((err) => console.error('[admin/sync] run failed:', err));

    return c.json({ status: 'accepted', counties }, 202);
  });

  app.get('/sync', requireAdmin(), (c) => {
    const db = getDb();
    return c.json({ running: currentSyncLock(db), runs: recentSyncRuns(db) });
  });

  return app;
}
