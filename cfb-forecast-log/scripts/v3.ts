/**
 * v3-anchor CLI.
 *   npm run v3:fit    backtest on 2021-2025 and write config/model-v3.json (temper, lambda)
 *   npm run v3:check  re-score this season's logged v1 rows as if v3 had been running
 *
 * fit, step by step:
 *  1. Per season: completed regular-season games with a posted line and a
 *     prior-week Elo for both teams (so week 1 is skipped).
 *  2. Leak size: fit P(win) on Elo diff twice, with prior-week Elo and with
 *     season-final Elo. temper = slope(final) / slope(prior week).
 *  3. Leak-free ratings model: prior-week Elo logistic, out-of-fold by season.
 *  4. lambda = least-log-loss weight on (ratings - line) in logit space, fit on
 *     the out-of-fold predictions; also scored leave-one-season-out.
 *  5. Prints Brier/log loss per season for the line, Elo, the blend, and v1
 *     (v1 is in-sample on SP+/FPI/FEI, flagged as such).
 *
 * Neither constant sees a 2026 game, so v3:check is out-of-sample.
 */
import { loadAliases, loadModelConfig, writeConfig } from '../src/config';
import { openDb } from '../src/db';
import { loadEnv, requireEnv } from '../src/env';
import { log, runJob } from '../src/log';
import { fitLogistic, type FitSample } from '../src/model/logistic';
import { homeIndicator, predictV1, vegasProb } from '../src/model/v1';
import { MODEL_V3_FILE, fitLambda, loadModelV3Config, logit, predictV3, type ModelV3Config } from '../src/model/v3';
import { accuracy } from '../src/score';
import { CfbdClient } from '../src/sources/cfbd';
import { FeiClient } from '../src/sources/fei';
import { mapTeams } from '../src/teams';
import { sigmoid } from '../src/util/math';

interface Sample {
  season: number;
  y: 0 | 1;
  home: -1 | 0 | 1;
  vegas: number; // P(yes) from the line
  eloPrior: number; // yes - opp, prior-week Elo
  eloFinal: number; // yes - opp, season-final Elo
  v1: number | null; // v1 as configured (in-sample on SP+/FPI/FEI)
}

const fmt = (x: number | null) => (x === null ? '   n/a' : x.toFixed(4));

function score(ps: { p: number; y: 0 | 1 }[]) {
  const a = accuracy(ps);
  return { n: a.n, brier: a.brier, logLoss: a.logLoss };
}

const cmd = process.argv[2];

if (cmd === 'fit') {
  runJob('v3:fit', async () => {
    loadEnv();
    const v1 = loadModelConfig();
    const current = loadModelV3Config();
    const db = openDb();
    const existing = db.prepare('SELECT COUNT(*) AS n FROM forecasts WHERE model_version = ?').get(current.model_version) as { n: number };
    if (existing.n > 0) {
      throw new Error(`${existing.n} forecast rows already use "${current.model_version}". Model versions are immutable: set a new model_version in config/${MODEL_V3_FILE} before re-fitting.`);
    }
    const cfbd = new CfbdClient(requireEnv('CFBD_API_KEY'));
    const fei = new FeiClient(requireEnv('FEI_USER_AGENT'));
    const aliases = loadAliases();

    const samples: Sample[] = [];
    for (const season of v1.fit_seasons) {
      const games = (await cfbd.games(season, { historical: true })).filter(
        (g) => g.completed && g.home_points !== null && g.away_points !== null && g.home_points !== g.away_points && g.week >= 2,
      );
      const lines = new Map((await cfbd.lines(season, undefined, true)).map((l) => [l.game_id, l.spread]));
      const fbs = new Set(games.flatMap((g) => [g.home_team, g.away_team]));
      const eloFinal = await cfbd.elo(season, undefined, true);
      const eloByWeek = new Map<number, Map<string, number>>();
      for (const w of new Set(games.map((g) => g.week))) eloByWeek.set(w, await cfbd.elo(season, w - 1, true));
      const feiMap = new Map<string, number>();
      const feiMapping = mapTeams(await fei.ratings(season, { historical: true }), (r) => r.team, aliases.fei, fbs, `FEI ${season}`);
      if (feiMapping.problems.length > 0) throw new Error(feiMapping.problems.join('\n  '));
      for (const { row, team } of feiMapping.mapped) feiMap.set(team, row.fei);
      const sp = await cfbd.sp(season, true);
      const fpi = await cfbd.fpi(season, true);

      let kept = 0;
      for (const g of games) {
        const spread = lines.get(g.game_id);
        if (spread === undefined || spread === null) continue;
        const prior = eloByWeek.get(g.week)!;
        const yesIsHome = g.game_id % 2 === 0; // alternate orientation, as in fit.ts
        const yes = yesIsHome ? g.home_team : g.away_team;
        const opp = yesIsHome ? g.away_team : g.home_team;
        const ep = [prior.get(yes), prior.get(opp)];
        const ef = [eloFinal.get(yes), eloFinal.get(opp)];
        if (ep.includes(undefined) || ef.includes(undefined)) continue;
        const home = homeIndicator(yes, g.home_team, g.neutral_site === 1);
        const ratings = new Map<string, Map<string, number>>([['sp', sp], ['fpi', fpi], ['fei', feiMap], ['elo', prior]]);
        const p1 = predictV1(v1, { yes_team: yes, opponent: opp, home, ratings });
        samples.push({
          season,
          y: (g.home_points! > g.away_points!) === yesIsHome ? 1 : 0,
          home,
          vegas: vegasProb(v1, spread, yesIsHome),
          eloPrior: ep[0]! - ep[1]!,
          eloFinal: ef[0]! - ef[1]!,
          v1: p1?.prob ?? null,
        });
        kept += 1;
      }
      log.info(`season ${season}: ${kept} games with a line and prior-week Elo`);
    }
    if (samples.length < 500) throw new Error(`only ${samples.length} usable historical games; refusing to fit`);

    // 2. Leak size, measured on Elo.
    const fitElo = (xs: Sample[], key: 'eloPrior' | 'eloFinal') => fitLogistic(xs.map((s): FitSample => ({ x: s[key], h: s.home, y: s.y })));
    const prior = fitElo(samples, 'eloPrior');
    const final = fitElo(samples, 'eloFinal');
    const temper = final.b / prior.b;
    log.info(`Elo slope prior-week ${prior.b.toFixed(5)} vs season-final ${final.b.toFixed(5)} -> temper ${temper.toFixed(3)}`);
    if (!(temper >= 1)) throw new Error(`temper ${temper} < 1: season-final Elo fit is not steeper than prior-week; the leak correction does not apply`);

    // 3. Out-of-fold prior-week Elo probabilities.
    const seasons = [...new Set(samples.map((s) => s.season))];
    const oof = new Map<Sample, number>();
    for (const held of seasons) {
      const f = fitElo(samples.filter((s) => s.season !== held), 'eloPrior');
      for (const s of samples.filter((s) => s.season === held)) oof.set(s, sigmoid(f.a + f.b * s.eloPrior + f.c * s.home));
    }

    // 4. lambda on all out-of-fold predictions, plus leave-one-season-out scoring.
    const lamSamples = (xs: Sample[]) => xs.map((s) => ({ v: logit(s.vegas), m: logit(oof.get(s)!), y: s.y }));
    const lambda = fitLambda(lamSamples(samples));
    const cvBlend = new Map<Sample, number>();
    const perSeasonLambda: Record<string, number> = {};
    for (const held of seasons) {
      const lam = fitLambda(lamSamples(samples.filter((s) => s.season !== held)));
      perSeasonLambda[String(held)] = Number(lam.toFixed(4));
      for (const s of samples.filter((s) => s.season === held)) cvBlend.set(s, sigmoid(logit(s.vegas) + lam * (logit(oof.get(s)!) - logit(s.vegas))));
    }
    log.info(`lambda ${lambda.toFixed(4)} (leave-one-season-out: ${Object.entries(perSeasonLambda).map(([k, v]) => `${k}=${v}`).join(', ')})`);

    // 5. Scores.
    console.log('\nseason   n     line Brier  Elo Brier  blend Brier  v1 Brier*   line LL   blend LL');
    const rowsFor = (xs: Sample[]) => ({
      line: score(xs.map((s) => ({ p: s.vegas, y: s.y }))),
      elo: score(xs.map((s) => ({ p: oof.get(s)!, y: s.y }))),
      blend: score(xs.map((s) => ({ p: cvBlend.get(s)!, y: s.y }))),
      v1: score(xs.filter((s) => s.v1 !== null).map((s) => ({ p: s.v1!, y: s.y }))),
    });
    const summary: Record<string, unknown> = {};
    for (const season of [...seasons, 'all' as const]) {
      const xs = season === 'all' ? samples : samples.filter((s) => s.season === season);
      const r = rowsFor(xs);
      summary[String(season)] = { n: xs.length, line_brier: r.line.brier, elo_brier: r.elo.brier, blend_brier: r.blend.brier, v1_in_sample_brier: r.v1.brier };
      console.log(
        `${String(season).padEnd(6)} ${String(xs.length).padStart(5)}   ${fmt(r.line.brier)}     ${fmt(r.elo.brier)}     ${fmt(r.blend.brier)}      ${fmt(r.v1.brier)}    ${fmt(r.line.logLoss)}   ${fmt(r.blend.logLoss)}`,
      );
    }
    console.log('* v1 uses season-final SP+/FPI/FEI here, so its historical score is in-sample and flattering.');

    const next: ModelV3Config = {
      ...current,
      fitted_at: new Date().toISOString(),
      temper: Number(temper.toFixed(4)),
      lambda: Number(lambda.toFixed(4)),
      fit_summary: {
        samples: samples.length,
        seasons,
        elo_slope_prior_week: prior.b,
        elo_slope_season_final: final.b,
        lambda_leave_one_season_out: perSeasonLambda,
        scores: summary,
        note: 'lambda is fit with prior-week Elo as the ratings model (leak-free); v1 is richer, so this weight is conservative. temper assumes SP+/FPI/FEI leak about as much as Elo does.',
      },
    };
    writeConfig(MODEL_V3_FILE, next);
    log.info(`wrote config/${MODEL_V3_FILE}: temper=${next.temper} lambda=${next.lambda}; CFBD calls this run: ${cfbd.callCount}`);
  });
} else if (cmd === 'check') {
  runJob('v3:check', async () => {
    const cfg = loadModelV3Config();
    if (!cfg.fitted_at) throw new Error(`config/${MODEL_V3_FILE} is not fitted; run \`npm run v3:fit\``);
    const db = openDb();
    const rows = db
      .prepare(
        `SELECT f.snapshot_kind, f.my_prob, f.market_mid, f.vegas_prob, f.outcome
           FROM forecasts f
          WHERE f.model_version = ? AND f.snapshot_kind <> 'manual' AND f.outcome IN (0, 1) AND f.market_mid IS NOT NULL`,
      )
      .all(cfg.base_model_version) as { snapshot_kind: string; my_prob: number; market_mid: number; vegas_prob: number | null; outcome: 0 | 1 }[];
    console.log(`v3 = line + ${cfg.lambda} x (v1/${cfg.temper} - line), in logit space. Lower Brier is better.\n`);
    console.log('snapshot   n     v1      v3      Kalshi  Vegas');
    for (const kind of ['tuesday', 'pregame']) {
      const ks = rows.filter((r) => r.snapshot_kind === kind);
      if (ks.length === 0) continue;
      const b = (f: (r: (typeof ks)[number]) => number | null) =>
        accuracy(ks.filter((r) => f(r) !== null).map((r) => ({ p: f(r)!, y: r.outcome }))).brier;
      console.log(
        `${kind.padEnd(9)} ${String(ks.length).padStart(4)}  ${fmt(b((r) => r.my_prob))}  ${fmt(b((r) => predictV3(cfg, r.my_prob, r.vegas_prob)))}  ${fmt(b((r) => r.market_mid))}  ${fmt(b((r) => r.vegas_prob))}`,
      );
    }
    console.log('\nNeither v3 constant was fit on these rows, so this is out-of-sample (one week so far).');
  });
} else {
  console.error('usage: tsx scripts/v3.ts <fit|check>');
  process.exit(2);
}
