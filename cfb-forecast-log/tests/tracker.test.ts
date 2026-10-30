import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb, upsertGames, upsertMarkets, upsertRatings } from '../src/db';
import { collectState, parseJobLog, renderTracker } from '../src/tracker';
import { game } from './helpers';

// Week 9 of 2026: one Tuesday game, two Thursday games, two Saturday games.
const GAMES = [
  game({ game_id: 1, season: 2026, week: 9, kickoff_utc: '2026-10-27T23:00:00Z', home_team: 'A1', away_team: 'B1' }), // Tue 6pm CT
  game({ game_id: 2, season: 2026, week: 9, kickoff_utc: '2026-10-29T23:30:00Z', home_team: 'A2', away_team: 'B2' }), // Thu
  game({ game_id: 3, season: 2026, week: 9, kickoff_utc: '2026-10-30T00:00:00Z', home_team: 'A3', away_team: 'B3' }), // Thu 7pm CT
  game({ game_id: 4, season: 2026, week: 9, kickoff_utc: '2026-10-31T16:00:00Z', home_team: 'A4', away_team: 'B4' }), // Sat
  game({ game_id: 5, season: 2026, week: 9, kickoff_utc: '2026-10-31T23:30:00Z', home_team: 'A5', away_team: 'B5' }), // Sat
];

function seed() {
  const db = openDb(':memory:');
  upsertGames(db, GAMES);
  upsertRatings(db, [{ season: 2026, week: 9, source: 'sp', team: 'A1', rating: 1, extra: null, fetched_at: '2026-10-27T11:00:00Z' }]);
  const ins = db.prepare(
    `INSERT INTO forecasts (game_id, ticker, snapshot_kind, snapshot_utc, model_version, my_prob) VALUES (?, ?, ?, ?, 'v1-blend', 0.5)`,
  );
  for (const g of GAMES) {
    upsertMarkets(db, [{ ticker: `T${g.game_id}`, game_id: g.game_id, yes_team: g.home_team, close_utc: null }]);
    ins.run(g.game_id, `T${g.game_id}`, 'tuesday', '2026-10-27T12:00:00Z');
  }
  ins.run(2, 'T2', 'pregame', '2026-10-29T22:00:00Z');
  ins.run(3, 'T3', 'pregame', '2026-10-29T22:30:00Z');
  return db;
}

const LOG = [
  '/bin/sh: npm: command not found',
  '2026-10-27T11:00:03.000Z INFO  [ratings] done in 3.2s',
  '2026-10-27T12:00:02.000Z INFO  [snapshot:tuesday] done in 1.1s',
  '2026-10-30T02:30:01.000Z INFO  [snapshot:pregame] done in 1.0s',
  '2026-10-30T03:00:01.000Z INFO  [snapshot:pregame] done in 1.0s',
].join('\n');

test('parseJobLog keeps the latest success and failure per job and ignores noise', () => {
  const runs = parseJobLog(LOG + '\n2026-10-30T03:10:00.000Z ERROR [resolve] FAILED, nothing written');
  assert.equal(runs.find((r) => r.job === 'snapshot:pregame')!.lastDone, '2026-10-30T03:00:01.000Z');
  assert.equal(runs.find((r) => r.job === 'resolve')!.lastFailed, '2026-10-30T03:10:00.000Z');
  assert.equal(runs.find((r) => r.job === 'report')!.lastDone, null);
});

test('Thursday night: pregame in progress, Tuesday game not counted as missed', () => {
  const s = collectState(seed(), new Date('2026-10-30T03:10:00Z'), LOG, null); // Thu 10:10pm CT
  assert.equal(s.week, 9);
  assert.deepEqual(s.stages.map((x) => x.status), ['done', 'done', 'active', 'pending', 'pending']);
  assert.match(s.stages[2].detail, /2 of 4 games captured · 2 to go · 1 Tue\/Wed not tracked/);
  assert.match(s.headline, /Pregame checks running: 2 of 4/);
  assert.deepEqual(s.warnings, []);
});

test('Saturday with stale pregame runs and a missed game raises warnings', () => {
  const s = collectState(seed(), new Date('2026-10-31T17:00:00Z'), LOG, null); // Sat noon CT; game 4 kicked off uncaptured
  assert.match(s.stages[2].detail, /1 missed/);
  assert.ok(s.warnings.some((w) => /without a pregame snapshot/.test(w)));
  assert.ok(s.warnings.some((w) => /last ran \d+ minutes ago/.test(w)));
});

test('a failed job marks its stage failed and warns', () => {
  const log = LOG + '\n2026-11-01T11:00:05.000Z ERROR [resolve] FAILED, nothing written for this run: boom';
  const s = collectState(seed(), new Date('2026-11-01T12:00:00Z'), log, null);
  assert.equal(s.stages[3].status, 'failed');
  assert.ok(s.warnings.some((w) => /resolve job failed/.test(w)));
});

test('graded week plus a newer report file completes every stage', () => {
  const db = seed();
  db.prepare(`UPDATE forecasts SET outcome = 1, resolved_at = '2026-11-02T11:00:00Z'`).run();
  const s = collectState(db, new Date('2026-11-02T12:00:00Z'), LOG, { file: '2026-45.md', mtime: '2026-11-02T11:30:00Z' });
  assert.deepEqual(s.stages.map((x) => x.status), ['done', 'done', 'done', 'done', 'done']);
  assert.equal(s.weeksScored, 1);
  assert.match(s.headline, /report is ready: reports\/2026-45.md/);
});

test('empty database renders a waiting page', () => {
  const s = collectState(openDb(':memory:'), new Date('2026-10-27T10:00:00Z'), '', null);
  assert.equal(s.week, null);
  const html = renderTracker(s);
  assert.match(html, /Waiting for the first Tuesday run/);
  assert.match(html, /<meta http-equiv="refresh"/);
});
