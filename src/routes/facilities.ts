import { Hono } from 'hono';
import { eq, and, gte, like, sql } from 'drizzle-orm';
import { facilities, inspections, violations } from '../db/schema.js';
import type { AppDb } from '../db/client.js';
import { GA_COUNTIES } from '../ingest/counties.js';

const PAGE_SIZE = 20;

export function facilitiesRoutes(getDb: () => AppDb) {
  const app = new Hono();

  app.get('/counties', (c) => {
    return c.json({ counties: GA_COUNTIES });
  });

  app.get('/facilities', (c) => {
    const db = getDb();
    const county = c.req.query('county');
    const city = c.req.query('city');
    const minScore = c.req.query('min_score');
    const q = c.req.query('q');
    const pageParam = Number.parseInt(c.req.query('page') ?? '1', 10);
    const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;

    const conditions = [] as any[];
    if (county) conditions.push(eq(facilities.county, county.toUpperCase()));
    if (city) conditions.push(eq(facilities.city, city));
    if (minScore) {
      const n = Number.parseInt(minScore, 10);
      if (Number.isFinite(n)) conditions.push(gte(facilities.lastInspectionScore, n));
    }
    if (q) conditions.push(like(facilities.name, `%${q}%`));

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = db
      .select()
      .from(facilities)
      .where(whereClause)
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE)
      .all();

    const totalRow = db
      .select({ count: sql<number>`count(*)` })
      .from(facilities)
      .where(whereClause)
      .get();

    return c.json({
      page,
      pageSize: PAGE_SIZE,
      total: totalRow?.count ?? 0,
      results: rows,
    });
  });

  app.get('/facilities/:id', (c) => {
    const db = getDb();
    const id = c.req.param('id');
    const row = db.select().from(facilities).where(eq(facilities.id, id)).get();
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json(row);
  });

  app.get('/facilities/:id/inspections', (c) => {
    const db = getDb();
    const id = c.req.param('id');
    const facility = db.select().from(facilities).where(eq(facilities.id, id)).get();
    if (!facility) return c.json({ error: 'not found' }, 404);
    const rows = db
      .select()
      .from(inspections)
      .where(eq(inspections.facilityId, id))
      .orderBy(sql`${inspections.inspectionDate} DESC`)
      .all();
    return c.json({ facilityId: id, inspections: rows });
  });

  app.get('/inspections/:id', (c) => {
    const db = getDb();
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);
    const inspection = db
      .select()
      .from(inspections)
      .where(eq(inspections.inspectionId, id))
      .get();
    if (!inspection) return c.json({ error: 'not found' }, 404);
    const violationRows = db
      .select()
      .from(violations)
      .where(eq(violations.inspectionId, inspection.id))
      .all();
    return c.json({ ...inspection, violations: violationRows });
  });

  return app;
}
