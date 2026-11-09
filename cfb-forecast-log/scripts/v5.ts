/**
 * v5-fused CLI.
 *   npm run v5:fit    fit the blend weights on this project's graded rows and write config/model-v5.json
 *   npm run v5:check  this week's games: v5 next to v1, Vegas and Kalshi, with the injury term
 *
 * fit, step by step:
 *  1. Rows: graded v1-blend forecasts (Tuesday and pregame, not manual, not
 *     voided) that had a Vegas line at the snapshot. Each row's injury term is
 *     v4.1's adjustment as of that snapshot time (facts published later are
 *     not used), faded by hours to kickoff.
 *  2. Ridge logistic regression toward the config priors, strength prior_weight.
 *  3. Leave-one-week-out Brier for v5, next to Kalshi, Vegas, v1 and the
 *     priors alone on the same rows.
 *  4. Writes coefs, fitted_at and a fit summary. Refuses once v5 rows exist.
 *
 * The injury term uses today's season stats to weigh players (slight
 * hindsight, as in v2:backtest); the facts themselves are as of each snapshot.
 */
import { writeConfig } from '../src/config';
import { openDb } from '../src/db';
import { log, runJob } from '../src/log';
import { seasonContext } from '../src/jobs/context';
import { startersFromAttempts } from '../src/model/v2';
import { logit } from '../src/model/v3';
import { loadModelV4Config, type TeamAdjustment } from '../src/model/v4';
import { adjustmentFor, loadV4Inputs, type V4Inputs } from '../src/model/v4-inputs';
import { MODEL_V5_FILE, brierOf, crossValidate, fitRidgeLogistic, injuryWeight, loadModelV5Config, predictV5, v5Features, type V5Sample } from '../src/model/v5';
import { accuracy } from '../src/score';

const cmd = process.argv[2];
const HOUR = 3_600_000;

interface LoggedRow {
  game_id: number;
  ticker: string;
  snapshot_kind: string;
  snapshot_utc: string;
  my_prob: number;
  market_mid: number | null;
  vegas_prob: number | null;
  outcome: 0 | 1 | null;
  yes_team: string;
  home_team: string;
  away_team: string;
  kickoff_utc: string;
  season: number;
  week: number;
}

function hoursToKickoff(r: { kickoff_utc: string; snapshot_utc: string }): number {
  return (Date.parse(r.kickoff_utc) - Date.parse(r.snapshot_utc)) / HOUR;
}

if (cmd === 'fit') {
  runJob('v5:fit', async () => {
    const cfg = loadModelV5Config();
    const v41 = loadModelV4Config('model-v4.1.json');
    const db = openDb();
    const existing = (db.prepare(`SELECT COUNT(*) AS n FROM forecasts WHERE model_version = ? AND snapshot_kind <> 'manual'`).get(cfg.model_version) as { n: number }).n;
    if (existing > 0) throw new Error(`${existing} ${cfg.model_version} rows already logged; a refit is a new model_version, not an edit of ${MODEL_V5_FILE}`);

    const rows = db
      .prepare(
        `SELECT f.game_id, f.ticker, f.snapshot_kind, f.snapshot_utc, f.my_prob, f.market_mid, f.vegas_prob, f.outcome,
                m.yes_team, g.home_team, g.away_team, g.kickoff_utc, g.season, g.week
           FROM forecasts f JOIN markets m ON m.ticker = f.ticker JOIN games g ON g.game_id = f.game_id
           LEFT JOIN forecast_voids v ON v.forecast_id = f.id
          WHERE f.model_version = ? AND f.snapshot_kind IN ('tuesday', 'pregame') AND f.outcome IS NOT NULL
            AND f.vegas_prob IS NOT NULL AND f.market_mid IS NOT NULL AND v.forecast_id IS NULL
          ORDER BY f.snapshot_utc`,
      )
      .all(cfg.base_model_version) as LoggedRow[];
    if (rows.length < 50) throw new Error(`only ${rows.length} graded ${cfg.base_model_version} rows with a line; need at least 50 to fit`);
    log.info(`${rows.length} graded rows across ${new Set(rows.map((r) => `${r.season}-${r.week}`)).size} week(s)`);

    const { cfbd, season, week } = await seasonContext();
    const inputs = await loadV4Inputs(cfbd, v41, season, week);
    const starters = startersFromAttempts(await cfbd.passAttempts(season), v41.qb.min_starter_share);
    const cache = new Map<string, TeamAdjustment>();
    const adj = (team: string, at: string) => {
      const k = `${team}|${at}`;
      if (!cache.has(k)) cache.set(k, adjustmentFor(db, v41, inputs as V4Inputs, starters, team, at));
      return cache.get(k)!;
    };

    const samples: V5Sample[] = [];
    const side: { kalshi: number; vegas: number; v1: number; y: 0 | 1 }[] = [];
    for (const r of rows) {
      const opp = r.yes_team === r.home_team ? r.away_team : r.home_team;
      const injury = adj(opp, r.snapshot_utc).points - adj(r.yes_team, r.snapshot_utc).points;
      const f = v5Features(cfg, { p1: r.my_prob, pVegas: r.vegas_prob, injuryPoints: injury, hoursToKickoff: hoursToKickoff(r) });
      if (!f) continue;
      samples.push({ f, y: r.outcome!, group: `${r.season}-${String(r.week).padStart(2, '0')}` });
      side.push({ kalshi: r.market_mid!, vegas: r.vegas_prob!, v1: r.my_prob, y: r.outcome! });
    }
    const prior = [cfg.priors.a0, cfg.priors.a, cfg.priors.b, cfg.priors.c];
    const fitted = fitRidgeLogistic(samples, prior, cfg.prior_weight);
    const unpenalised = fitRidgeLogistic(samples, prior, 1e-6);
    const cv = crossValidate(samples, prior, cfg.prior_weight);
    const pairs = (f: (s: (typeof side)[number]) => number) => side.map((s) => ({ p: f(s), y: s.y }));
    const scores = {
      v5_cv_leave_one_week_out: cv.brier,
      v5_in_sample: brierOf(samples, fitted),
      priors_only: brierOf(samples, prior),
      kalshi: accuracy(pairs((s) => s.kalshi)).brier,
      vegas: accuracy(pairs((s) => s.vegas)).brier,
      v1: accuracy(pairs((s) => s.v1)).brier,
    };
    const f4 = (x: number | null | undefined) => (x === null || x === undefined ? 'n/a' : x.toFixed(4));
    console.log(`\nfit on ${samples.length} rows, ${Object.keys(cv.folds).length} week(s) held out in turn\n`);
    console.log(`            a0      a(vegas)  b(v1/temper)  c(injury/pt)`);
    console.log(`prior      ${prior.map((v) => v.toFixed(4).padStart(8)).join('  ')}`);
    console.log(`fitted     ${fitted.map((v) => v.toFixed(4).padStart(8)).join('  ')}   (ridge toward prior, weight ${cfg.prior_weight})`);
    console.log(`unpenalised${unpenalised.map((v) => v.toFixed(4).padStart(8)).join('  ')}   (what the data alone says; noisy)`);
    console.log(`\nBrier on these rows (lower is better)`);
    for (const [k, v] of Object.entries(scores)) console.log(`  ${k.padEnd(26)} ${f4(v)}`);
    console.log(`\nper held-out week: ${Object.entries(cv.folds).map(([g, x]) => `${g} ${x.brier.toFixed(4)} (n=${x.n})`).join(', ')}`);

    const injuryRows = samples.filter((s) => Math.abs(s.f[3]) > 0.05).length;
    log.info(`${injuryRows} of ${samples.length} rows had a non-zero injury term`);
    const next = {
      ...cfg,
      fitted_at: new Date().toISOString(),
      coefs: { a0: fitted[0], a: fitted[1], b: fitted[2], c: fitted[3] },
      fit_summary: {
        samples: samples.length,
        weeks: Object.keys(cv.folds),
        rows_with_injury_term: injuryRows,
        unpenalised: { a0: unpenalised[0], a: unpenalised[1], b: unpenalised[2], c: unpenalised[3] },
        scores,
        folds: cv.folds,
        note: 'Rows are this season\'s graded v1 Tuesday/pregame forecasts with a line. Injury term as of each snapshot (facts), weighted by today\'s season stats (slight hindsight).',
      },
    };
    writeConfig(MODEL_V5_FILE, next);
    log.info(`wrote config/${MODEL_V5_FILE}; the next snapshot logs ${cfg.model_version}`);
  });
} else if (cmd === 'check') {
  runJob('v5:check', async () => {
    const cfg = loadModelV5Config();
    const v41 = loadModelV4Config('model-v4.1.json');
    const db = openDb();
    const { cfbd, season, week } = await seasonContext();
    const latest = db.prepare(`SELECT MAX(snapshot_utc) AS s FROM forecasts WHERE snapshot_kind IN ('tuesday','report','manual')`).get() as { s: string | null };
    if (!latest.s) throw new Error('no snapshot yet');
    const rows = db
      .prepare(
        `SELECT f.game_id, f.ticker, f.snapshot_kind, f.snapshot_utc, f.my_prob, f.market_mid, f.vegas_prob, f.outcome,
                m.yes_team, g.home_team, g.away_team, g.kickoff_utc, g.season, g.week
           FROM forecasts f JOIN markets m ON m.ticker = f.ticker JOIN games g ON g.game_id = f.game_id
          WHERE f.snapshot_utc = ? AND f.model_version = ? AND g.week = ? AND g.kickoff_utc > ? AND m.yes_team = g.home_team
          ORDER BY g.kickoff_utc`,
      )
      .all(latest.s, cfg.base_model_version, week, new Date().toISOString()) as LoggedRow[];
    const inputs = await loadV4Inputs(cfbd, v41, season, week);
    const starters = startersFromAttempts(await cfbd.passAttempts(season), v41.qb.min_starter_share);
    const now = new Date().toISOString();
    const cache = new Map<string, TeamAdjustment>();
    const adj = (t: string) => cache.get(t) ?? cache.set(t, adjustmentFor(db, v41, inputs, starters, t, now)).get(t)!;
    const pct = (x: number | null) => (x === null ? ' n/a' : `${(x * 100).toFixed(0).padStart(3)}%`);
    console.log(`v5 for week ${week} (v1 and prices from the ${latest.s} snapshot; facts as of now${cfg.coefs ? '' : '; PRIORS ONLY, not fitted yet'})\n`);
    for (const r of rows) {
      const injury = adj(r.away_team).points - adj(r.home_team).points;
      const h = (Date.parse(r.kickoff_utc) - Date.now()) / HOUR;
      const p5 = predictV5(cfg, { p1: r.my_prob, pVegas: r.vegas_prob, injuryPoints: injury, hoursToKickoff: h });
      const vs = r.vegas_prob === null ? '' : ` (line ${logit(r.vegas_prob) >= 0 ? 'favours' : 'against'} home)`;
      console.log(
        `${r.away_team} at ${r.home_team}: home v1 ${pct(r.my_prob)}  v5 ${pct(p5)}  Vegas ${pct(r.vegas_prob)}  Kalshi ${pct(r.market_mid)}` +
          `  injury ${injury >= 0 ? '+' : ''}${injury.toFixed(1)} pts x ${injuryWeight(cfg, h).toFixed(2)}${vs}`,
      );
    }
  });
} else {
  console.error('usage: tsx scripts/v5.ts <fit|check>');
  process.exit(2);
}
