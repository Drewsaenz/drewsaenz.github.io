import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb, upsertGames, type Db } from '../src/db';
import type { Starter } from '../src/model/v2';
import { latestStatuses, loadModelV4Config, teamAdjustment, type ImportanceIndex } from '../src/model/v4';
import { applyDepthChart, depthChart, voteOf } from '../src/model/v43';
import { loadModelV5Config, predictV5 } from '../src/model/v5';
import { freshAdjustment } from '../src/model/v51';
import { game } from './helpers';

const v42 = loadModelV4Config('model-v4.2.json');
const v43 = loadModelV4Config('model-v4.3.json');
const reed: Starter = { team: 'Texas A&M', player: 'Marcel Reed', attempts: 287, share: 0.92 };
const none: ImportanceIndex = new Map();

let n = 0;
function fact(db: Db, f: { player: string | null; role?: string; status?: string; as_of: string; channel: string; game_ref?: string; model?: string; confidence?: number }) {
  n += 1;
  db.prepare(
    `INSERT INTO news_facts (source_url, source_channel, source_title, as_of, team_raw, team, player, position, status, scope, game_ref, role, detail, confidence, timestamp_sec, extracted_at, model)
     VALUES (?, ?, 't', ?, 'Texas A&M', 'Texas A&M', ?, 'QB', ?, 'game', ?, ?, 'd', ?, 0, '2026-11-21T00:00:00Z', ?)`,
  ).run(`https://s${n}.example/a`, f.channel, f.as_of, f.player, f.status ?? 'unknown', f.game_ref ?? 'upcoming', f.role ?? 'none', f.confidence ?? 0.9, f.model ?? 'claude-haiku-5-5');
}
function aggies(): Db {
  const db = openDb(':memory:');
  upsertGames(db, [
    game({ game_id: 1, season: 2026, week: 11, home_team: 'Texas A&M', away_team: 'Tennessee', kickoff_utc: '2026-11-14T20:30:00Z' }),
    game({ game_id: 2, season: 2026, week: 12, home_team: 'Oklahoma', away_team: 'Texas A&M', kickoff_utc: '2026-11-21T20:45:00Z' }),
  ]);
  return db;
}
const AT = '2026-11-21T19:30:00.000Z';
const adjust = (db: Db, cfg = v43) => applyDepthChart(cfg, teamAdjustment(cfg, 'Texas A&M', latestStatuses(db, cfg, 'Texas A&M', AT), none, reed, 0, []), depthChart(db, cfg, 'Texas A&M', reed, AT));

test('v4.3 is v4.2 plus the depth-chart block; v5.3 carries v5.2 weights and reads v4.3', () => {
  const { model_version: a, created_at: _a, _note: _n, depth_chart, ...rest43 } = v43;
  const { model_version: b, created_at: _b, _note: _m, ...rest42 } = v42;
  assert.deepEqual(rest43, rest42);
  assert.equal(a, 'v4.3-avail');
  assert.equal(b, 'v4.2-avail');
  assert.deepEqual(depth_chart, { bench_points: 3, role_weights: { benched: 1, competition: 0.5 }, min_sources: 2 });
  const v52 = loadModelV5Config('model-v5.2.json');
  const v53 = loadModelV5Config('model-v5.3.json');
  assert.equal(v53.model_version, 'v5.3-fused');
  assert.equal(v53.injury_model_version, 'v4.3-avail');
  assert.deepEqual(v53.coefs, v52.coefs);
  const x = { p1: 0.6, pVegas: 0.55, injuryPoints: 2, hoursToKickoff: 100 };
  assert.equal(predictV5(v53, x), predictV5(v52, x));
});

test('votes: benched or another QB named starter count against the starter; his own "starter" counts for him', () => {
  assert.equal(voteOf({ player: 'Marcel Reed', role: 'benched' }, 'Marcel Reed'), 'benched');
  assert.equal(voteOf({ player: 'Brady Hart', role: 'starter' }, 'Marcel Reed'), 'benched');
  assert.equal(voteOf({ player: 'Marcel Reed', role: 'starter' }, 'Marcel Reed'), 'starter');
  assert.equal(voteOf({ player: 'Brady Hart', role: 'benched' }, 'Marcel Reed'), null);
  assert.equal(voteOf({ player: null, role: 'competition' }, 'Marcel Reed'), 'competition');
  assert.equal(voteOf({ player: null, role: 'starter' }, 'Marcel Reed'), null);
  assert.equal(voteOf({ player: 'Marcel Reed', role: 'none' }, 'Marcel Reed'), null);
});

test('the week 12 case: two outlets say Hart starts, the SEC report says Reed is Available, and the benching still counts', () => {
  const db = aggies();
  fact(db, { player: 'Brady Hart', role: 'starter', status: 'available', as_of: '2026-11-20T22:13:00Z', channel: 'Sooners Wire' });
  fact(db, { player: 'Marcel Reed', role: 'benched', as_of: '2026-11-21T00:30:00Z', channel: 'HEAVY' });
  fact(db, { player: 'Marcel Reed', status: 'available', as_of: '2026-11-21T19:15:00Z', channel: 'SEC availability report', model: 'availability-report', confidence: 1 });
  assert.equal(adjust(db, v42).points, 0); // v4.2: the report clears him
  const a = adjust(db);
  assert.equal(a.points, 3);
  assert.deepEqual(a.items.map((i) => [i.player, i.group, i.status, i.points]), [['Marcel Reed', 'QB', 'benched', 3]]);
});

test('one outlet is not enough, the same outlet twice is one outlet, and recaps do not vote', () => {
  const db = aggies();
  fact(db, { player: 'Marcel Reed', role: 'benched', as_of: '2026-11-20T10:00:00Z', channel: 'Aggies Wire' });
  fact(db, { player: 'Brady Hart', role: 'starter', as_of: '2026-11-20T12:00:00Z', channel: 'Aggies Wire' });
  fact(db, { player: 'Marcel Reed', role: 'benched', as_of: '2026-11-20T13:00:00Z', channel: 'SB Nation', game_ref: 'previous' });
  fact(db, { player: 'Marcel Reed', role: 'benched', as_of: '2026-11-20T14:00:00Z', channel: 'Cover 3', confidence: 0.2 });
  assert.equal(depthChart(db, v43, 'Texas A&M', reed, AT), null);
  assert.equal(adjust(db).points, 0);
});

test('facts from before the previous game do not vote', () => {
  const db = aggies();
  fact(db, { player: 'Marcel Reed', role: 'benched', as_of: '2026-11-13T10:00:00Z', channel: 'A' });
  fact(db, { player: 'Marcel Reed', role: 'benched', as_of: '2026-11-13T11:00:00Z', channel: 'B' });
  assert.equal(depthChart(db, v43, 'Texas A&M', reed, AT), null);
});

test('an undecided job is half weight; one benched plus one undecided outlet is undecided', () => {
  const db = aggies();
  fact(db, { player: null, role: 'competition', as_of: '2026-11-17T10:00:00Z', channel: 'A' });
  fact(db, { player: 'Brady Hart', role: 'competition', as_of: '2026-11-17T11:00:00Z', channel: 'B' });
  assert.equal(depthChart(db, v43, 'Texas A&M', reed, AT)?.status, 'competition');
  assert.equal(adjust(db).points, 1.5);
  const db2 = aggies();
  fact(db2, { player: 'Marcel Reed', role: 'benched', as_of: '2026-11-17T10:00:00Z', channel: 'A' });
  fact(db2, { player: 'Marcel Reed', role: 'competition', as_of: '2026-11-17T11:00:00Z', channel: 'B' });
  assert.equal(depthChart(db2, v43, 'Texas A&M', reed, AT)?.status, 'competition');
});

test('the most recently corroborated word wins: undecided early, benched late; two outlets saying he starts clear it', () => {
  const db = aggies();
  fact(db, { player: 'Marcel Reed', role: 'competition', as_of: '2026-11-16T10:00:00Z', channel: 'A' });
  fact(db, { player: 'Marcel Reed', role: 'competition', as_of: '2026-11-16T11:00:00Z', channel: 'B' });
  fact(db, { player: 'Brady Hart', role: 'starter', as_of: '2026-11-20T10:00:00Z', channel: 'C' });
  fact(db, { player: 'Marcel Reed', role: 'benched', as_of: '2026-11-20T11:00:00Z', channel: 'D' });
  const dc = depthChart(db, v43, 'Texas A&M', reed, AT);
  assert.equal(dc?.status, 'benched');
  assert.equal(dc?.outlets, 2);
  // As of Tuesday, before the Friday reports, it was still a competition.
  assert.equal(depthChart(db, v43, 'Texas A&M', reed, '2026-11-17T13:00:00.000Z')?.status, 'competition');
  fact(db, { player: 'Marcel Reed', role: 'starter', as_of: '2026-11-21T12:00:00Z', channel: 'C' });
  // One outlet walks its report back: the benching is down to one outlet, so the early-week "undecided" is what two outlets still support.
  assert.equal(depthChart(db, v43, 'Texas A&M', reed, AT)?.status, 'competition');
  fact(db, { player: 'Marcel Reed', role: 'starter', as_of: '2026-11-21T13:00:00Z', channel: 'E' });
  assert.equal(depthChart(db, v43, 'Texas A&M', reed, AT), null);
});

test('health and role do not stack: the QB item is the larger of the two', () => {
  const db = aggies();
  fact(db, { player: 'Marcel Reed', role: 'benched', as_of: '2026-11-21T10:00:00Z', channel: 'A' });
  fact(db, { player: 'Marcel Reed', role: 'benched', as_of: '2026-11-21T11:00:00Z', channel: 'B' });
  fact(db, { player: 'Marcel Reed', status: 'out', as_of: '2026-11-21T19:15:00Z', channel: 'SEC availability report', model: 'availability-report', confidence: 1 });
  const a = adjust(db);
  assert.equal(a.points, 6);
  assert.equal(a.items[0].status, 'out');
  const db2 = aggies();
  fact(db2, { player: 'Marcel Reed', role: 'benched', as_of: '2026-11-21T10:00:00Z', channel: 'A' });
  fact(db2, { player: 'Marcel Reed', role: 'benched', as_of: '2026-11-21T11:00:00Z', channel: 'B' });
  fact(db2, { player: 'Marcel Reed', status: 'probable', as_of: '2026-11-21T19:15:00Z', channel: 'SEC availability report', model: 'availability-report', confidence: 1 });
  const b = adjust(db2);
  assert.equal(b.points, 3);
  assert.equal(b.items.length, 1);
  assert.equal(b.items[0].status, 'benched');
});

test('a starter who already sat out the previous game is dropped as priced (v5.1 fresh-news rule)', () => {
  const db = aggies();
  fact(db, { player: 'Marcel Reed', role: 'benched', as_of: '2026-11-21T10:00:00Z', channel: 'A' });
  fact(db, { player: 'Marcel Reed', role: 'benched', as_of: '2026-11-21T11:00:00Z', channel: 'B' });
  const a = adjust(db);
  assert.equal(freshAdjustment(db, v43, a, AT, 0).points, 3);
  const stale = freshAdjustment(db, v43, a, AT, 1);
  assert.equal(stale.points, 0);
  assert.equal(stale.dropped.length, 1);
});

test('no starter on file or no depth_chart block: nothing happens', () => {
  const db = aggies();
  fact(db, { player: 'Marcel Reed', role: 'benched', as_of: '2026-11-21T10:00:00Z', channel: 'A' });
  fact(db, { player: 'Marcel Reed', role: 'benched', as_of: '2026-11-21T11:00:00Z', channel: 'B' });
  assert.equal(depthChart(db, v43, 'Texas A&M', undefined, AT), null);
  assert.equal(depthChart(db, v42, 'Texas A&M', reed, AT), null);
});

test('another QB named the starter is not a benching unless some outlet says the starter was benched', () => {
  const db = aggies();
  // An injury replacement, or "if Reed can't go, Hart starts": nobody says Reed was benched.
  fact(db, { player: 'Brady Hart', role: 'starter', as_of: '2026-11-20T10:00:00Z', channel: 'A' });
  fact(db, { player: 'Brady Hart', role: 'starter', as_of: '2026-11-20T11:00:00Z', channel: 'B' });
  fact(db, { player: 'Brady Hart', role: 'starter', as_of: '2026-11-20T12:00:00Z', channel: 'C' });
  assert.equal(depthChart(db, v43, 'Texas A&M', reed, AT), null);
  fact(db, { player: 'Marcel Reed', role: 'benched', as_of: '2026-11-20T13:00:00Z', channel: 'A' });
  const dc = depthChart(db, v43, 'Texas A&M', reed, AT);
  assert.equal(dc?.status, 'benched');
  assert.equal(dc?.outlets, 3);
});
