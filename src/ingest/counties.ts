/**
 * All 159 Georgia counties, spelled the way the portal's county search expects
 * (uppercase, multi-word names keep their space: "BEN HILL", "JEFF DAVIS").
 * Order matches the county code embedded in most permit numbers (FSP-060-... = FULTON).
 * A misspelled county silently returns zero results from the portal, so every
 * county name is validated against this list before syncing.
 */
export const GA_COUNTIES = [
  'APPLING', 'ATKINSON', 'BACON', 'BAKER', 'BALDWIN', 'BANKS', 'BARROW', 'BARTOW',
  'BEN HILL', 'BERRIEN', 'BIBB', 'BLECKLEY', 'BRANTLEY', 'BROOKS', 'BRYAN', 'BULLOCH',
  'BURKE', 'BUTTS', 'CALHOUN', 'CAMDEN', 'CANDLER', 'CARROLL', 'CATOOSA', 'CHARLTON',
  'CHATHAM', 'CHATTAHOOCHEE', 'CHATTOOGA', 'CHEROKEE', 'CLARKE', 'CLAY', 'CLAYTON', 'CLINCH',
  'COBB', 'COFFEE', 'COLQUITT', 'COLUMBIA', 'COOK', 'COWETA', 'CRAWFORD', 'CRISP',
  'DADE', 'DAWSON', 'DECATUR', 'DEKALB', 'DODGE', 'DOOLY', 'DOUGHERTY', 'DOUGLAS',
  'EARLY', 'ECHOLS', 'EFFINGHAM', 'ELBERT', 'EMANUEL', 'EVANS', 'FANNIN', 'FAYETTE',
  'FLOYD', 'FORSYTH', 'FRANKLIN', 'FULTON', 'GILMER', 'GLASCOCK', 'GLYNN', 'GORDON',
  'GRADY', 'GREENE', 'GWINNETT', 'HABERSHAM', 'HALL', 'HANCOCK', 'HARALSON', 'HARRIS',
  'HART', 'HEARD', 'HENRY', 'HOUSTON', 'IRWIN', 'JACKSON', 'JASPER', 'JEFF DAVIS',
  'JEFFERSON', 'JENKINS', 'JOHNSON', 'JONES', 'LAMAR', 'LANIER', 'LAURENS', 'LEE',
  'LIBERTY', 'LINCOLN', 'LONG', 'LOWNDES', 'LUMPKIN', 'MACON', 'MADISON', 'MARION',
  'MCDUFFIE', 'MCINTOSH', 'MERIWETHER', 'MILLER', 'MITCHELL', 'MONROE', 'MONTGOMERY', 'MORGAN',
  'MURRAY', 'MUSCOGEE', 'NEWTON', 'OCONEE', 'OGLETHORPE', 'PAULDING', 'PEACH', 'PICKENS',
  'PIERCE', 'PIKE', 'POLK', 'PULASKI', 'PUTNAM', 'QUITMAN', 'RABUN', 'RANDOLPH',
  'RICHMOND', 'ROCKDALE', 'SCHLEY', 'SCREVEN', 'SEMINOLE', 'SPALDING', 'STEPHENS', 'STEWART',
  'SUMTER', 'TALBOT', 'TALIAFERRO', 'TATTNALL', 'TAYLOR', 'TELFAIR', 'TERRELL', 'THOMAS',
  'TIFT', 'TOOMBS', 'TOWNS', 'TREUTLEN', 'TROUP', 'TURNER', 'TWIGGS', 'UNION',
  'UPSON', 'WALKER', 'WALTON', 'WARE', 'WARREN', 'WASHINGTON', 'WAYNE', 'WEBSTER',
  'WHEELER', 'WHITE', 'WHITFIELD', 'WILCOX', 'WILKES', 'WILKINSON', 'WORTH',
];

const KNOWN = new Set(GA_COUNTIES);

/** Uppercase and collapse whitespace; returns null if not a known GA county. */
export function normalizeCounty(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const name = input.trim().replace(/\s+/g, ' ').toUpperCase();
  return KNOWN.has(name) ? name : null;
}

export class UnknownCountyError extends Error {
  constructor(public readonly invalid: string[]) {
    super(`unknown Georgia county: ${invalid.join(', ')}`);
  }
}

/** Validate a list of county names; throws UnknownCountyError listing every bad one. */
export function resolveCounties(names: unknown[]): string[] {
  const resolved: string[] = [];
  const invalid: string[] = [];
  for (const n of names) {
    const county = normalizeCounty(n);
    if (county) resolved.push(county);
    else invalid.push(String(n));
  }
  if (invalid.length > 0) throw new UnknownCountyError(invalid);
  return resolved;
}

/**
 * Default county set for a sync run: SYNC_COUNTIES (comma-separated), falling back to
 * the legacy COASTAL_COUNTIES env var, then to all of Georgia.
 */
export function defaultSyncCounties(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.SYNC_COUNTIES ?? env.COASTAL_COUNTIES;
  if (!raw) return GA_COUNTIES;
  return resolveCounties(raw.split(',').filter((c) => c.trim() !== ''));
}
