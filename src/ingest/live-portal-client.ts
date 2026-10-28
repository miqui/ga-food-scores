import type { PortalClient, PortalFacilityRecord, PortalInspectionRecord, PortalViolation } from './portal-client.js';

const BASE = 'https://ga.healthinspections.us/stateofgeorgia/API/index.cfm';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Simple global 1 req/s token bucket shared across all calls from this client. */
class RateLimiter {
  private nextAvailableAt = 0;
  constructor(private readonly minIntervalMs: number) {}

  async wait(): Promise<void> {
    const now = Date.now();
    const waitMs = Math.max(0, this.nextAvailableAt - now);
    this.nextAvailableAt = Math.max(now, this.nextAvailableAt) + this.minIntervalMs;
    if (waitMs > 0) {
      await sleep(waitMs);
    }
  }
}

async function fetchJsonWithRetry(
  url: string,
  limiter: RateLimiter,
  maxAttempts = 4,
): Promise<unknown> {
  let attempt = 0;
  let lastError: unknown;
  while (attempt < maxAttempts) {
    await limiter.wait();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (res.status >= 500) {
        lastError = new Error(`portal 5xx: ${res.status} for ${url}`);
      } else if (!res.ok) {
        throw new Error(`portal error ${res.status} for ${url}`);
      } else {
        return await res.json();
      }
    } catch (err) {
      lastError = err;
    }
    attempt += 1;
    if (attempt < maxAttempts) {
      await sleep(2 ** attempt * 250);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('portal request failed');
}

function parsePortalDate(value: string | undefined): string {
  // "MM-DD-YYYY" -> "YYYY-MM-DD"
  if (!value) return '';
  const m = value.match(/(\d{2})-(\d{2})-(\d{4})/);
  if (!m) return '';
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

function stripLabel(value: string | undefined): string {
  if (!value) return '';
  const idx = value.indexOf(':');
  return idx === -1 ? value.trim() : value.slice(idx + 1).trim();
}

function parseViolation(entry: string[]): PortalViolation {
  const [code, ruleCitation, pointsStr, correctedStr, repeatStr, notesStr] = entry;
  const points = Number.parseInt(stripLabel(pointsStr), 10);
  return {
    code: code ?? '',
    ruleCitation: ruleCitation ?? '',
    points: Number.isFinite(points) ? points : 0,
    correctedOnSite: stripLabel(correctedStr).toLowerCase() === 'yes',
    repeat: stripLabel(repeatStr).toLowerCase() === 'yes',
    notes: stripLabel(notesStr),
  };
}

function parseInspectionRecord(raw: any): PortalInspectionRecord {
  const columns = raw.columns ?? {};
  const score = Number.parseInt(stripLabel(columns['2']), 10);
  const violationsRaw = raw.violations ?? {};
  const violations: PortalViolation[] = Object.values(violationsRaw).map((v) =>
    parseViolation(v as string[]),
  );
  return {
    inspectionId: raw.inspectionId,
    facilityId: raw.facilityId,
    printablePath: raw.printablePath ?? '',
    date: parsePortalDate(stripLabel(columns['0'])),
    purpose: stripLabel(columns['1']),
    score: Number.isFinite(score) ? score : null,
    inspector: stripLabel(columns['3']),
    violations,
  };
}

export function base64Encode(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64');
}

export class LivePortalClient implements PortalClient {
  private readonly limiter = new RateLimiter(1000); // 1 request / second

  async searchCounty(county: string, page: number): Promise<PortalFacilityRecord[]> {
    const query = JSON.stringify({
      county: base64Encode(county),
      keyword: '',
      city: '',
    });
    const url = `${BASE}/search/${encodeURIComponent(query)}/${page}`;
    const data = (await fetchJsonWithRetry(url, this.limiter)) as PortalFacilityRecord[];
    return Array.isArray(data) ? data : [];
  }

  async getInspections(facilityId: string): Promise<PortalInspectionRecord[]> {
    const url = `${BASE}/inspectionsData/${encodeURIComponent(facilityId)}`;
    const data = (await fetchJsonWithRetry(url, this.limiter)) as any[];
    // A facility with nothing posted yet comes back as one placeholder row
    // ("No Inspections To Display", inspectionId 0, no date); it's not an inspection.
    return Array.isArray(data)
      ? data.map(parseInspectionRecord).filter((r) => r.inspectionId > 0 && r.date !== '')
      : [];
  }
}
