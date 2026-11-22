import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBoard, collectBoard, fmtLine, probToLine, renderBoard, tagFor } from '../src/board';
import type { ScoringConfig } from '../src/config';
import { openDb, upsertGames, upsertMarkets } from '../src/db';
import { game } from './helpers';

const cfg: ScoringConfig = { edge_min: 0.05, taker_fee_rate: 0.07, calibration_bins: 10, news_gap_min: 0.1 };

test('tagFor applies edge, news and spread filters in that order', () => {
  assert.equal(tagFor(0.04, 0.6, 0.6, 50, 52, cfg), 'none');
  assert.equal(tagFor(0.09, 0.75, 0.64, 64, 66, cfg), 'news'); // 11 points from Vegas
  assert.equal(tagFor(0.15, 0.82, 0.77, 63, 71, cfg), 'wide');
  assert.equal(tagFor(0.07, 0.64, 0.57, 57, 58, cfg), 'edge');
});

test('board keeps one side per game, prefers v2, and reads the latest Tuesday or manual snapshot', () => {
  const db = openDb(':memory:');
  upsertGames(db, [game({ game_id: 1, season: 2026, week: 10, home_team: 'Texas', away_team: 'Vanderbilt', kickoff_utc: '2026-11-07T20:30:00Z' })]);
  upsertMarkets(db, [
    { ticker: 'TEX', game_id: 1, yes_team: 'Texas', close_utc: null },
    { ticker: 'VAN', game_id: 1, yes_team: 'Vanderbilt', close_utc: null },
  ]);
  const ins = db.prepare(
    `INSERT INTO forecasts (game_id, ticker, snapshot_kind, snapshot_utc, model_version, my_prob, yes_bid, yes_ask, market_mid, vegas_prob) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  ins.run('TEX', 'tuesday', '2026-10-27T12:00:00Z', 'v1-blend', 0.9, 50, 52, 0.51, 0.5); // older snapshot: ignored
  for (const [v, p] of [['v1-blend', 0.66], ['v2-qb', 0.64]] as const) {
    ins.run('TEX', 'manual', '2026-11-02T20:47:00Z', v, p, 57, 58, 0.575, 0.57);
    ins.run('VAN', 'manual', '2026-11-02T20:47:00Z', v, 1 - p, 42, 43, 0.425, 0.43);
  }
  const b = collectBoard(db, cfg)!;
  assert.equal(b.kind, 'manual');
  assert.equal(b.rows.length, 1);
  const r = b.rows[0];
  assert.equal(r.team, 'Texas');
  assert.equal(r.model, 0.64);
  assert.equal(r.v1, 0.66);
  assert.equal(r.tag, 'edge');
  const html = renderBoard(b, (s) => s);
  assert.match(html, /Preview from a manual run/);
  assert.match(html, /v1 66%/);
  assert.equal(buildBoard([], new Map(), cfg).length, 0);
});

test('a manual snapshot covering later weeks still shows only the current week, and v4 is the model when present', () => {
  const db = openDb(':memory:');
  upsertGames(db, [
    game({ game_id: 1, season: 2026, week: 10, home_team: 'Missouri', away_team: 'Texas', kickoff_utc: '2026-11-07T17:00:00Z' }),
    game({ game_id: 2, season: 2026, week: 11, home_team: 'LSU', away_team: 'Texas', kickoff_utc: '2026-11-14T05:00:00Z' }),
  ]);
  upsertMarkets(db, [
    { ticker: 'MIZZ', game_id: 1, yes_team: 'Missouri', close_utc: null },
    { ticker: 'LSU', game_id: 2, yes_team: 'LSU', close_utc: null },
  ]);
  const ins = db.prepare(
    `INSERT INTO forecasts (game_id, ticker, snapshot_kind, snapshot_utc, model_version, my_prob, yes_bid, yes_ask, market_mid, vegas_prob) VALUES (?, ?, ?, ?, ?, ?, 40, 41, 0.405, 0.41)`,
  );
  ins.run(1, 'MIZZ', 'tuesday', '2026-11-03T13:00:00Z', 'v1-blend', 0.34);
  for (const [g, t] of [[1, 'MIZZ'], [2, 'LSU']] as const) {
    ins.run(g, t, 'manual', '2026-11-05T18:47:00Z', 'v1-blend', 0.34);
    ins.run(g, t, 'manual', '2026-11-05T18:47:00Z', 'v2-qb', 0.34);
    ins.run(g, t, 'manual', '2026-11-05T18:47:00Z', 'v4-avail', 0.43);
  }
  const b = collectBoard(db, cfg)!;
  assert.deepEqual(b.rows.map((r) => r.team), ['Missouri']);
  assert.equal(b.rows[0].model, 0.43);
  assert.match(renderBoard(b, (s) => s), /Model v4/);
});

test('SEC filter: games with an SEC team get data-sec and a chip with their count', async () => {
  const { renderBoard, isSecGame } = await import('../src/board');
  assert.ok(isSecGame({ team: 'Indiana', opponent: 'Texas' }));
  assert.ok(!isSecGame({ team: 'UCLA', opponent: 'Michigan' }));
  const row = (team: string, opponent: string) => ({ game_id: 1, team, opponent, kickoff_utc: '2026-11-28T20:30:00Z', v1: 0.5, v2: null, v4: null, v41: null, v5: null, v51: null, model: 0.5, kalshi: 0.5, vegas: 0.5, edge: 0, bid: 49, ask: 51, tag: 'none' as const, qb: [], outcome: null });
  const html = renderBoard({ kind: 'tuesday', snapshot_utc: '2026-11-24T13:00:00Z', rows: [row('Texas', 'Texas A&M'), row('UCLA', 'USC')] as never, edge_min: 0.05, news_gap_min: 0.1 }, (x) => x);
  assert.match(html, /data-f="sec">SEC \(1\)/);
  assert.equal((html.match(/data-sec="1"/g) ?? []).length, 1);
});

test('spread column: probability to a point spread, and the Vegas spread from the backed team side', () => {
  assert.equal(probToLine(0.5), 0);
  assert.equal(probToLine(0.75), -9); // 13.5 * 0.674 = 9.1
  assert.equal(probToLine(0.25), 9);
  assert.equal(fmtLine(-3.5), '−3.5');
  assert.equal(fmtLine(2), '+2');
  assert.equal(fmtLine(0), 'PK');
  const base = { game_id: 1, model_version: 'v1-blend', yes_bid: 40, yes_ask: 41, market_mid: 0.405, outcome: null, home_team: 'LSU', away_team: 'Texas', kickoff_utc: '2026-11-14T00:00:00Z' };
  const rows = buildBoard(
    [
      { ...base, ticker: 'TEX', yes_team: 'Texas', my_prob: 0.6, vegas_prob: 0.41, vegas_spread: -3.5 }, // LSU -3.5 at home
      { ...base, ticker: 'LSU', yes_team: 'LSU', my_prob: 0.4, vegas_prob: 0.59, vegas_spread: -3.5, market_mid: 0.595 },
    ],
    new Map(),
    cfg,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].team, 'Texas');
  assert.equal(rows[0].vegas_line, 3.5); // home spread flipped to Texas's side
  assert.equal(rows[0].model_line, -3.5);
  assert.match(renderBoard({ kind: 'tuesday', snapshot_utc: 'x', rows, edge_min: 0.05, news_gap_min: 0.1 }, (s) => s), /Vegas \+3\.5 · 7 more/);
});
