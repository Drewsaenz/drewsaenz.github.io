import assert from 'node:assert/strict';
import { test } from 'node:test';
import { currentWeek, isoWeekLabel, seasonFor } from '../src/season';
import { pickLine } from '../src/sources/cfbd';
import { buildReport } from '../src/jobs/report';
import { game } from './helpers';

test('seasonFor', () => {
  assert.equal(seasonFor(new Date('2026-10-23T00:00:00Z')), 2026);
  assert.equal(seasonFor(new Date('2026-01-15T00:00:00Z')), 2025);
  assert.equal(seasonFor(new Date('2026-06-01T00:00:00Z')), 2026);
});

test('currentWeek picks the earliest week with an upcoming game', () => {
  const games = [
    game({ game_id: 1, week: 8, kickoff_utc: '2025-10-18T19:00:00Z' }),
    game({ game_id: 2, week: 9, kickoff_utc: '2025-10-25T19:00:00Z' }),
    game({ game_id: 3, week: 10, kickoff_utc: '2025-11-01T19:00:00Z' }),
  ];
  assert.equal(currentWeek(games, new Date('2025-10-21T12:00:00Z')), 9);
  assert.equal(currentWeek(games, new Date('2025-10-25T20:00:00Z')), 10);
  assert.equal(currentWeek(games, new Date('2025-12-01T00:00:00Z')), 10);
  assert.equal(currentWeek([], new Date()), null);
});

test('isoWeekLabel', () => {
  assert.equal(isoWeekLabel(new Date('2026-10-26T12:00:00Z')), '2026-44');
  assert.equal(isoWeekLabel(new Date('2027-01-01T12:00:00Z')), '2026-53');
});

test('pickLine follows provider priority then falls back', () => {
  const lines = [
    { provider: 'DraftKings', spread: -3.5 },
    { provider: 'consensus', spread: null },
    { provider: 'Bovada', spread: -4 },
  ];
  assert.equal(pickLine(lines, ['consensus', 'Bovada', 'DraftKings'])!.provider, 'Bovada');
  assert.equal(pickLine(lines, ['nobody'])!.provider, 'DraftKings');
  assert.equal(pickLine([{ provider: 'x', spread: null }], ['x']), null);
});

test('buildReport renders sections and a 3-line summary', () => {
  const cfg = { edge_min: 0.05, taker_fee_rate: 0.07, calibration_bins: 10 };
  const empty = buildReport([], cfg, new Date('2026-10-26T12:00:00Z'));
  assert.ok(empty.includes('No resolved forecasts yet'));
  const md = buildReport(
    [
      { game_id: 1, ticker: 'A', snapshot_kind: 'tuesday', model_version: 'v1-blend', my_prob: 0.7, market_mid: 0.6, vegas_prob: 0.62, yes_bid: 58, yes_ask: 62, outcome: 1 },
      { game_id: 1, ticker: 'A', snapshot_kind: 'pregame', model_version: 'v1-blend', my_prob: 0.72, market_mid: 0.66, vegas_prob: 0.65, yes_bid: 64, yes_ask: 68, outcome: 1 },
    ],
    cfg,
    new Date('2026-10-26T12:00:00Z'),
  );
  assert.ok(md.startsWith('# cfb-forecast-log report 2026-44'));
  for (const h of ['### Brier / log loss', '### Calibration (tuesday)', '### Hypothetical P&L', '### Edge decay', '## Summary']) assert.ok(md.includes(h), h);
  assert.equal((md.split('## Summary')[1].match(/^- /gm) ?? []).length, 3);
});
