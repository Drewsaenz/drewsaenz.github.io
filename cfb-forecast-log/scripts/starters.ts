/**
 * npm run starters: refresh qb_starters (each team's season pass-attempt leader
 * with >= the v2 starter share) from CFBD. The snapshot jobs do this on every
 * run; this is for filling it in between snapshots. Writes no forecasts.
 */
import { openDb } from '../src/db';
import { seasonContext } from '../src/jobs/context';
import { log, runJob } from '../src/log';
import { loadModelV2Config, startersFromAttempts } from '../src/model/v2';
import { saveStarters } from '../src/news';

runJob('starters', async () => {
  const cfg = loadModelV2Config();
  const { cfbd, season } = await seasonContext();
  const starters = startersFromAttempts(await cfbd.passAttempts(season), cfg.qb.min_starter_share);
  const db = openDb();
  const n = db.transaction(() => saveStarters(db, season, starters.values()))();
  log.info(`qb_starters: ${n} team(s) updated for ${season}`);
});
