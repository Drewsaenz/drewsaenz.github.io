import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb, upsertGames, upsertMarkets } from '../src/db';
import { decide, type PendingForecast } from '../src/grading';
import { collectState } from '../src/tracker';
import { game } from './helpers';

const KICK = '2026-11-07T20:30:00Z';
const p = (over: Partial<PendingForecast> = {}): PendingForecast => ({
  id: 1, game_id: 1, yes_team: 'Texas', snapshot_kind: 'tuesday', snapshot_utc: '2026-11-03T13:00:00Z', stored_kickoff_utc: KICK, ...over,
});
const final = (home: number, away: number) =>
  game({ game_id: 1, home_team: 'Texas', away_team: 'Vanderbilt', kickoff_utc: KICK, home_points: home, away_points: away, completed: 1 });
const at = (iso: string) => new Date(iso);

test('decide grades finals from the yes team side', () => {
  assert.deepEqual(decide(p(), final(30, 20), at('2026-11-08T12:00:00Z')), { kind: 'grade', outcome: 1 });
  assert.deepEqual(decide(p({ yes_team: 'Vanderbilt' }), final(30, 20), at('2026-11-08T12:00:00Z')), { kind: 'grade', outcome: 0 });
});

test('decide waits on unplayed games, then voids them after the grace period', () => {
  const g = game({ game_id: 1, home_team: 'Texas', away_team: 'Vanderbilt', kickoff_utc: KICK });
  assert.deepEqual(decide(p(), g, at('2026-11-09T12:00:00Z')), { kind: 'wait', why: 'not_final' });
  assert.equal(decide(p(), g, at('2026-11-12T12:00:00Z')).kind, 'void');
});

test('decide waits on games CFBD dropped, then voids them; never throws', () => {
  assert.deepEqual(decide(p(), undefined, at('2026-11-08T12:00:00Z')), { kind: 'wait', why: 'missing' });
  assert.equal(decide(p(), undefined, at('2026-11-12T12:00:00Z')).kind, 'void');
});

test('decide voids forecasts for games moved to another week, and pregame rows for moved kickoffs', () => {
  const moved = game({ game_id: 1, home_team: 'Texas', away_team: 'Vanderbilt', kickoff_utc: '2026-11-14T20:30:00Z' });
  assert.equal(decide(p(), moved, at('2026-11-08T12:00:00Z')).kind, 'void');
  const pre = p({ snapshot_kind: 'pregame', snapshot_utc: '2026-11-07T19:30:00Z' });
  assert.deepEqual(decide(pre, final(30, 20), at('2026-11-08T12:00:00Z')), { kind: 'grade', outcome: 1 });
  const late = game({ game_id: 1, home_team: 'Texas', away_team: 'Vanderbilt', kickoff_utc: '2026-11-08T00:30:00Z', home_points: 30, away_points: 20, completed: 1 });
  assert.equal(decide(pre, late, at('2026-11-08T12:00:00Z')).kind, 'void'); // kickoff moved 4h later
  assert.equal(decide(p(), final(20, 20), at('2026-11-08T12:00:00Z')).kind, 'void'); // tie
});

test('voids are append-only and drop out of the tracker grading count', () => {
  const db = openDb(':memory:');
  upsertGames(db, [game({ game_id: 1, season: 2026, week: 10, kickoff_utc: KICK }), game({ game_id: 2, season: 2026, week: 10, kickoff_utc: KICK })]);
  upsertMarkets(db, [{ ticker: 'A', game_id: 1, yes_team: 'Oklahoma', close_utc: null }, { ticker: 'B', game_id: 2, yes_team: 'Oklahoma', close_utc: null }]);
  const ins = db.prepare(`INSERT INTO forecasts (game_id, ticker, snapshot_kind, snapshot_utc, model_version, my_prob, outcome, resolved_at) VALUES (?, ?, 'tuesday', '2026-11-03T13:00:00Z', 'v1-blend', 0.5, ?, ?)`);
  ins.run(1, 'A', 1, '2026-11-08T12:00:00Z');
  const id = ins.run(2, 'B', null, null).lastInsertRowid;
  db.prepare(`INSERT INTO forecast_voids (forecast_id, reason, voided_at) VALUES (?, 'cancelled', '2026-11-12T12:00:00Z')`).run(id);
  assert.throws(() => db.prepare('DELETE FROM forecast_voids').run(), /append-only/);
  assert.throws(() => db.prepare("UPDATE forecast_voids SET reason = 'x'").run(), /append-only/);
  const s = collectState(db, at('2026-11-12T13:00:00Z'), '', null);
  assert.equal(s.stages[3].status, 'done');
  assert.match(s.stages[3].detail, /1 of 1 rows graded · 1 void/);
});
