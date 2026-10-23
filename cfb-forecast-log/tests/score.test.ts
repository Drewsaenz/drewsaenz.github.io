import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ScoringConfig } from '../src/config';
import { accuracy, calibration, compareAccuracy, edgeDecay, hypotheticalPnl, takerFee, type ScoreRow } from '../src/score';

const cfg: ScoringConfig = { edge_min: 0.05, taker_fee_rate: 0.07, calibration_bins: 10 };

function row(p: Partial<ScoreRow> & { my_prob: number; outcome: 0 | 1 }): ScoreRow {
  return { game_id: 1, ticker: 'T', snapshot_kind: 'tuesday', model_version: 'v1-blend', market_mid: null, vegas_prob: null, yes_bid: null, yes_ask: null, ...p };
}

test('accuracy: Brier and log loss', () => {
  const a = accuracy([
    { p: 0.8, y: 1 },
    { p: 0.3, y: 0 },
  ]);
  assert.equal(a.n, 2);
  assert.ok(Math.abs(a.brier! - (0.04 + 0.09) / 2) < 1e-12);
  assert.ok(Math.abs(a.logLoss! - -(Math.log(0.8) + Math.log(0.7)) / 2) < 1e-9);
  assert.deepEqual(accuracy([]), { n: 0, brier: null, logLoss: null });
});

test('compareAccuracy only scores market/vegas where present', () => {
  const c = compareAccuracy([row({ my_prob: 0.6, outcome: 1, market_mid: 0.5 }), row({ my_prob: 0.4, outcome: 0 })]);
  assert.equal(c.mine.n, 2);
  assert.equal(c.market.n, 1);
  assert.equal(c.vegas.n, 0);
});

test('calibration bins', () => {
  const bins = calibration(
    [
      { p: 0.05, y: 0 },
      { p: 0.95, y: 1 },
      { p: 0.92, y: 0 },
      { p: 1.0, y: 1 },
    ],
    10,
  );
  assert.equal(bins.length, 10);
  assert.equal(bins[0].n, 1);
  assert.equal(bins[9].n, 3);
  assert.ok(Math.abs(bins[9].observed! - 2 / 3) < 1e-12);
  assert.equal(bins[5].n, 0);
  assert.equal(bins[5].predicted, null);
});

test('takerFee rounds up to the cent per Kalshi schedule', () => {
  assert.equal(takerFee(0.5, 0.07), 0.02); // 0.0175 -> 0.02
  assert.equal(takerFee(0.47, 0.07), 0.02); // 0.017437 -> 0.02
  assert.equal(takerFee(0.9, 0.07), 0.01); // 0.0063 -> 0.01
  assert.equal(takerFee(0.5, 0), 0);
});

test('hypotheticalPnl applies the edge filter and both styles', () => {
  const rows: ScoreRow[] = [
    // YES edge: my 0.6 vs mid 0.455 -> buy YES, taker at 47c, maker at 44c; wins.
    row({ my_prob: 0.6, outcome: 1, yes_bid: 44, yes_ask: 47, market_mid: 0.455 }),
    // NO edge: my 0.3 vs mid 0.545 -> buy NO, taker at 100-53=47c, maker at 100-56=44c; loses (yes won).
    row({ game_id: 2, my_prob: 0.3, outcome: 1, yes_bid: 53, yes_ask: 56, market_mid: 0.545 }),
    // Below edge: ignored.
    row({ game_id: 3, my_prob: 0.5, outcome: 1, yes_bid: 48, yes_ask: 52, market_mid: 0.5 }),
    // No quote: skipped.
    row({ game_id: 4, my_prob: 0.9, outcome: 1 }),
  ];
  const p = hypotheticalPnl(rows, cfg);
  assert.equal(p.taker.n, 2);
  assert.equal(p.maker.n, 2);
  assert.equal(p.skipped_no_quote, 1);
  const fee = takerFee(0.47, 0.07);
  assert.ok(Math.abs(p.taker.pnl - ((1 - 0.47 - fee) + (-0.47 - fee))) < 1e-9);
  assert.ok(Math.abs(p.maker.pnl - ((1 - 0.44) + -0.44)) < 1e-9);
  assert.ok(Math.abs(p.taker.risked - (2 * 0.47 + 2 * fee)) < 1e-9);
  assert.equal(p.taker.wins, 1);
  assert.match(p.maker_caveat, /not guaranteed/i);
});

test('edgeDecay pairs tuesday and pregame rows on the same market', () => {
  const rows: ScoreRow[] = [
    row({ game_id: 1, snapshot_kind: 'tuesday', my_prob: 0.6, outcome: 1, market_mid: 0.5 }),
    row({ game_id: 1, snapshot_kind: 'pregame', my_prob: 0.7, outcome: 1, market_mid: 0.65 }),
    row({ game_id: 2, snapshot_kind: 'tuesday', my_prob: 0.6, outcome: 0 }), // no pregame twin
  ];
  const d = edgeDecay(rows);
  assert.equal(d.games, 1);
  assert.ok(Math.abs(d.tuesday.mine.brier! - 0.16) < 1e-12);
  assert.ok(Math.abs(d.pregame.mine.brier! - 0.09) < 1e-12);
});
