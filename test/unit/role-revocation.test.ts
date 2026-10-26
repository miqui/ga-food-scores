import { describe, it, expect } from 'vitest';
import { buildApp } from '../../src/app.js';
import { users } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { FixturePortalClient } from '../fixture-portal-client.js';

process.env.JWT_SECRET = 'test-secret-for-vitest';

const noNetworkClient = () => new FixturePortalClient({ pagesByCounty: {}, inspectionsByFacility: {} });

describe('role resolution is revocation-safe (DB, not JWT claims)', () => {
  it('reflects an admin promotion/demotion immediately without reissuing the token', async () => {
    const { app, db } = buildApp(':memory:', noNetworkClient);

    await app.request('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'promote@example.com', password: 'password123' }),
    });
    const loginRes = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'promote@example.com', password: 'password123' }),
    });
    const { access_token: token } = (await loginRes.json()) as any;

    // Still viewer -> admin route forbidden.
    const forbidden = await app.request('/admin/sync', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(forbidden.status).toBe(403);

    // Promote directly in the DB (simulating an admin action) without issuing a new token.
    db.update(users).set({ role: 'admin' }).where(eq(users.email, 'promote@example.com')).run();

    const allowed = await app.request('/admin/sync', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(allowed.status).toBe(202);

    // Demote again; the SAME token should immediately lose admin access.
    db.update(users).set({ role: 'viewer' }).where(eq(users.email, 'promote@example.com')).run();

    const forbiddenAgain = await app.request('/admin/sync', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(forbiddenAgain.status).toBe(403);
  });

  it('returns 401 once the user row has been deleted (revocation)', async () => {
    const { app, db } = buildApp(':memory:');
    await app.request('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'deleteme@example.com', password: 'password123' }),
    });
    const loginRes = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'deleteme@example.com', password: 'password123' }),
    });
    const { access_token: token } = (await loginRes.json()) as any;

    db.delete(users).where(eq(users.email, 'deleteme@example.com')).run();

    const res = await app.request('/facilities', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });
});
