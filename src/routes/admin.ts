import { Hono } from 'hono';
import { requireAdmin } from '../auth/middleware.js';
import { syncCounty } from '../ingest/sync.js';
import { LivePortalClient } from '../ingest/live-portal-client.js';
import type { PortalClient } from '../ingest/portal-client.js';
import { defaultSyncCounties, normalizeCounty } from '../ingest/counties.js';
import type { AppDb } from '../db/client.js';

export function adminRoutes(getDb: () => AppDb, makeClient: () => PortalClient = () => new LivePortalClient()) {
  const app = new Hono();
  // Only one sync at a time: overlapping runs would multiply the portal request
  // rate (each client has its own limiter) and race on the same county's rows.
  let running: string[] | null = null;

  app.post('/sync', requireAdmin(), async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { county?: unknown };
    let counties: string[];
    if (body?.county !== undefined) {
      const county = normalizeCounty(body.county);
      if (!county) return c.json({ error: 'unknown Georgia county' }, 400);
      counties = [county];
    } else {
      counties = defaultSyncCounties();
    }

    if (running) {
      return c.json({ error: 'sync already in progress', counties: running }, 409);
    }

    const db = getDb();
    const client = makeClient();
    running = counties;

    // Fire-and-forget async run; respond 202 immediately per spec.
    void (async () => {
      try {
        for (const cnty of counties) {
          try {
            await syncCounty(db, client, cnty);
          } catch (err) {
            console.error(`[admin/sync] county=${cnty} failed:`, err);
          }
        }
      } finally {
        running = null;
      }
    })();

    return c.json({ status: 'accepted', counties }, 202);
  });

  return app;
}
