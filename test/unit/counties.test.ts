import { describe, it, expect } from 'vitest';
import {
  GA_COUNTIES,
  normalizeCounty,
  resolveCounties,
  defaultSyncCounties,
  UnknownCountyError,
} from '../../src/ingest/counties.js';

describe('Georgia county list', () => {
  it('has all 159 counties, unique, ordered by permit-number county code', () => {
    expect(GA_COUNTIES.length).toBe(159);
    expect(new Set(GA_COUNTIES).size).toBe(159);
    // Codes seen in live permit numbers (FSP-<code>-...).
    expect(GA_COUNTIES.indexOf('BEN HILL') + 1).toBe(9);
    expect(GA_COUNTIES.indexOf('DEKALB') + 1).toBe(44);
    expect(GA_COUNTIES.indexOf('FULTON') + 1).toBe(60);
    expect(GA_COUNTIES.indexOf('JEFF DAVIS') + 1).toBe(80);
    expect(GA_COUNTIES.indexOf('MCDUFFIE') + 1).toBe(97);
  });

  it('normalizes case and whitespace and rejects unknown or non-string input', () => {
    expect(normalizeCounty(' ben   hill ')).toBe('BEN HILL');
    expect(normalizeCounty('chatham')).toBe('CHATHAM');
    expect(normalizeCounty('CHATAM')).toBeNull();
    expect(normalizeCounty('BENHILL')).toBeNull();
    expect(normalizeCounty(5)).toBeNull();
  });

  it('resolveCounties reports every invalid name', () => {
    expect(() => resolveCounties(['LONG', 'CHATAM', 'FOO'])).toThrow(UnknownCountyError);
    expect(() => resolveCounties(['LONG', 'CHATAM', 'FOO'])).toThrow(/CHATAM, FOO/);
  });

  it('defaults to all counties, honoring SYNC_COUNTIES then legacy COASTAL_COUNTIES', () => {
    expect(defaultSyncCounties({})).toEqual(GA_COUNTIES);
    expect(defaultSyncCounties({ SYNC_COUNTIES: 'long, ben hill' })).toEqual(['LONG', 'BEN HILL']);
    expect(defaultSyncCounties({ COASTAL_COUNTIES: 'BRYAN,LONG' })).toEqual(['BRYAN', 'LONG']);
    expect(() => defaultSyncCounties({ SYNC_COUNTIES: 'CHATAM' })).toThrow(UnknownCountyError);
  });
});
