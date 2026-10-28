import { and, eq } from 'drizzle-orm';
import { facilities, inspections, violations, syncState } from '../db/schema.js';
import type { AppDb } from '../db/client.js';
import type { PortalClient, PortalFacilityRecord, PortalInspectionRecord } from './portal-client.js';

function stripLabel(value: string | undefined): string {
  if (!value) return '';
  const idx = value.indexOf(':');
  return idx === -1 ? value.trim() : value.slice(idx + 1).trim();
}

function parsePortalDate(value: string): string {
  const m = value.match(/(\d{2})-(\d{2})-(\d{4})/);
  if (!m) return '';
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

function parseFacilityRecord(county: string, raw: PortalFacilityRecord) {
  const columns = raw.columns ?? {};
  const addressLines = (raw.mapAddress ?? '').split('\n').map((l) => l.trim());
  const city = (() => {
    const last = addressLines[addressLines.length - 1] ?? '';
    const m = last.match(/^([A-Za-z .'-]+),?\s*GA/i);
    return m ? m[1].trim() : '';
  })();
  const lastScoreStr = stripLabel(columns['4']);
  const lastScore = Number.parseInt(lastScoreStr, 10);
  const lastDateRaw = stripLabel(columns['5']);
  return {
    id: raw.id,
    name: raw.name,
    address: raw.mapAddress ?? '',
    city,
    county,
    permitType: stripLabel(columns['2']),
    permitNumber: stripLabel(columns['3']),
    phone: stripLabel(columns['1']),
    lastInspectionScore: Number.isFinite(lastScore) ? lastScore : null,
    lastInspectionDate: parsePortalDate(lastDateRaw),
  };
}

/**
 * The portal's county search is a substring match and its records carry no
 * county field, so searching CLAY also returns every CLAYTON facility (the
 * only such overlap among GA county names). Clay County ZIPs all start with
 * 398 and Clayton's with 30, so drop CLAY results with a non-398 ZIP. Records
 * without a parseable ZIP are kept.
 */
function belongsToSearchedCounty(county: string, address: string): boolean {
  if (county !== 'CLAY') return true;
  const zip = address.match(/\bGA\s+(\d{5})/i)?.[1];
  return !zip || zip.startsWith('398');
}

export interface SyncResult {
  county: string;
  pagesWalked: number;
  facilitiesSeen: number;
  facilitiesSkipped: number;
  facilitiesUpserted: number;
  facilitiesWithNewInspections: number;
  inspectionsUpserted: number;
  violationsUpserted: number;
  /** Pending facilities from earlier runs that this run re-fetched outside the walk. */
  historiesRetried: number;
  /** Facilities in this county whose history still lacks their latest inspection. */
  historiesPending: number;
  newWatermark: string | null;
}

type Tx = Parameters<Parameters<AppDb['transaction']>[0]>[0];

/**
 * The portal can list a facility's new inspection before the inspection itself
 * is posted, so a history only counts as complete once it has an inspection on
 * or after the listed date. (The listing can also lag behind the history, so
 * this is not an exact-date match.)
 */
function historyIsComplete(lastInspectionDate: string | null, history: PortalInspectionRecord[]): boolean {
  return !lastInspectionDate || history.some((i) => i.date >= lastInspectionDate);
}

/** Upsert a facility's inspections and replace their violations. Returns row counts. */
function saveHistory(tx: Tx, facilityId: string, history: PortalInspectionRecord[]) {
  let inspectionsUpserted = 0;
  let violationsUpserted = 0;
  for (const insp of history) {
    const fields = {
      inspectionDate: insp.date,
      purpose: insp.purpose,
      score: insp.score,
      inspector: insp.inspector,
      reportUrl: insp.printablePath,
    };
    const row = tx
      .insert(inspections)
      .values({ inspectionId: insp.inspectionId, facilityId, ...fields })
      .onConflictDoUpdate({ target: inspections.inspectionId, set: fields })
      .returning({ id: inspections.id })
      .get();
    inspectionsUpserted += 1;

    // Replace violations for this inspection to avoid duplicate accumulation on re-sync.
    tx.delete(violations).where(eq(violations.inspectionId, row.id)).run();
    for (const v of insp.violations) {
      tx.insert(violations)
        .values({
          inspectionId: row.id,
          code: v.code,
          ruleCitation: v.ruleCitation,
          points: v.points,
          correctedOnSite: v.correctedOnSite,
          repeat: v.repeat,
          notes: v.notes,
        })
        .run();
      violationsUpserted += 1;
    }
  }
  return { inspectionsUpserted, violationsUpserted };
}

/** Hard safety stop for a runaway walk; FULTON is ~1700 pages, so this leaves lots of headroom. */
export const DEFAULT_MAX_PAGES = 10_000;

/**
 * How far behind the watermark an incremental walk keeps going. Inspections are
 * often posted days after their inspection date, which sorts them below the
 * watermark of a run that happened in between; walking this far back picks
 * them up. Facilities whose listing is unchanged cost only the search page.
 */
export const DEFAULT_LOOKBACK_DAYS = 30;

/**
 * A resumed walk restarts this many pages before its checkpoint: facilities
 * that got a new inspection meanwhile move to page 1 and push the rest down,
 * so the pages just before the checkpoint now hold records not yet walked.
 */
const RESUME_OVERLAP_PAGES = 2;

function daysBefore(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Walk a single county's paginated search results newest-inspection-first,
 * upsert facility rows, and stop as soon as we see a page whose records are
 * all strictly older than the stored watermark minus lookbackDays (nothing
 * new left to find). The lookback catches inspections posted late; with a
 * lookback of 0, records dated on the watermark day itself still don't stop
 * the walk, since more inspections for that day may have been posted after
 * the last sync.
 * After each page, the walk saves a checkpoint (next page, newest date so far)
 * in sync_state. A walk that fails, is aborted, or hits maxPages leaves the
 * watermark alone, and the next run resumes from the checkpoint (less
 * RESUME_OVERLAP_PAGES) instead of starting a large county over. Records that
 * changed on the pages skipped by a resume are newer than the checkpoint's
 * newest date, so the next incremental walk picks them up.
 * `signal` is checked between facilities, never inside one, so an abort
 * leaves every facility either fully saved or untouched.
 * Facilities whose last-inspection score/date changed (or are new, or still
 * pending) get their full inspection + violation history re-fetched. The fetch
 * happens before any write, and the facility row and its history are saved in
 * one transaction, so a failed fetch or a killed run never leaves a facility
 * marked current without its inspections.
 * After the walk, facilities still flagged history_pending that the walk didn't
 * reach (an incremental walk stops at the watermark) are re-fetched directly.
 */
export async function syncCounty(
  db: AppDb,
  client: PortalClient,
  county: string,
  options: { maxPages?: number; lookbackDays?: number; signal?: AbortSignal } = {},
): Promise<SyncResult> {
  const stateRow = db.select().from(syncState).where(eq(syncState.county, county)).get();
  const watermark = stateRow?.watermark ?? null;
  const stopBefore = watermark ? daysBefore(watermark, options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS) : null;

  const resumeFrom = stateRow?.resumePage ?? null;
  let page = resumeFrom ? Math.max(1, resumeFrom - RESUME_OVERLAP_PAGES) : 1;
  let pagesWalked = 0;
  let facilitiesSeen = 0;
  let facilitiesSkipped = 0;
  let facilitiesUpserted = 0;
  let facilitiesWithNewInspections = 0;
  let inspectionsUpserted = 0;
  let violationsUpserted = 0;
  let historiesRetried = 0;
  const fetchedThisRun = new Set<string>();
  let newestDateSeen: string | null = resumeFrom ? (stateRow?.resumeNewest ?? null) : null;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  let reachedEnd = false;

  while (page <= maxPages) {
    options.signal?.throwIfAborted();
    const records = await client.searchCounty(county, page);
    if (records.length === 0) {
      reachedEnd = true;
      break;
    }
    pagesWalked += 1;

    let allBelowWatermark = true;

    for (const raw of records) {
      options.signal?.throwIfAborted();
      facilitiesSeen += 1;
      const parsed = parseFacilityRecord(county, raw);

      // Skipped records still count toward the stop check: results are sorted by
      // date across both counties, so a page of new foreign records can sit in
      // front of new records that do belong to this county.
      const belowWatermark =
        !!stopBefore && !!parsed.lastInspectionDate && parsed.lastInspectionDate < stopBefore;
      if (!belowWatermark) {
        allBelowWatermark = false;
      }

      if (!belongsToSearchedCounty(county, parsed.address)) {
        facilitiesSkipped += 1;
        continue;
      }

      if (!newestDateSeen || (parsed.lastInspectionDate && parsed.lastInspectionDate > newestDateSeen)) {
        newestDateSeen = parsed.lastInspectionDate || newestDateSeen;
      }

      const existing = db.select().from(facilities).where(eq(facilities.id, parsed.id)).get();
      const needsHistory =
        !existing ||
        existing.historyPending ||
        existing.lastInspectionScore !== parsed.lastInspectionScore ||
        existing.lastInspectionDate !== parsed.lastInspectionDate;

      // Fetch before writing anything: if this throws, the facility row is left as
      // it was, so the next run still sees the change and fetches again.
      const history = needsHistory ? await client.getInspections(parsed.id) : [];
      if (needsHistory) fetchedThisRun.add(parsed.id);
      const row = {
        ...parsed,
        historyPending: needsHistory && !historyIsComplete(parsed.lastInspectionDate, history),
        updatedAt: new Date().toISOString(),
      };

      const saved = db.transaction((tx) => {
        tx.insert(facilities)
          .values(row)
          .onConflictDoUpdate({ target: facilities.id, set: row })
          .run();
        return saveHistory(tx, parsed.id, history);
      });
      facilitiesUpserted += 1;
      if (needsHistory) facilitiesWithNewInspections += 1;
      inspectionsUpserted += saved.inspectionsUpserted;
      violationsUpserted += saved.violationsUpserted;
    }

    if (stopBefore && allBelowWatermark) {
      reachedEnd = true;
      break;
    }
    page += 1;
    db.insert(syncState)
      .values({ county, resumePage: page, resumeNewest: newestDateSeen })
      .onConflictDoUpdate({ target: syncState.county, set: { resumePage: page, resumeNewest: newestDateSeen } })
      .run();
  }

  if (!reachedEnd) {
    throw new Error(
      `sync county=${county} hit maxPages=${maxPages} before the end of results; watermark not advanced, next run resumes at page ${page}`,
    );
  }

  const newWatermark = newestDateSeen ?? watermark;
  const finished = {
    watermark: newWatermark,
    lastSyncedAt: new Date().toISOString(),
    resumePage: null,
    resumeNewest: null,
  };
  db.insert(syncState)
    .values({ county, ...finished })
    .onConflictDoUpdate({ target: syncState.county, set: finished })
    .run();

  // Runs after the watermark is saved, so a failed retry doesn't undo the walk.
  const pending = db
    .select({ id: facilities.id, lastInspectionDate: facilities.lastInspectionDate })
    .from(facilities)
    .where(and(eq(facilities.county, county), eq(facilities.historyPending, true)))
    .all()
    .filter((f) => !fetchedThisRun.has(f.id));
  for (const f of pending) {
    options.signal?.throwIfAborted();
    let history: PortalInspectionRecord[];
    try {
      history = await client.getInspections(f.id);
    } catch (err) {
      console.error(`[sync] county=${county} facility=${f.id} history retry failed:`, err);
      continue;
    }
    const saved = db.transaction((tx) => {
      tx.update(facilities)
        .set({ historyPending: !historyIsComplete(f.lastInspectionDate, history) })
        .where(eq(facilities.id, f.id))
        .run();
      return saveHistory(tx, f.id, history);
    });
    historiesRetried += 1;
    inspectionsUpserted += saved.inspectionsUpserted;
    violationsUpserted += saved.violationsUpserted;
  }

  const historiesPending = db
    .select({ id: facilities.id })
    .from(facilities)
    .where(and(eq(facilities.county, county), eq(facilities.historyPending, true)))
    .all().length;

  return {
    county,
    pagesWalked,
    facilitiesSeen,
    facilitiesSkipped,
    facilitiesUpserted,
    facilitiesWithNewInspections,
    inspectionsUpserted,
    violationsUpserted,
    historiesRetried,
    historiesPending,
    newWatermark,
  };
}
