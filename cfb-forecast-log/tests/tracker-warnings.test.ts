import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb, upsertGames, upsertMarkets } from '../src/db';
import { collectState } from '../src/tracker';
import { game } from './helpers';

test('unchanged ratings warn only once a Tuesday snapshot used them, as one line', () => {
  const db = openDb(':memory:');
  const ins = db.prepare(`INSERT INTO ratings (season, week, source, team, rating, fetched_at) VALUES (2026, ?, ?, ?, ?, '2026-11-22T04:41:39Z')`);
  for (const w of [12, 13]) for (const src of ['sp', 'fpi']) for (let t = 0; t < 60; t++) ins.run(w, src, `T${t}`, t);
  upsertGames(db, [game({ game_id: 1, season: 2026, week: 13, home_team: 'T1', away_team: 'T2', kickoff_utc: '2026-11-28T20:00:00Z' })]);
  const now = new Date('2026-11-22T17:00:00Z');
  const warns = () => collectState(db, now, '', null).warnings.filter((w) => /identical/.test(w));
  assert.equal(warns().length, 0); // weekend preview pulled them early: expected, no warning
  upsertMarkets(db, [{ ticker: 'A', game_id: 1, yes_team: 'T1', close_utc: null }]);
  db.prepare(`INSERT INTO forecasts (game_id, ticker, snapshot_kind, snapshot_utc, model_version, my_prob) VALUES (1, 'A', 'tuesday', '2026-11-24T13:00:00Z', 'v1-blend', 0.5)`).run();
  const w = warns();
  assert.equal(w.length, 1);
  assert.match(w[0], /Week 13 FPI, SP\+ ratings are identical to week 12/);
});

test('a manual run after a failure clears the failed-job warning', () => {
  const db = openDb(':memory:');
  const log = '2026-11-22T12:01:39.340Z ERROR [resolve] FAILED, nothing written for this run: AbortError\n2026-11-22T16:45:42.900Z INFO  [resolve] done in 0.1s\n';
  assert.equal(collectState(db, new Date('2026-11-22T17:00:00Z'), log, null).warnings.filter((x) => /resolve/.test(x)).length, 0);
});
