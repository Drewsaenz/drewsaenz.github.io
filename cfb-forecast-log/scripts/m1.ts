/**
 * m1-margin CLI (the point-spread model, src/model/m1.ts).
 *   npm run m1:fit          fit on 2021-2025 final margins, write config/model-m1.json
 *   npm run m1:check        score m1 on this season's finished games (out of sample) and preview this week
 *   npm run kalshi:series   look for Kalshi college football series other than game winners (spreads, totals)
 *
 * fit, step by step:
 *  1. Per season: completed regular-season games from week 2 on with a posted line,
 *     season-final SP+/FPI/FEI and Elo, and prior-week Elo.
 *  2. One least-squares line per source: home margin = a + b * rating diff + c * home.
 *     SP+/FPI/FEI on season-final ratings (leaky), Elo on prior-week (what a snapshot has).
 *  3. temper = Elo slope on season-final ratings / Elo slope on prior-week ratings.
 *  4. lambda = least-squares weight on (ratings - line) for (actual - line), with
 *     prior-week Elo fit out of fold by season standing in for the ratings (leak-free).
 *  5. Prints MAE / RMSE for the line, Elo alone and the blend, leave-one-season-out,
 *     and the against-the-spread record when the blend is >= ats_min_gap from the line.
 *
 * check scores no injury term (it is not stored for past snapshots); the snapshot job applies it.
 */
import { loadAliases, loadModelConfig, writeConfig } from '../src/config';
import { loadRatings, openDb } from '../src/db';
import { loadEnv, requireEnv } from '../src/env';
import { log, runJob } from '../src/log';
import { ATS_BREAK_EVEN, M1_SOURCES, MODEL_M1_FILE, fitLine, fitMarginLambda, isM1Fitted, loadModelM1Config, predictM1, scoreSpreads, type FittedM1, type M1Source, type SpreadScore } from '../src/model/m1';
import { probToMargin } from '../src/projection';
import { CfbdClient } from '../src/sources/cfbd';
import { FeiClient } from '../src/sources/fei';
import { KalshiClient } from '../src/sources/kalshi';
import { mapTeams } from '../src/teams';

const SD = 13.5;
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '  n/a');
const atsText = (s: SpreadScore) =>
  s.ats.picks === 0 ? 'no picks' : `${s.ats.won}-${s.ats.lost}${s.ats.push ? `-${s.ats.push}` : ''} (${s.ats.rate === null ? 'n/a' : (s.ats.rate * 100).toFixed(1) + '%'}; break-even ${(ATS_BREAK_EVEN * 100).toFixed(1)}%)`;
const line = (x: number) => (Math.round(x * 2) / 2 === 0 ? 'PK' : `${x > 0 ? '+' : '−'}${Math.abs(Math.round(x * 2) / 2)}`);

interface Sample {
  season: number;
  y: number; // home margin
  h: 0 | 1;
  v: number; // line margin (-spread)
  diff: Partial<Record<M1Source, number>>; // home - away, season-final for sp/fpi/fei, prior-week for elo
  eloFinal: number;
}

const cmd = process.argv[2];

if (cmd === 'fit') {
  runJob('m1:fit', async () => {
    loadEnv();
    const v1 = loadModelConfig();
    const cfg = loadModelM1Config();
    const db = openDb();
    const existing = db.prepare('SELECT COUNT(*) AS n FROM spread_forecasts WHERE model_version = ?').get(cfg.model_version) as { n: number };
    if (existing.n > 0) {
      throw new Error(`${existing.n} spread rows already use "${cfg.model_version}". Model versions are immutable: set a new model_version in config/${MODEL_M1_FILE} before re-fitting.`);
    }
    const cfbd = new CfbdClient(requireEnv('CFBD_API_KEY'));
    const fei = new FeiClient(requireEnv('FEI_USER_AGENT'));
    const aliases = loadAliases();

    const samples: Sample[] = [];
    for (const season of v1.fit_seasons) {
      const games = (await cfbd.games(season, { historical: true })).filter((g) => g.completed && g.home_points !== null && g.away_points !== null && g.week >= 2);
      const lines = new Map((await cfbd.lines(season, undefined, true)).map((l) => [l.game_id, l.spread]));
      const fbs = new Set(games.flatMap((g) => [g.home_team, g.away_team]));
      const eloFinal = await cfbd.elo(season, undefined, true);
      const eloByWeek = new Map<number, Map<string, number>>();
      for (const w of new Set(games.map((g) => g.week))) eloByWeek.set(w, await cfbd.elo(season, w - 1, true));
      const feiMap = new Map<string, number>();
      const feiMapping = mapTeams(await fei.ratings(season, { historical: true }), (r) => r.team, aliases.fei, fbs, `FEI ${season}`);
      if (feiMapping.problems.length > 0) throw new Error(feiMapping.problems.join('\n  '));
      for (const { row, team } of feiMapping.mapped) feiMap.set(team, row.fei);
      const final: Record<'sp' | 'fpi' | 'fei', Map<string, number>> = { sp: await cfbd.sp(season, true), fpi: await cfbd.fpi(season, true), fei: feiMap };

      let kept = 0;
      for (const g of games) {
        const spread = lines.get(g.game_id);
        if (spread === undefined || spread === null) continue;
        const prior = eloByWeek.get(g.week)!;
        const ep = [prior.get(g.home_team), prior.get(g.away_team)];
        const ef = [eloFinal.get(g.home_team), eloFinal.get(g.away_team)];
        if (ep.includes(undefined) || ef.includes(undefined)) continue;
        const diff: Sample['diff'] = { elo: ep[0]! - ep[1]! };
        for (const s of ['sp', 'fpi', 'fei'] as const) {
          const a = final[s].get(g.home_team);
          const b = final[s].get(g.away_team);
          if (a !== undefined && b !== undefined) diff[s] = a - b;
        }
        samples.push({ season, y: g.home_points! - g.away_points!, h: g.neutral_site ? 0 : 1, v: -spread, diff, eloFinal: ef[0]! - ef[1]! });
        kept += 1;
      }
      log.info(`season ${season}: ${kept} games with a line and prior-week Elo`);
    }
    if (samples.length < 500) throw new Error(`only ${samples.length} usable historical games; refusing to fit`);

    // 2. Per-source lines.
    const sources = {} as Record<M1Source, { a: number; b: number; c: number; n: number }>;
    const lineSummary: Record<string, unknown> = {};
    for (const s of M1_SOURCES) {
      const xs = samples.filter((x) => x.diff[s] !== undefined).map((x) => ({ x: x.diff[s]!, h: x.h, y: x.y }));
      const r = fitLine(xs);
      sources[s] = { a: r.a, b: r.b, c: r.c, n: r.n };
      lineSummary[s] = { n: r.n, rmse: Number(r.rmse.toFixed(3)) };
      log.info(`${s}: n=${r.n} margin = ${r.a.toFixed(2)} + ${r.b.toFixed(4)} * diff + ${r.c.toFixed(2)} * home   (rmse ${r.rmse.toFixed(2)}${s === 'elo' ? ', prior-week' : ', season-final: in-sample'})`);
    }

    // 3. Leak size on Elo.
    const eloPrior = fitLine(samples.map((x) => ({ x: x.diff.elo!, h: x.h, y: x.y })));
    const eloFin = fitLine(samples.map((x) => ({ x: x.eloFinal, h: x.h, y: x.y })));
    const temper = eloFin.b / eloPrior.b;
    log.info(`Elo slope prior-week ${eloPrior.b.toFixed(5)} vs season-final ${eloFin.b.toFixed(5)} -> temper ${temper.toFixed(3)}`);
    if (!(temper >= 1)) throw new Error(`temper ${temper} < 1: the season-final fit is not steeper; the leak correction does not apply`);

    // 4. lambda on out-of-fold prior-week Elo margins.
    const seasons = [...new Set(samples.map((s) => s.season))];
    const oof = new Map<Sample, number>();
    for (const held of seasons) {
      const f = fitLine(samples.filter((s) => s.season !== held).map((x) => ({ x: x.diff.elo!, h: x.h, y: x.y })));
      for (const s of samples.filter((s) => s.season === held)) oof.set(s, f.a + f.b * s.diff.elo! + f.c * s.h);
    }
    const lamRows = (xs: Sample[]) => xs.map((s) => ({ v: s.v, r: oof.get(s)!, y: s.y }));
    const lambda = fitMarginLambda(lamRows(samples));
    const cv = new Map<Sample, number>();
    const perSeason: Record<string, number> = {};
    for (const held of seasons) {
      const lam = fitMarginLambda(lamRows(samples.filter((s) => s.season !== held)));
      perSeason[String(held)] = Number(lam.toFixed(4));
      for (const s of samples.filter((s) => s.season === held)) cv.set(s, s.v + lam * (oof.get(s)! - s.v));
    }
    log.info(`lambda ${lambda.toFixed(4)} (leave-one-season-out: ${Object.entries(perSeason).map(([k, v]) => `${k}=${v}`).join(', ')})`);

    // 5. Scores (home margins, leave-one-season-out).
    console.log('\nseason     n   line MAE  Elo MAE  blend MAE   line RMSE  blend RMSE   blend vs line, picks >= ' + cfg.ats_min_gap + ' pts');
    const summary: Record<string, unknown> = {};
    for (const season of [...seasons, 'all' as const]) {
      const xs = season === 'all' ? samples : samples.filter((s) => s.season === season);
      const blend = scoreSpreads(xs.map((s) => ({ model: cv.get(s)!, line: s.v, actual: s.y })), cfg.ats_min_gap);
      const elo = scoreSpreads(xs.map((s) => ({ model: oof.get(s)!, line: s.v, actual: s.y })), cfg.ats_min_gap);
      console.log(`${String(season).padEnd(6)} ${String(xs.length).padStart(5)}   ${f1(blend.mae_line).padStart(8)} ${f1(elo.mae_model).padStart(8)} ${f1(blend.mae_model).padStart(10)}   ${f1(blend.rmse_line).padStart(9)} ${f1(blend.rmse_model).padStart(11)}   ${atsText(blend)}`);
      summary[String(season)] = { n: xs.length, mae_line: blend.mae_line, mae_elo: elo.mae_model, mae_blend: blend.mae_model, ats: blend.ats };
    }

    writeConfig(MODEL_M1_FILE, {
      ...cfg,
      fitted_at: new Date().toISOString(),
      sources,
      temper: Number(temper.toFixed(4)),
      lambda: Number(lambda.toFixed(4)),
      fit_summary: { samples: samples.length, seasons, lines: lineSummary, lambda_by_season: perSeason, scores: summary, note: 'lambda fit with prior-week Elo as the ratings model (leak-free, conservative); sp/fpi/fei lines are in-sample on season-final ratings and tempered.' },
    });
    log.info(`wrote config/${MODEL_M1_FILE}; CFBD calls this run: ${cfbd.callCount}`);
  });
} else if (cmd === 'check') {
  runJob('m1:check', async () => {
    const cfg = loadModelM1Config();
    if (!isM1Fitted(cfg)) throw new Error(`config/${MODEL_M1_FILE} is not fitted yet: run \`npm run m1:fit\` first`);
    const db = openDb();
    // One line per game and kind: the v1 row carries the line; v5.1's home probability for comparison.
    const rows = db
      .prepare(
        `SELECT g.game_id, g.season, g.week, g.home_team, g.away_team, g.neutral_site, g.home_points, g.away_points, g.kickoff_utc, g.completed,
                f.snapshot_kind, MAX(f.vegas_spread) AS vegas_spread,
                MAX(CASE WHEN f.model_version LIKE 'v5.1%' THEN CASE WHEN m.yes_team = g.home_team THEN f.my_prob ELSE 1 - f.my_prob END END) AS v51_home
           FROM forecasts f JOIN games g ON g.game_id = f.game_id JOIN markets m ON m.ticker = f.ticker
          WHERE f.snapshot_kind IN ('tuesday','pregame')
            AND f.id NOT IN (SELECT forecast_id FROM forecast_voids)
          GROUP BY g.game_id, f.snapshot_kind`,
      )
      .all() as { game_id: number; season: number; week: number; home_team: string; away_team: string; neutral_site: number; home_points: number | null; away_points: number | null; kickoff_utc: string; completed: number; snapshot_kind: string; vegas_spread: number | null; v51_home: number | null }[];
    const ratingsCache = new Map<string, Map<string, Map<string, number>>>();
    const ratingsFor = (season: number, week: number) => {
      const k = `${season}-${week}`;
      if (!ratingsCache.has(k)) ratingsCache.set(k, loadRatings(db, season, week));
      return ratingsCache.get(k)!;
    };
    const predict = (r: (typeof rows)[number]) =>
      predictM1(cfg as FittedM1, { home_team: r.home_team, away_team: r.away_team, neutral: r.neutral_site === 1, ratings: ratingsFor(r.season, r.week), vegasSpread: r.vegas_spread, injuryPoints: 0, hoursToKickoff: 0 });

    for (const kind of ['tuesday', 'pregame']) {
      const done = rows.filter((r) => r.snapshot_kind === kind && r.completed === 1 && r.home_points !== null && r.vegas_spread !== null);
      const scored: { model: number; line: number; actual: number; v51: number | null }[] = [];
      for (const r of done) {
        const p = predict(r);
        if (!p) continue;
        scored.push({ model: p.home_margin, line: -r.vegas_spread!, actual: r.home_points! - r.away_points!, v51: r.v51_home === null ? null : probToMargin(r.v51_home, SD) });
      }
      const s = scoreSpreads(scored, cfg.ats_min_gap);
      const withV51 = scored.filter((x) => x.v51 !== null);
      const v51 = scoreSpreads(withV51.map((x) => ({ model: x.v51!, line: x.line, actual: x.actual })), cfg.ats_min_gap);
      console.log(`\n${kind}: ${s.n} finished games with a line`);
      console.log(`  MAE   m1 ${f1(s.mae_model)}   Vegas ${f1(s.mae_line)}   v5.1 as points ${f1(v51.mae_model)} (n=${v51.n})`);
      console.log(`  RMSE  m1 ${f1(s.rmse_model)}   Vegas ${f1(s.rmse_line)}`);
      console.log(`  m1 against the spread, |m1 - Vegas| >= ${cfg.ats_min_gap}: ${atsText(s)}`);
      console.log(`  v5.1 as points, same rule: ${atsText(v51)}`);
    }

    const upcoming = rows.filter((r) => r.snapshot_kind === 'tuesday' && r.completed === 0).sort((a, b) => a.kickoff_utc.localeCompare(b.kickoff_utc));
    if (upcoming.length) {
      console.log(`\nThis week (Tuesday lines, no injury term): home team's spread, m1 vs Vegas`);
      const lines = upcoming
        .map((r) => ({ r, p: predict(r) }))
        .filter((x) => x.p !== null)
        .map(({ r, p }) => ({ r, m: -p!.home_margin, v: r.vegas_spread }))
        .sort((a, b) => Math.abs(b.v === null ? 0 : b.m - b.v) - Math.abs(a.v === null ? 0 : a.m - a.v));
      for (const { r, m, v } of lines) {
        const gap = v === null ? '' : `  gap ${(m - v).toFixed(1)}${Math.abs(m - v) >= cfg.ats_min_gap ? ` -> m1 likes ${m < v ? r.home_team : r.away_team}` : ''}`;
        console.log(`  ${`${r.away_team} at ${r.home_team}`.padEnd(42)} ${r.home_team} m1 ${line(m).padStart(6)}  Vegas ${v === null ? '  none' : line(v).padStart(6)}${gap}`);
      }
    }
  });
} else if (cmd === 'series') {
  runJob('kalshi:series', async () => {
    const k = new KalshiClient();
    const found = await k.findSeries(/college football|ncaaf|ncaa football|cfb/i);
    if (found.length === 0) console.log('No Sports series matched college football.');
    for (const s of found) {
      console.log(`\n${s.ticker}  "${s.title}"${s.ticker === k.cfg.series_ticker ? '  (game winner: already logged)' : ''}`);
      if (s.sample.length === 0) console.log('  no open markets right now');
      for (const m of s.sample) console.log(`  ${m.ticker}  ${m.title}`);
    }
  });
} else {
  console.error('usage: tsx scripts/m1.ts <fit|check|series>');
  process.exit(2);
}
