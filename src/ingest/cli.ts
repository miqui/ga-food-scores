import { createDb } from '../db/client.js';
import { LivePortalClient } from './live-portal-client.js';
import { syncCounty } from './sync.js';
import { defaultSyncCounties, resolveCounties } from './counties.js';

async function main() {
  const dbPath = process.env.DB_PATH ?? './data/app.db';
  // Each argv entry is one county; quote multi-word names: npm run sync -- "BEN HILL" LONG
  const args = process.argv.slice(2);
  const requested = args.length > 0 ? resolveCounties(args) : defaultSyncCounties();

  const { db } = createDb(dbPath);
  const client = new LivePortalClient();

  // One failing county must not abort the rest of a long statewide run.
  const failed: string[] = [];
  for (const county of requested) {
    console.log(`[sync] starting county=${county}`);
    try {
      const result = await syncCounty(db, client, county);
      console.log(`[sync] done county=${county}`, JSON.stringify(result));
    } catch (err) {
      failed.push(county);
      console.error(`[sync] county=${county} failed:`, err);
    }
  }

  console.log(`[sync] finished: ${requested.length - failed.length}/${requested.length} counties ok`);
  if (failed.length > 0) {
    console.error(`[sync] failed counties: ${failed.join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[sync] fatal error:', err);
  process.exitCode = 1;
});
