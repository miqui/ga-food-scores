import { createDb } from '../db/client.js';
import { LivePortalClient } from './live-portal-client.js';
import { defaultSyncCounties, resolveCounties } from './counties.js';
import { acquireSyncLock, orderCountiesForSync, runSync, SyncInProgressError, type SyncLock } from './run.js';

async function main() {
  const dbPath = process.env.DB_PATH ?? './data/app.db';
  const { db } = createDb(dbPath);
  // Each argv entry is one county; quote multi-word names: npm run sync -- "BEN HILL" LONG
  // Named counties run in the order given; the default set runs stalest first.
  const args = process.argv.slice(2);
  const requested = args.length > 0 ? resolveCounties(args) : orderCountiesForSync(db, defaultSyncCounties());

  let lock: SyncLock;
  try {
    lock = acquireSyncLock(db, requested);
  } catch (err) {
    if (err instanceof SyncInProgressError) {
      console.error(`[sync] ${err.message}; not starting`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  // First Ctrl-C / SIGTERM: finish the current facility, record the county as
  // interrupted (it resumes from its checkpoint next run) and exit. A second
  // one exits at once; that's still safe, since each facility is saved in a
  // single transaction.
  const stop = new AbortController();
  const onSignal = (sig: NodeJS.Signals) => {
    if (stop.signal.aborted) {
      console.error(`[sync] ${sig} again: exiting now`);
      lock.release();
      process.exit(130);
    }
    console.log(`[sync] ${sig}: stopping after the current facility (send again to exit now)`);
    stop.abort(new Error(`stopped by ${sig}`));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const summary = await runSync(db, new LivePortalClient(), lock, { signal: stop.signal });

  console.log(`[sync] finished: ${summary.ok.length}/${requested.length} counties ok`);
  if (summary.failed.length > 0) {
    console.error(`[sync] failed counties: ${summary.failed.join(', ')}`);
    process.exitCode = 1;
  }
  if (summary.interrupted) {
    console.log(`[sync] ${summary.interrupted} resumes from its checkpoint next run`);
    process.exitCode = 130;
  }
}

main().catch((err) => {
  console.error('[sync] fatal error:', err);
  process.exitCode = 1;
});
