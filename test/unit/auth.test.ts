import { describe, it, expect, beforeEach } from 'vitest';
import { buildApp } from '../../src/app.js';
import { FixturePortalClient } from '../fixture-portal-client.js';

process.env.JWT_SECRET = 'test-secret-for-vitest';

const noNetworkClient = () => new FixturePortalClient({ pagesByCounty: {}, inspectionsByFacility: {} });

describe('auth', () => {
  let app: ReturnType<typeof buildApp>['app'];

  beforeEach(() => {
    ({ app } = buildApp(':memory:', noNetworkClient));
  });

  it('registers a new viewer user and ignores a client-supplied role', async () => {
    const res = await app.request('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@example.com', password: 'password123', role: 'admin' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.role).toBe('viewer');
  });

  it('rejects registration with invalid email/password', async () => {
    const res = await app.request('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', password: 'x' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects duplicate registration', async () => {
    await app.request('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'dup@example.com', password: 'password123' }),
    });
    const res = await app.request('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'dup@example.com', password: 'password123' }),
    });
    expect(res.status).toBe(409);
  });

  it('logs in and returns a JWT access token', async () => {
    await app.request('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'login@example.com', password: 'password123' }),
    });
    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'login@example.com', password: 'password123' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(typeof body.access_token).toBe('string');
    expect(body.token_type).toBe('Bearer');
  });

  it('rejects login with wrong password', async () => {
    await app.request('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'wrongpw@example.com', password: 'password123' }),
    });
    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'wrongpw@example.com', password: 'nope12345' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for a protected route with no Authorization header', async () => {
    const res = await app.request('/facilities');
    expect(res.status).toBe(401);
  });

  it('returns 401 for a protected route with a malformed/invalid token', async () => {
    const res = await app.request('/facilities', {
      headers: { Authorization: 'Bearer not-a-real-token' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 403 for admin route accessed by a viewer', async () => {
    await app.request('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'viewer@example.com', password: 'password123' }),
    });
    const loginRes = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'viewer@example.com', password: 'password123' }),
    });
    const { access_token } = (await loginRes.json()) as any;
    const res = await app.request('/admin/sync', {
      method: 'POST',
      headers: { Authorization: `Bearer ${access_token}` },
    });
    expect(res.status).toBe(403);
  });
});
