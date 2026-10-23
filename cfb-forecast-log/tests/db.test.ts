import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb, upsertGames, upsertMarkets, upsertRatings, loadRatings } from '../src/db';
import { game } from './helpers';

function seeded() {
  const db = openDb(':memory:');
  upsertGames(db, [game({ game_id: 1 })]);
  upsertMarkets(db, [{ ticker: 'T-TEX', game_id: 1, yes_team: 'Texas', close_utc: null }]);
  return db;
}

const insert = `INSERT OR IGNORE INTO forecasts (game_id, ticker, snapshot_kind, snapshot_utc, model_version, my_prob)
                VALUES (@game_id, @ticker, @snapshot_kind, @snapshot_utc, @model_version, @my_prob)`;
const base = { game_id: 1, ticker: 'T-TEX', snapshot_kind: 'tuesday', snapshot_utc: '2025-10-21T12:00:00Z', model_version: 'v1-blend', my_prob: 0.6 };

test('schema applies twice without error', () => {
  const db = openDb(':memory:');
  assert.doesNotThrow(() => db.exec(require('node:fs').readFileSync(require('../src/paths').SCHEMA_PATH, 'utf8')));
});

test('scheduled snapshot kinds are idempotent; manual rows may repeat', () => {
  const db = seeded();
  const s = db.prepare(insert);
  assert.equal(s.run(base).changes, 1);
  assert.equal(s.run({ ...base, snapshot_utc: '2025-10-21T12:05:00Z', my_prob: 0.61 }).changes, 0);
  assert.equal(s.run({ ...base, snapshot_kind: 'pregame' }).changes, 1);
  assert.equal(s.run({ ...base, model_version: 'v2' }).changes, 1);
  assert.equal(db.prepare('INSERT INTO forecasts (game_id, ticker, snapshot_kind, snapshot_utc, model_version, my_prob) VALUES (1, ?, ?, ?, ?, ?)').run('T-TEX', 'manual', 'x', 'v1-blend', 0.5).changes, 1);
  assert.equal(db.prepare('INSERT INTO forecasts (game_id, ticker, snapshot_kind, snapshot_utc, model_version, my_prob) VALUES (1, ?, ?, ?, ?, ?)').run('T-TEX', 'manual', 'y', 'v1-blend', 0.5).changes, 1);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM forecasts').get() as { n: number }).n, 5);
});

test('forecasts is append-only: no deletes, only outcome/resolved_at updates, once', () => {
  const db = seeded();
  db.prepare(insert).run(base);
  assert.throws(() => db.prepare('DELETE FROM forecasts').run(), /append-only/);
  assert.throws(() => db.prepare('UPDATE forecasts SET my_prob = 0.9').run(), /append-only/);
  assert.throws(() => db.prepare('UPDATE forecasts SET snapshot_kind = ?').run('pregame'), /append-only/);
  assert.equal(db.prepare('UPDATE forecasts SET outcome = 1, resolved_at = ?').run('2025-10-26T00:00:00Z').changes, 1);
  assert.throws(() => db.prepare('UPDATE forecasts SET outcome = 0').run(), /append-only/);
});

test('ratings upsert and load by week', () => {
  const db = openDb(':memory:');
  upsertRatings(db, [
    { season: 2025, week: 9, source: 'sp', team: 'Texas', rating: 20, extra: null, fetched_at: 'x' },
    { season: 2025, week: 9, source: 'sp', team: 'Texas', rating: 21, extra: null, fetched_at: 'y' },
    { season: 2025, week: 9, source: 'fei', team: 'Texas', rating: 1, extra: '{"ofei":1}', fetched_at: 'x' },
  ]);
  const r = loadRatings(db, 2025, 9);
  assert.equal(r.get('sp')!.get('Texas'), 21);
  assert.equal(r.get('fei')!.get('Texas'), 1);
  assert.equal(loadRatings(db, 2025, 8).size, 0);
});
