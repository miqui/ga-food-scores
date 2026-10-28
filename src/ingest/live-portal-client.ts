import { z } from 'zod';
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

export interface RetryOptions {
  /** Total tries per request, including the first. */
  maxAttempts: number;
  /** First backoff delay; doubles per retry, with jitter, up to maxDelayMs. */
  baseDelayMs: number;
  maxDelayMs: number;
  /** Abort a request that hasn't produced a response body by then. */
  timeoutMs: number;
}

// About 2 minutes of backoff in total, so a short portal outage doesn't fail a
// county walk that may be hundreds of pages in.
const DEFAULT_RETRY: RetryOptions = { maxAttempts: 6, baseDelayMs: 2000, maxDelayMs: 60_000, timeoutMs: 30_000 };

/** Longest Retry-After we'll honor; anything longer is capped. */
const MAX_RETRY_AFTER_MS = 5 * 60_000;

/** An error that retrying won't fix (a 4xx other than 429). */
class PermanentPortalError extends Error {}

function retryAfterMs(res: Response): number | null {
  const header = res.headers.get('Retry-After');
  if (!header) return null;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : null;
}

/**
 * GET a portal URL that must return a JSON array. 5xx, 429, timeouts, network
 * errors and bodies that aren't a JSON array are retried with exponential
 * backoff; other 4xx fail at once. The portal answers an empty page or list
 * with `[]`, never with another JSON shape, so anything else is an error and
 * must not be read as "no results" (that would end a county walk early).
 */
async function fetchJsonArrayWithRetry(url: string, limiter: RateLimiter, retry: RetryOptions): Promise<unknown[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
    await limiter.wait();
    let delayMs: number | null = null;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(retry.timeoutMs),
      });
      if (res.status === 429 || res.status >= 500) {
        delayMs = retryAfterMs(res);
        lastError = new Error(`portal ${res.status} for ${url}`);
      } else if (!res.ok) {
        throw new PermanentPortalError(`portal error ${res.status} for ${url}`);
      } else {
        const data: unknown = await res.json();
        if (Array.isArray(data)) return data;
        lastError = new Error(`portal returned non-array JSON for ${url}: ${JSON.stringify(data).slice(0, 200)}`);
      }
    } catch (err) {
      if (err instanceof PermanentPortalError) throw err;
      lastError = err;
    }
    if (attempt < retry.maxAttempts) {
      const backoff = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1));
      await sleep(delayMs ?? backoff * (0.5 + Math.random() / 2));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`portal request failed for ${url}`);
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

/**
 * A date column must hold MM-DD-YYYY, or no digits at all (never-inspected
 * facilities show "NA"). Digits in any other shape mean the portal changed its
 * date format, which would otherwise turn every date into '' without a sound.
 */
function isKnownDateFormat(value: string | undefined): boolean {
  const v = stripLabel(value);
  return !/\d/.test(v) || /\d{2}-\d{2}-\d{4}/.test(v);
}

const facilityRecordSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    mapAddress: z.string().default(''),
    columns: z.record(z.string(), z.string()),
  })
  .refine((r) => isKnownDateFormat(r.columns['5']), {
    message: 'unrecognized Last Inspection Date format',
    path: ['columns', '5'],
  });

const inspectionRecordSchema = z
  .object({
    inspectionId: z.number().int(),
    facilityId: z.string(),
    printablePath: z.string().optional(),
    columns: z.record(z.string(), z.string()),
    violations: z
      .union([z.record(z.string(), z.array(z.string().nullable())), z.array(z.array(z.string().nullable()))])
      .optional(),
  })
  // inspectionId 0 is the "No Inspections To Display" placeholder, which has no date.
  .refine((r) => r.inspectionId === 0 || /\d{2}-\d{2}-\d{4}/.test(r.columns['0'] ?? ''), {
    message: 'missing or unrecognized inspection Date',
    path: ['columns', '0'],
  });

/** Records whose shape doesn't match what the parsers expect. Not retried. */
export class PortalSchemaError extends Error {}

/**
 * Keep the records that match `schema`, logging the ones that don't. When
 * `failIfMostInvalid` is set and over half the records are bad, throw instead:
 * that's a format change, not a stray record, and it should fail the county
 * loudly rather than skip everything.
 */
function validRecords<T>(data: unknown[], schema: z.ZodType<T>, url: string, failIfMostInvalid: boolean): T[] {
  const valid: T[] = [];
  const problems: string[] = [];
  for (const item of data) {
    const result = schema.safeParse(item);
    if (result.success) valid.push(result.data);
    else problems.push(z.prettifyError(result.error));
  }
  if (problems.length > 0) {
    const detail = `${problems.length}/${data.length} malformed records from ${url}: ${problems[0]}`;
    if (failIfMostInvalid && problems.length * 2 > data.length) throw new PortalSchemaError(detail);
    console.warn(`[portal] skipped ${detail}`);
  }
  return valid;
}

export interface LivePortalClientOptions {
  /** Minimum gap between requests; the portal is shared, so keep this at 1s in production. */
  minIntervalMs?: number;
  retry?: Partial<RetryOptions>;
}

export class LivePortalClient implements PortalClient {
  private readonly limiter: RateLimiter;
  private readonly retry: RetryOptions;

  constructor(options: LivePortalClientOptions = {}) {
    this.limiter = new RateLimiter(options.minIntervalMs ?? 1000); // 1 request / second
    this.retry = { ...DEFAULT_RETRY, ...options.retry };
  }

  async searchCounty(county: string, page: number): Promise<PortalFacilityRecord[]> {
    const query = JSON.stringify({
      county: base64Encode(county),
      keyword: '',
      city: '',
    });
    const url = `${BASE}/search/${encodeURIComponent(query)}/${page}`;
    const data = await fetchJsonArrayWithRetry(url, this.limiter, this.retry);
    return validRecords<PortalFacilityRecord>(data, facilityRecordSchema, url, true);
  }

  async getInspections(facilityId: string): Promise<PortalInspectionRecord[]> {
    const url = `${BASE}/inspectionsData/${encodeURIComponent(facilityId)}`;
    const data = await fetchJsonArrayWithRetry(url, this.limiter, this.retry);
    // A facility with nothing posted yet comes back as one placeholder row
    // ("No Inspections To Display", inspectionId 0, no date); it's not an inspection.
    // A bad record here is skipped, never fatal: the history then lacks that
    // inspection, so the facility stays history_pending and is retried.
    return validRecords(data, inspectionRecordSchema, url, false)
      .map(parseInspectionRecord)
      .filter((r) => r.inspectionId > 0 && r.date !== '');
  }
}
