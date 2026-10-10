import { describe, it, expect } from 'vitest';
import { buildApp } from '../../src/app.js';
import { facilities, inspections, violations } from '../../src/db/schema.js';
import { FixturePortalClient } from '../fixture-portal-client.js';

process.env.JWT_SECRET = 'test-secret-for-vitest';

const noNetworkClient = () => new FixturePortalClient({ pagesByCounty: {}, inspectionsByFacility: {} });

async function authedApp() {
  const { app, db } = buildApp(':memory:', noNetworkClient);
  await app.request('/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'reader@example.com', password: 'password123' }),
  });
  const loginRes = await app.request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'reader@example.com', password: 'password123' }),
  });
  const { access_token: token } = await loginRes.json();
  return { app, db, token };
}

describe('facilities API', () => {
  it('filters by county, city, min_score, q and paginates', async () => {
    const { app, db, token } = await authedApp();

    for (let i = 0; i < 25; i++) {
      db.insert(facilities)
        .values({
          id: `fac-${i}`,
          name: i % 2 === 0 ? `Pizza Place ${i}` : `Burger Joint ${i}`,
          address: '123 Main St',
          city: i < 15 ? 'SAVANNAH' : 'RICHMOND HILL',
          county: i < 20 ? 'CHATHAM' : 'LONG',
          permitType: 'Food Service',
          permitNumber: `FSP-${i}`,
          phone: '',
          lastInspectionScore: 80 + i,
          lastInspectionDate: '2026-01-01',
          updatedAt: new Date().toISOString(),
        })
        .run();
    }

    const headers = { Authorization: `Bearer ${token}` };

    const countyRes = await app.request('/facilities?county=chatham', { headers });
    expect(countyRes.status).toBe(200);
    const countyBody = await countyRes.json();
    expect(countyBody.total).toBe(20);

    const cityRes = await app.request('/facilities?city=SAVANNAH', { headers });
    const cityBody = await cityRes.json();
    expect(cityBody.total).toBe(15);

    const scoreRes = await app.request('/facilities?min_score=100', { headers });
    const scoreBody = await scoreRes.json();
    expect(scoreBody.total).toBe(5); // scores 100..104 (i=20..24)

    const qRes = await app.request('/facilities?q=Pizza', { headers });
    const qBody = await qRes.json();
    expect(qBody.total).toBe(13); // even i in 0..24 inclusive -> 13

    const page1 = await app.request('/facilities?page=1', { headers });
    const page1Body = await page1.json();
    expect(page1Body.results.length).toBe(20);

    const page2 = await app.request('/facilities?page=2', { headers });
    const page2Body = await page2.json();
    expect(page2Body.results.length).toBe(5);
  });

  it('returns 404 for an unknown facility id', async () => {
    const { app, token } = await authedApp();
    const res = await app.request('/facilities/does-not-exist', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  it('lists inspections for a facility and 404s for unknown', async () => {
    const { app, db, token } = await authedApp();
    db.insert(facilities)
      .values({
        id: 'fac-x',
        name: 'Test Diner',
        address: '1 Rd',
        city: 'SAVANNAH',
        county: 'CHATHAM',
        permitType: 'Food Service',
        permitNumber: 'FSP-X',
        phone: '',
        lastInspectionScore: 95,
        lastInspectionDate: '2026-01-01',
        updatedAt: new Date().toISOString(),
      })
      .run();
    db.insert(inspections)
      .values({
        inspectionId: 1001,
        facilityId: 'fac-x',
        inspectionDate: '2026-01-01',
        purpose: 'Routine',
        score: 95,
        inspector: 'Jane Doe',
        reportUrl: 'http://example.com/1',
      })
      .run();

    const res = await app.request('/facilities/fac-x/inspections', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.inspections.length).toBe(1);

    const notFound = await app.request('/facilities/nope/inspections', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(notFound.status).toBe(404);
  });

  it('returns an inspection with its violations', async () => {
    const { app, db, token } = await authedApp();
    db.insert(facilities)
      .values({
        id: 'fac-y',
        name: 'Violation House',
        address: '2 Rd',
        city: 'SAVANNAH',
        county: 'CHATHAM',
        permitType: 'Food Service',
        permitNumber: 'FSP-Y',
        phone: '',
        lastInspectionScore: 80,
        lastInspectionDate: '2026-01-01',
        updatedAt: new Date().toISOString(),
      })
      .run();
    const result = db
      .insert(inspections)
      .values({
        inspectionId: 2002,
        facilityId: 'fac-y',
        inspectionDate: '2026-01-01',
        purpose: 'Routine',
        score: 80,
        inspector: 'John Smith',
        reportUrl: 'http://example.com/2',
      })
      .run();
    const inspectionLocalId = Number(result.lastInsertRowid);
    db.insert(violations)
      .values({
        inspectionId: inspectionLocalId,
        code: '1-2B',
        ruleCitation: '511-6-1.03',
        points: 4,
        correctedOnSite: false,
        repeat: true,
        notes: 'test note',
      })
      .run();

    const res = await app.request('/inspections/2002', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.violations.length).toBe(1);
    expect(body.violations[0].code).toBe('1-2B');

    const notFound = await app.request('/inspections/999999', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(notFound.status).toBe(404);
  });

  it('exposes /counties and public /healthz', async () => {
    const { app, token } = await authedApp();
    const healthRes = await app.request('/healthz');
    expect(healthRes.status).toBe(200);

    const countiesRes = await app.request('/counties', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(countiesRes.status).toBe(200);
    const body = await countiesRes.json();
    expect(body.counties).toContain('CHATHAM');
  });
});
