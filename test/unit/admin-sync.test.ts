import { describe, it, expect } from 'vitest';
import { buildApp } from '../../src/app.js';
import { users } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import type { PortalClient } from '../../src/ingest/portal-client.js';

process.env.JWT_SECRET = 'test-secret-for-vitest';

/** Search never resolves until released, so a sync stays "in progress". */
function blockingClient() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const client: PortalClient = {
    searchCounty: async () => {
      await gate;
      return [];
    },
    getInspections: async () => [],
  };
  return { client, release };
}

async function adminApp(makeClient: () => PortalClient) {
  const { app, db } = buildApp(':memory:', makeClient);
  await app.request('/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'password123' }),
  });
  db.update(users).set({ role: 'admin' }).where(eq(users.email, 'admin@example.com')).run();
  const loginRes = await app.request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'password123' }),
  });
  const { access_token } = (await loginRes.json()) as any;
  const post = (body?: unknown) =>
    app.request('/admin/sync', {
      method: 'POST',
      headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { post };
}

describe('POST /admin/sync', () => {
  it('rejects unknown or non-string counties with 400', async () => {
    const { client } = blockingClient();
    const { post } = await adminApp(() => client);
    expect((await post({ county: 'CHATAM' })).status).toBe(400);
    expect((await post({ county: 5 })).status).toBe(400);
  });

  it('accepts multi-word counties and normalizes them', async () => {
    const { client, release } = blockingClient();
    const { post } = await adminApp(() => client);
    const res = await post({ county: 'ben hill' });
    expect(res.status).toBe(202);
    expect(((await res.json()) as any).counties).toEqual(['BEN HILL']);
    release();
  });

  it('refuses to start a second sync while one is running, then allows it after', async () => {
    const { client, release } = blockingClient();
    const { post } = await adminApp(() => client);
    expect((await post({ county: 'LONG' })).status).toBe(202);
    const busy = await post({ county: 'BRYAN' });
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as any).counties).toEqual(['LONG']);

    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await post({ county: 'BRYAN' })).status).toBe(202);
  });
});
