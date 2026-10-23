/**
 * One-time fit for model v1: one logistic regression per rating source on
 * CFBD historical games (config fit_seasons). Writes config/model-v1.json.
 *
 * Caveats recorded in the config's fit_summary:
 *  - SP+, FPI and FEI are season-final ratings (CFBD/bcftoys do not serve
 *    week-by-week history), so they "know" the games they are fit on. Elo uses
 *    the prior week's rating and is leak-free.
 *  - Yes-team orientation alternates by game id parity so the home term is
 *    identifiable.
 */
import { loadAliases, loadModelConfig, writeConfig } from '../src/config';
import { openDb } from '../src/db';
import { loadEnv, requireEnv } from '../src/env';
import { log, runJob } from '../src/log';
import { fitLogistic, type FitSample } from '../src/model/logistic';
import { sourceFeature } from '../src/model/v1';
import { seasonFor } from '../src/season';
import { CfbdClient } from '../src/sources/cfbd';
import { FeiClient } from '../src/sources/fei';
import { SOURCES, type Source } from '../src/types';

runJob('fit', async () => {
  loadEnv();
  const cfg = loadModelConfig();
  const db = openDb();
  const existing = db.prepare('SELECT COUNT(*) AS n FROM forecasts WHERE model_version = ?').get(cfg.model_version) as { n: number };
  if (existing.n > 0) {
    throw new Error(
      `${existing.n} forecast rows already use model_version "${cfg.model_version}". Model versions are immutable: ` +
        `set a new model_version in config/model-v1.json before re-fitting.`,
    );
  }

  const cfbd = new CfbdClient(requireEnv('CFBD_API_KEY'));
  const fei = new FeiClient(requireEnv('FEI_USER_AGENT'));
  const aliases = loadAliases();
  const thisSeason = seasonFor(new Date());
  const samples: Record<Source, FitSample[]> = { sp: [], elo: [], fpi: [], fei: [] };

  for (const season of cfg.fit_seasons) {
    const historical = season < thisSeason;
    const games = (await cfbd.games(season, { historical })).filter((g) => g.completed && g.home_points !== null && g.away_points !== null && g.home_points !== g.away_points);
    log.info(`season ${season}: ${games.length} completed games`);
    const fbs = new Set<string>();
    for (const g of games) {
      fbs.add(g.home_team);
      fbs.add(g.away_team);
    }

    const bySource = new Map<Source, Map<string, number>>();
    bySource.set('sp', await cfbd.sp(season, historical));
    bySource.set('fpi', await cfbd.fpi(season, historical));
    const feiMap = new Map<string, number>();
    for (const r of await fei.ratings(season, { historical: true })) {
      const team = aliases.fei[r.team] ?? r.team;
      if (!fbs.has(team)) throw new Error(`FEI ${season}: unmapped team "${r.team}"; add to config/team-aliases.json`);
      feiMap.set(team, r.fei);
    }
    bySource.set('fei', feiMap);

    const eloByWeek = new Map<number, Map<string, number>>();
    for (const week of new Set(games.map((g) => g.week))) {
      if (week < 2) continue; // no prior-week Elo
      eloByWeek.set(week, await cfbd.elo(season, week - 1, historical));
    }

    for (const g of games) {
      const yesIsHome = g.game_id % 2 === 0;
      const yes = yesIsHome ? g.home_team : g.away_team;
      const opp = yesIsHome ? g.away_team : g.home_team;
      const home: -1 | 0 | 1 = g.neutral_site ? 0 : yesIsHome ? 1 : -1;
      const yesWon = (g.home_points! > g.away_points!) === yesIsHome ? 1 : 0;
      for (const source of SOURCES) {
        const table = source === 'elo' ? eloByWeek.get(g.week) : bySource.get(source);
        const a = table?.get(yes);
        const b = table?.get(opp);
        if (a === undefined || b === undefined) continue;
        samples[source].push({ x: sourceFeature(cfg, source, a - b, home), h: home, y: yesWon });
      }
    }
  }

  const fit_summary: Record<string, unknown> = {};
  const next = { ...cfg, sources: { ...cfg.sources } };
  for (const source of SOURCES) {
    const res = fitLogistic(samples[source]);
    log.info(`${source}: n=${res.n} a=${res.a.toFixed(4)} b=${res.b.toFixed(5)} c=${res.c.toFixed(4)} logloss=${res.logLoss.toFixed(4)} iters=${res.iterations}`);
    next.sources[source] = { ...cfg.sources[source], a: res.a, b: res.b, c: res.c, n: res.n };
    fit_summary[source] = { n: res.n, log_loss: res.logLoss };
  }
  writeConfig('model-v1.json', {
    ...next,
    fitted_at: new Date().toISOString(),
    fit_summary: {
      ...fit_summary,
      note: 'sp/fpi/fei use season-final ratings (in-sample for those seasons); elo uses prior-week ratings.',
    },
  });
  log.info(`wrote config/model-v1.json; CFBD calls this run: ${cfbd.callCount}`);
});
