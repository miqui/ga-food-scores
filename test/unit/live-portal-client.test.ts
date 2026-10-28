import { describe, it, expect, vi, afterEach } from 'vitest';
import { LivePortalClient } from '../../src/ingest/live-portal-client.js';

afterEach(() => {
  vi.unstubAllGlobals();
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
