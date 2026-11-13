import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb, upsertGames, type Db } from '../src/db';
import { coachRole, loadModelV4Config, type TeamAdjustment } from '../src/model/v4';
import { alreadyOut, freshAdjustment, previousKickoff } from '../src/model/v51';
import { loadModelV5Config, predictV5 } from '../src/model/v5';
import { game } from './helpers';

const cfg = loadModelV4Config('model-v4.1.json');

function setup(): Db {
  const db = openDb(':memory:');
  upsertGames(db, [
    game({ game_id: 10, season: 2026, week: 10, home_team: 'Mississippi State', away_team: 'Vanderbilt', kickoff_utc: '2026-11-07T21:15:00Z' }),
    game({ game_id: 11, season: 2026, week: 11, home_team: 'Mississippi State', away_team: 'Auburn', kickoff_utc: '2026-11-14T17:00:00Z' }),
  ]);
  return db;
}
function fact(db: Db, f: { player: string | null; position: string; status: string; as_of: string; scope?: string; detail?: string }) {
  db.prepare(
    `INSERT INTO news_facts (source_url, source_channel, source_title, as_of, team_raw, team, player, position, status, scope, detail, confidence, timestamp_sec, extracted_at, model, game_ref)
     VALUES (?, 'c', 't', ?, 'Mississippi State', 'Mississippi State', ?, ?, ?, ?, ?, 1, 0, 'x', 'm', 'upcoming')`,
  ).run(`u${Math.random()}`, f.as_of, f.player, f.position, f.status, f.scope ?? 'game', f.detail ?? '');
}

const adj = (items: TeamAdjustment['items'], coach: TeamAdjustment['coach'] = []): TeamAdjustment => ({
  team: 'Mississippi State',
  points: items.reduce((n, i) => n + i.points, 0),
  items,
  coach,
  coachPoints: 0,
});
const AT = '2026-11-12T01:40:00Z';

test('previous kickoff is the last game before the snapshot', () => {
  assert.equal(previousKickoff(setup(), 'Mississippi State', AT), '2026-11-07T21:15:00Z');
});

test('players already out for the previous game, and a QB who missed it, are dropped; new injuries stay', () => {
  const db = setup();
  fact(db, { player: 'Isaac Smith', position: 'DB', status: 'out', as_of: '2026-11-05T01:10:00Z' }); // out for last week's game
  fact(db, { player: 'Jalen Smith', position: 'LB', status: 'out', as_of: '2026-10-20T00:00:00Z', scope: 'season' });
  fact(db, { player: 'New Injury', position: 'RB', status: 'out', as_of: '2026-11-11T01:10:00Z' }); // only after last game
  assert.ok(alreadyOut(db, 'Mississippi State', 'Isaac Smith', '2026-11-07T21:15:00Z'));
  assert.ok(alreadyOut(db, 'Mississippi State', 'Jalen Smith', '2026-11-07T21:15:00Z'));
  assert.ok(!alreadyOut(db, 'Mississippi State', 'New Injury', '2026-11-07T21:15:00Z'));
  const a = adj([
    { player: 'Kamario Taylor', group: 'QB', status: 'out', points: 3, note: '' },
    { player: 'Isaac Smith', group: 'DEF', status: 'out', points: 0.2, note: '' },
    { player: 'Jalen Smith', group: 'DEF', status: 'out', points: 0.3, note: '' },
    { player: 'New Injury', group: 'RB', status: 'out', points: 1.1, note: '' },
  ]);
  const f = freshAdjustment(db, cfg, a, AT, 2);
  assert.deepEqual(f.items.map((i) => i.player), ['New Injury']);
  assert.deepEqual(f.dropped.map((i) => i.player).sort(), ['Isaac Smith', 'Jalen Smith', 'Kamario Taylor']);
  assert.ok(Math.abs(f.points - 1.1) < 1e-9);
  // A starter who played last week and is out now still counts in full.
  const q = freshAdjustment(db, cfg, adj([{ player: 'Kamario Taylor', group: 'QB', status: 'out', points: 6, note: '' }]), AT, 0);
  assert.equal(q.points, 6);
});

test('coaching changes from before the previous game no longer count', () => {
  const db = setup();
  const old = { name: 'X', role: 'head' as const, detail: 'Head coach X was fired', as_of: '2026-11-02T00:00:00Z' };
  const fresh = { name: 'Y', role: 'head' as const, detail: 'Head coach Y was fired', as_of: '2026-11-09T00:00:00Z' };
  assert.equal(freshAdjustment(db, cfg, adj([], [old]), AT, 0).points, 0);
  assert.equal(freshAdjustment(db, cfg, adj([], [fresh]), AT, 0).points, cfg.coach.head_coach_change_points);
});

test('with no previous game on file nothing is dropped', () => {
  const db = openDb(':memory:');
  const a = adj([{ player: 'Kamario Taylor', group: 'QB', status: 'out', points: 6, note: '' }]);
  assert.equal(freshAdjustment(db, cfg, a, AT, 3).points, 6);
});

test('coach role: a head coach firing his coordinator is a coordinator change', () => {
  assert.equal(coachRole('Oregon head coach Dan Lanning fired offensive coordinator Drew Mehringer.'), 'coordinator');
  assert.equal(coachRole('Head coach Mike Locksley was fired by Maryland.'), 'head');
  assert.equal(coachRole('Offensive coordinator Joe Smith was named interim head coach'), 'head');
  assert.equal(coachRole('Play-calling duties were handed from head coach Jeff Brohm to his brother Brian Brohm'), 'coordinator');
});

test('v5.1 config carries v5 weights under its own version', () => {
  const v5 = loadModelV5Config();
  const v51 = loadModelV5Config('model-v5.1.json');
  assert.equal(v51.model_version, 'v5.1-fused');
  assert.deepEqual(v51.coefs, v5.coefs);
  const x = { p1: 0.55, pVegas: 0.43, injuryPoints: 0, hoursToKickoff: 60 };
  assert.equal(predictV5(v51, x), predictV5(v5, x));
});
