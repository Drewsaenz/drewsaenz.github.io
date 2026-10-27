/**
 * Job: ratings (Tue 06:00 America/Chicago)
 * Pull SP+, Elo, FPI from CFBD, scrape FEI, validate everything, then upsert
 * `ratings` for (season, current week) in one transaction.
 */
import { loadAliases, loadCfbdConfig } from '../config';
import { openDb, upsertGames, upsertRatings, type RatingRow } from '../db';
import { requireEnv } from '../env';
import { log, runJob } from '../log';
import { FeiClient } from '../sources/fei';
import { mapTeams } from '../teams';
import { seasonContext } from './context';

runJob('ratings', async () => {
  const { cfbd, season, week, games } = await seasonContext();
  const cfbdCfg = loadCfbdConfig();
  const aliases = loadAliases();
  const fetched_at = new Date().toISOString();
  const fbsTeams = new Set<string>();
  for (const g of games) {
    fbsTeams.add(g.home_team);
    fbsTeams.add(g.away_team);
  }

  const rows: RatingRow[] = [];
  const add = (source: string, team: string, rating: number, extra: Record<string, unknown> | null = null) =>
    rows.push({ season, week, source, team, rating, extra: extra ? JSON.stringify(extra) : null, fetched_at });

  // --- CFBD ratings -------------------------------------------------------
  const sp = await cfbd.sp(season);
  for (const [team, r] of sp) add('sp', team, r);

  // Elo "as of" the end of the previous week is what is known on Tuesday.
  // Week 1 has no prior week; omit the week param to get the latest (preseason) Elo.
  const elo = await cfbd.elo(season, week > 1 ? week - 1 : undefined);
  for (const [team, r] of elo) add('elo', team, r);

  if (cfbdCfg.use_fpi) {
    const fpi = await cfbd.fpi(season);
    for (const [team, r] of fpi) add('fpi', team, r);
  }

  // --- FEI (scraped, cached once per day) ---------------------------------
  const fei = new FeiClient(requireEnv('FEI_USER_AGENT'));
  const feiMapping = mapTeams(await fei.ratings(season), (r) => r.team, aliases.fei, fbsTeams, `FEI ${season}`);
  if (feiMapping.problems.length > 0) throw new Error(feiMapping.problems.join('\n  '));
  for (const { row, team } of feiMapping.mapped) add('fei', team, row.fei, { ofei: row.ofei, dfei: row.dfei });

  // --- validate counts before touching the DB -----------------------------
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.source, (counts.get(r.source) ?? 0) + 1);
  for (const [source, n] of counts) {
    if (n < 100) throw new Error(`${source}: only ${n} teams rated; expected ~130 FBS teams`);
    log.info(`${source}: ${n} teams`);
  }
  if (!counts.has('sp') || !counts.has('elo') || !counts.has('fei')) {
    throw new Error(`missing a required source: have ${[...counts.keys()].join(', ')}`);
  }

  const db = openDb();
  db.transaction(() => {
    upsertGames(db, games);
    upsertRatings(db, rows);
  })();
  log.info(`ratings upserted: ${rows.length} rows for season ${season} week ${week}; CFBD calls this run: ${cfbd.callCount}`);
});
