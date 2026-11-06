import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb, upsertGames, type Db } from '../src/db';
import { latestStatuses, loadModelV4Config, type ModelV4Config } from '../src/model/v4';
import { game } from './helpers';

const v4 = loadModelV4Config();
const v41 = loadModelV4Config('model-v4.1.json');

test('v4.1 config keeps every v4 weight and only adds source layering', () => {
  const { model_version: a, created_at: _a, sources, _note: _n, ...rest41 } = v41;
  const { model_version: b, created_at: _b, _note: _m, ...rest4 } = v4;
  assert.equal(a, 'v4.1-avail');
  assert.equal(b, 'v4-avail');
  assert.deepEqual(rest41, rest4);
  assert.deepEqual(sources, { official_model: 'availability-report', min_unofficial_sources: 2 });
});

let n = 0;
function fact(db: Db, f: { team: string; player: string; status: string; as_of: string; channel: string; official?: boolean; position?: string; scope?: string }) {
  n += 1;
  db.prepare(
    `INSERT INTO news_facts (source_url, source_channel, source_title, as_of, team_raw, team, player, position, status, scope, detail, confidence, timestamp_sec, extracted_at, model)
     VALUES (?, ?, 't', ?, ?, ?, ?, ?, ?, ?, 'd', ?, 0, '2026-11-06T00:00:00Z', ?)`,
  ).run(`u${n}`, f.channel, f.as_of, f.team, f.team, f.player, f.position ?? 'unknown', f.status, f.scope ?? 'game', f.official ? 1 : 0.9, f.official ? 'availability-report' : 'claude-haiku-5-5');
}

// Week 10: Texas played Oct 31; the SEC Thursday report posted Nov 5 7:10 PM CT; snapshot Saturday morning.
function week10(): Db {
  const db = openDb(':memory:');
  upsertGames(db, [
    game({ game_id: 1, season: 2026, week: 9, home_team: 'Texas', away_team: 'Mississippi State', kickoff_utc: '2026-10-31T23:30:00Z' }),
    game({ game_id: 2, season: 2026, week: 10, home_team: 'Missouri', away_team: 'Texas', kickoff_utc: '2026-11-07T17:00:00Z' }),
  ]);
  const REPORT = '2026-11-06T01:10:00.000Z';
  const rep = (player: string, status: string, position: string) => fact(db, { team: 'Texas', player, status, position, as_of: REPORT, channel: 'SEC availability report', official: true });
  rep('Hollywood Smothers', 'out', 'RB');
  rep('Trevor Goosby', 'out', 'OL');
  rep('Colin Simmons', 'questionable', 'EDGE');
  rep('Cam Coleman', 'questionable', 'WR');
  // Shows before the report: contradictory and superseded by it.
  fact(db, { team: 'Texas', player: 'Harris Seymour', status: 'out', position: 'OL', as_of: '2026-11-02T15:00:00Z', channel: 'On Texas Football' });
  fact(db, { team: 'Texas', player: 'Colin Simmons', status: 'out', position: 'EDGE', as_of: '2026-11-04T15:00:00Z', channel: 'On3' });
  fact(db, { team: 'Texas', player: 'Collin Simmons', status: 'returning', position: 'DL', as_of: '2026-11-04T16:00:00Z', channel: 'Inside Texas Football' });
  // One show after the report: not corroborated, ignored.
  fact(db, { team: 'Texas', player: 'Arch Manning', status: 'probable', position: 'QB', as_of: '2026-11-06T17:45:00Z', channel: 'Inside Texas Football' });
  // Two outlets after the report agree a receiver is out: counts, and overrides the report.
  fact(db, { team: 'Texas', player: 'Cam Coleman', status: 'out', position: 'WR', as_of: '2026-11-06T18:00:00Z', channel: 'On Texas Football' });
  fact(db, { team: 'Texas', player: 'Cam Coleman', status: 'out', position: 'WR', as_of: '2026-11-06T19:00:00Z', channel: 'Inside Texas Football' });
  return db;
}

const AT = '2026-11-07T15:30:00.000Z';
const byName = (rows: ReturnType<typeof latestStatuses>) => Object.fromEntries(rows.map((r) => [r.player, r.status]));

test('v4.1: the official report is the whole truth up to its posting time; single-show claims after it are ignored', () => {
  const s = byName(latestStatuses(week10(), v41, 'Texas', AT));
  assert.deepEqual(s, { 'Hollywood Smothers': 'out', 'Trevor Goosby': 'out', 'Colin Simmons': 'questionable', 'Cam Coleman': 'out' });
});

test('v4 (unchanged) still takes the latest fact from any source', () => {
  const s = byName(latestStatuses(week10(), v4, 'Texas', AT));
  assert.equal(s['Harris Seymour'], 'out');
  assert.equal(s['Arch Manning'], 'probable');
});

test('v4.1: before any report this week, news needs two outlets; last week’s report does not carry over', () => {
  const db = week10();
  const s = byName(latestStatuses(db, v41, 'Texas', '2026-11-04T23:00:00.000Z')); // Wednesday, before Thursday's report
  // Simmons: On3 says out, Inside Texas says returning -> the status two outlets support is "returning".
  assert.equal(s['Colin Simmons'] ?? s['Collin Simmons'], 'returning');
  assert.equal(s['Harris Seymour'], undefined); // only one outlet
  assert.equal(s['Hollywood Smothers'], undefined); // the report is not out yet
});

test('v4.1: a team with no official report uses corroborated news only', () => {
  const db = openDb(':memory:');
  upsertGames(db, [game({ game_id: 3, season: 2026, week: 9, home_team: 'Northwestern', away_team: 'Iowa', kickoff_utc: '2026-10-31T17:00:00Z' })]);
  fact(db, { team: 'Northwestern', player: 'Aidan Chiles', status: 'out', position: 'QB', as_of: '2026-11-04T12:00:00Z', channel: 'CFB ON FOX' });
  assert.deepEqual(latestStatuses(db, v41, 'Northwestern', AT), []);
  fact(db, { team: 'Northwestern', player: 'Aidan Chiles', status: 'out', position: 'QB', as_of: '2026-11-05T12:00:00Z', channel: 'On3' });
  assert.deepEqual(byName(latestStatuses(db, v41, 'Northwestern', AT)), { 'Aidan Chiles': 'out' });
});
