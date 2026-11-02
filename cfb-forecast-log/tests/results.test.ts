import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildResults, niceTicks, renderResults, type ResultRow } from '../src/results';
import { hypotheticalPnl } from '../src/score';

const cfg = { edge_min: 0.05, taker_fee_rate: 0.07, calibration_bins: 10, news_gap_min: 0.1 };
const row = (p: Partial<ResultRow>): ResultRow => ({
  game_id: 1, ticker: 'T', snapshot_kind: 'tuesday', model_version: 'v1-blend', my_prob: 0.6, market_mid: 0.5, vegas_prob: 0.5,
  yes_bid: 48, yes_ask: 52, outcome: 1, season: 2026, week: 9, kickoff_utc: '2026-10-31T16:00:00Z', yes_team: 'Texas', ...p,
});

test('niceTicks spans the range with round steps', () => {
  assert.deepEqual(niceTicks(0.16, 0.18), [0.16, 0.165, 0.17, 0.175, 0.18]);
  const t = niceTicks(-0.73, 8.84);
  assert.ok(t[0] <= -0.73 && t[t.length - 1] >= 8.84);
  assert.ok(niceTicks(0.2, 0.2).length >= 2);
});

test('buildResults: weeks in order, cumulative P&L matches the report totals', () => {
  const rows = [
    row({ game_id: 1, ticker: 'A', week: 10, kickoff_utc: '2026-11-07T16:00:00Z', my_prob: 0.7, outcome: 0 }),
    row({ game_id: 2, ticker: 'B', week: 9, my_prob: 0.7, outcome: 1 }),
    row({ game_id: 3, ticker: 'C', week: 9, my_prob: 0.52, outcome: 1 }), // below edge filter
    row({ game_id: 4, ticker: 'D', week: 9, my_prob: 0.3, outcome: 0, yes_team: 'Ohio State' }), // NO side, wins
  ];
  rows.sort((a, b) => a.kickoff_utc.localeCompare(b.kickoff_utc));
  const r = buildResults('v1-blend', rows, cfg);
  assert.deepEqual(r.weeks.map((w) => w.label), ['Wk 9', 'Wk 10']);
  assert.equal(r.trades.length, 3);
  const pnl = hypotheticalPnl(rows, cfg);
  assert.ok(Math.abs(r.trades[r.trades.length - 1].taker - pnl.taker.pnl) < 1e-9);
  assert.ok(Math.abs(r.trades[r.trades.length - 1].maker - pnl.maker.pnl) < 1e-9);
  assert.ok(r.trades.some((t) => t.label.includes('not Ohio State · won')));
});

test('renderResults draws three charts with table views and escapes names', () => {
  const html = renderResults(buildResults('v1-blend', [row({ yes_team: 'Texas A&M' }), row({ game_id: 2, ticker: 'B', my_prob: 0.2, outcome: 1 })], cfg));
  assert.equal((html.match(/<svg /g) ?? []).length, 3);
  assert.equal((html.match(/<details>/g) ?? []).length, 3);
  assert.match(html, /Texas A&amp;M/);
  assert.doesNotMatch(html, /NaN|undefined/);
});

test('renderResults handles a week with no qualifying trades', () => {
  const html = renderResults(buildResults('v1-blend', [row({ my_prob: 0.5 })], cfg));
  assert.match(html, /No trades cleared the edge filter yet/);
  assert.doesNotMatch(html, /NaN|undefined/);
});
