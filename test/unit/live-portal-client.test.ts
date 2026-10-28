import { describe, it, expect, vi, afterEach } from 'vitest';
import { LivePortalClient } from '../../src/ingest/live-portal-client.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

// No rate-limit gap and near-zero backoff so retry tests run fast.
const fastClient = (maxAttempts = 3) =>
  new LivePortalClient({ minIntervalMs: 0, retry: { maxAttempts, baseDelayMs: 1, maxDelayMs: 1, timeoutMs: 50 } });

/** A fetch mock that answers each call with the next response in the list. */
function respondWith(...responses: Array<() => Response>) {
  const fetchMock = vi.fn(async () => (responses.shift() ?? responses.at(-1)!)());
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers });
const html = (status: number) => () => new Response('<html>error</html>', { status });

describe('LivePortalClient requests', () => {
  it('fails instead of returning [] when the portal sends non-array JSON', async () => {
    const fetchMock = respondWith(json({ error: 'maintenance' }), json({ error: 'maintenance' }), json({ error: 'maintenance' }));
    await expect(fastClient().searchCounty('LONG', 1)).rejects.toThrow(/non-array JSON/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries non-array JSON and returns the array once the portal recovers', async () => {
    respondWith(json({ error: 'maintenance' }), json([]));
    await expect(fastClient().searchCounty('LONG', 1)).resolves.toEqual([]);
  });

  it('retries 5xx and 429', async () => {
    const fetchMock = respondWith(html(503), json([], 429, { 'Retry-After': '0' }), json([]));
    await expect(fastClient().searchCounty('LONG', 1)).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry other 4xx errors', async () => {
    const fetchMock = respondWith(html(404), json([]));
    await expect(fastClient().searchCounty('LONG', 1)).rejects.toThrow(/portal error 404/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('times out a request that never answers, then retries it', async () => {
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(fastClient(2).searchCounty('LONG', 1)).rejects.toThrow(/timeout|aborted/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('LivePortalClient.getInspections', () => {
  it('drops the "No Inspections To Display" placeholder row', async () => {
    // Shape returned by the live portal for a facility with nothing posted yet.
    const placeholder = [
      {
        printablePath: '',
        inspectionId: 0,
        facilityId: 'MTI5OTM4ODA=',
        columns: { '0': 'No Inspections To Display' },
        violations: {},
      },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(placeholder))));

    expect(await new LivePortalClient().getInspections('MTI5OTM4ODA=')).toEqual([]);
  });

  it('keeps real inspections', async () => {
    const real = [
      {
        printablePath: 'report.cfm',
        inspectionId: 99522961,
        facilityId: 'MzE2NzQ3MQ==',
        columns: { '0': 'Date: 08-25-2026', '1': 'Inspection Purpose: Routine', '2': 'Score: 80', '3': 'Inspector: A' },
        violations: {},
      },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(real))));

    const history = await new LivePortalClient().getInspections('MzE2NzQ3MQ==');
    expect(history.map((h) => [h.inspectionId, h.date])).toEqual([[99522961, '2026-08-25']]);
  });
});

describe('LivePortalClient record validation', () => {
  const facility = (id: string, date = '10-01-2026') => ({
    id,
    name: `Facility ${id}`,
    mapAddress: '1 MAIN ST \r\nLUDOWICI, GA 31316',
    columns: { '4': 'Last Inspection Score: 95', '5': `Last Inspection Date: ${date}` },
  });

  it('skips a stray malformed facility record and keeps the rest', async () => {
    respondWith(json([facility('QQ=='), { name: 'no id' }, facility('Qg=='), facility('Qw=='), facility('RA==')]));
    const records = await fastClient().searchCounty('LONG', 1);
    expect(records.map((r) => r.id)).toEqual(['QQ==', 'Qg==', 'Qw==', 'RA==']);
  });

  it('fails the page, without retrying, when most records are malformed', async () => {
    const fetchMock = respondWith(json([{ name: 'no id' }, { id: 5 }, facility('QQ==')]));
    await expect(fastClient().searchCounty('LONG', 1)).rejects.toThrow(/2\/3 malformed records/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a changed date format as malformed instead of storing empty dates', async () => {
    respondWith(json([facility('QQ==', '2026-10-01'), facility('Qg==', '2026-10-02')]));
    await expect(fastClient().searchCounty('LONG', 1)).rejects.toThrow(/Last Inspection Date format/);
  });

  it('accepts never-inspected facilities whose date has no digits', async () => {
    respondWith(json([facility('QQ==', 'NA')]));
    expect(await fastClient().searchCounty('LONG', 1)).toHaveLength(1);
  });

  it('skips malformed inspections but keeps the valid ones', async () => {
    const inspection = (inspectionId: unknown, date: string) => ({
      printablePath: '',
      inspectionId,
      facilityId: 'QQ==',
      columns: { '0': `Date: ${date}`, '2': 'Score: 90' },
      violations: {},
    });
    respondWith(json([inspection(2, '10-01-2026'), inspection('x', '09-01-2026'), inspection(1, '2026/08/01')]));
    const history = await fastClient().getInspections('QQ==');
    expect(history.map((h) => h.inspectionId)).toEqual([2]);
  });
});
