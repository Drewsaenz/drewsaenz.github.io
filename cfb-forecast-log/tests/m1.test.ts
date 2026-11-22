import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectBoard } from '../src/board';
import type { ScoringConfig } from '../src/config';
import { openDb, upsertGames, upsertMarkets } from '../src/db';
import { buildSpreadSection, gradedSpreadRows } from '../src/jobs/report';
import { fitLine, fitMarginLambda, loadModelM1Config, m1InjuryWeight, predictM1, scoreSpreads, type FittedM1 } from '../src/model/m1';
import { game } from './helpers';

const fitted: FittedM1 = {
  ...loadModelM1Config(),
  fitted_at: '2026-11-22T00:00:00Z',
  sources: { sp: { a: 0, b: 1, c: 3, n: 100 }, fpi: { a: 0, b: 1, c: 3, n: 100 }, fei: { a: 0, b: 10, c: 3, n: 100 }, elo: { a: 0, b: 0.04, c: 3, n: 100 } },
  temper: 1.25,
  lambda: 0.2,
};

test('the shipped m1 config parses and is not fitted', () => {
  const cfg = loadModelM1Config();
  assert.equal(cfg.model_version, 'm1-margin');
  assert.equal(cfg.fitted_at, null);
});

test('fitLine recovers a known line, and drops the home term when it never varies', () => {
  const xs = Array.from({ length: 200 }, (_, i) => ({ x: (i % 40) - 20, h: i % 3 === 0 ? 0 : 1 }));
  const r = fitLine(xs.map((s) => ({ ...s, y: 1 + 0.9 * s.x + 2.5 * s.h })));
  assert.ok(Math.abs(r.a - 1) < 1e-6 && Math.abs(r.b - 0.9) < 1e-6 && Math.abs(r.c - 2.5) < 1e-6);
  const flat = fitLine(xs.map((s) => ({ x: s.x, h: 1, y: 2 * s.x })));
  assert.equal(flat.c, 0);
  assert.ok(Math.abs(flat.b - 2) < 1e-6);
});

test('fitMarginLambda finds the weight and clips to [0, 1]', () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ v: 0, r: i - 25 }));
  assert.ok(Math.abs(fitMarginLambda(rows.map((x) => ({ ...x, y: 0.3 * x.r }))) - 0.3) < 1e-9);
  assert.equal(fitMarginLambda(rows.map((x) => ({ ...x, y: -x.r }))), 0);
  assert.equal(fitMarginLambda(rows.map((x) => ({ ...x, y: 3 * x.r }))), 1);
});

test('predictM1: line moved toward the tempered ratings by lambda, injury faded by hours to kickoff', () => {
  const ratings = new Map([
    ['sp', new Map([['Texas', 20], ['LSU', 12]])],
    ['fpi', new Map([['Texas', 18], ['LSU', 12]])],
  ]);
  const base = { home_team: 'Texas', away_team: 'LSU', neutral: false, ratings, injuryPoints: 0, hoursToKickoff: 0 };
  // sp: 8 + 3 = 11, fpi: 6 + 3 = 9 -> mean 10, / 1.25 = 8
  const noLine = predictM1(fitted, { ...base, vegasSpread: null })!;
  assert.equal(noLine.ratings_margin, 8);
  assert.equal(noLine.home_margin, 8);
  // line Texas -3 -> v = 3; 3 + 0.2 * (8 - 3) = 4
  assert.ok(Math.abs(predictM1(fitted, { ...base, vegasSpread: -3 })!.home_margin - 4) < 1e-9);
  // 2 points of injury edge, 36 h out of a 72 h fade -> +1
  assert.equal(m1InjuryWeight(fitted, 36), 0.5);
  assert.ok(Math.abs(predictM1(fitted, { ...base, vegasSpread: -3, injuryPoints: 2, hoursToKickoff: 36 })!.home_margin - 5) < 1e-9);
  // one source only -> below min_sources
  assert.equal(predictM1(fitted, { ...base, ratings: new Map([['sp', ratings.get('sp')!]]), vegasSpread: -3 }), null);
});

test('scoreSpreads grades against the line: covers, losses and pushes', () => {
  const s = scoreSpreads(
    [
      { model: 7, line: 3, actual: 10 }, // likes home, home covered
      { model: 0, line: 3, actual: 10 }, // likes away, home covered -> loss
      { model: 6, line: 3, actual: 3 }, // push
      { model: 4, line: 3, actual: -20 }, // gap 1 < 2: no pick
    ],
    2,
  );
  assert.deepEqual({ picks: s.ats.picks, won: s.ats.won, lost: s.ats.lost, push: s.ats.push, rate: s.ats.rate }, { picks: 3, won: 1, lost: 1, push: 1, rate: 0.5 });
  assert.equal(s.n, 4);
  assert.equal(s.mae_line, (7 + 7 + 0 + 23) / 4);
});

test('spread_forecasts is append-only, graded in the report, and shown on the board', () => {
  const db = openDb(':memory:');
  upsertGames(db, [game({ game_id: 1, season: 2026, week: 13, home_team: 'Texas', away_team: 'Texas A&M', kickoff_utc: '2026-11-28T00:30:00Z', home_points: 31, away_points: 20, completed: 1 })]);
  upsertMarkets(db, [{ ticker: 'TAMU', game_id: 1, yes_team: 'Texas A&M', close_utc: null }]);
  db.prepare(
    `INSERT INTO forecasts (game_id, ticker, snapshot_kind, snapshot_utc, model_version, my_prob, yes_bid, yes_ask, market_mid, vegas_spread, vegas_prob) VALUES (1, 'TAMU', 'tuesday', '2026-11-24T13:00:00Z', 'v1-blend', 0.45, 40, 41, 0.405, -3, 0.41)`,
  ).run();
  const ins = db.prepare(`INSERT INTO spread_forecasts (game_id, snapshot_kind, snapshot_utc, model_version, home_margin, vegas_spread) VALUES (1, ?, ?, 'm1-margin', ?, -3)`);
  ins.run('tuesday', '2026-11-24T13:00:00Z', 6.2);
  assert.throws(() => ins.run('tuesday', '2026-11-24T13:00:00Z', 7), /UNIQUE/);
  assert.throws(() => db.prepare('DELETE FROM spread_forecasts').run(), /append-only/);
  assert.throws(() => db.prepare('UPDATE spread_forecasts SET home_margin = 0').run(), /append-only/);
  ins.run('pregame', '2026-11-28T01:00:00Z', 6); // after kickoff: not graded

  const rows = gradedSpreadRows(db);
  assert.equal(rows.length, 1);
  const md = buildSpreadSection(rows, 2);
  assert.match(md, /\| m1-margin \| tuesday \| 1 \| 4\.80 \| 8\.00 \|/); // |11-6.2|, |11-3|
  assert.match(md, /\| 1 \| 1-0 \| 100\.0 \|/); // 6.2 vs line 3 -> Texas, covered
  assert.equal(buildSpreadSection([], 2), '');

  const cfg: ScoringConfig = { edge_min: 0.05, taker_fee_rate: 0.07, calibration_bins: 10, news_gap_min: 0.1 };
  const b = collectBoard(db, cfg)!;
  assert.equal(b.rows[0].team, 'Texas A&M');
  assert.equal(b.rows[0].m1_line, 6); // A&M's side of Texas -6.2, to the half point
  assert.equal(b.rows[0].vegas_line, 3);
});
