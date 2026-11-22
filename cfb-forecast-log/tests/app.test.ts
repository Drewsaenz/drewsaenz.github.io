import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb, upsertGames, upsertMarkets } from '../src/db';
import { currentBoardWeek, gameDetail, gamesForWeek, health, recentNews } from '../src/app/data';
import { ACTIONS, sameOrigin } from '../src/app/server';
import { game } from './helpers';

function seed() {
  const db = openDb(':memory:');
  upsertGames(db, [
    game({ game_id: 1, season: 2026, week: 13, home_team: 'Texas A&M', away_team: 'Texas', kickoff_utc: '2026-11-28T00:30:00Z' }),
    game({ game_id: 2, season: 2026, week: 13, home_team: 'UCLA', away_team: 'USC', kickoff_utc: '2026-11-28T20:00:00Z' }),
  ]);
  upsertMarkets(db, [
    { ticker: 'TAM', game_id: 1, yes_team: 'Texas A&M', close_utc: null },
    { ticker: 'TEX', game_id: 1, yes_team: 'Texas', close_utc: null },
    { ticker: 'UCLA', game_id: 2, yes_team: 'UCLA', close_utc: null },
  ]);
  const ins = db.prepare(`INSERT INTO forecasts (game_id, ticker, snapshot_kind, snapshot_utc, model_version, my_prob, market_mid, vegas_prob) VALUES (?, ?, 'tuesday', '2026-11-24T13:00:00Z', ?, ?, ?, ?)`);
  ins.run(1, 'TAM', 'v5.1-fused', 0.29, 0.18, 0.29);
  ins.run(1, 'TEX', 'v5.1-fused', 0.71, 0.82, 0.71);
  ins.run(2, 'UCLA', 'v1-blend', 0.6, 0.55, 0.58);
  const fact = db.prepare(`INSERT INTO news_facts (source_url, source_channel, as_of, team_raw, team, player, position, status, scope, game_ref, detail, confidence, extracted_at, model) VALUES (?, ?, ?, ?, ?, ?, 'QB', ?, 'game', ?, 'd', 1, 'x', ?)`);
  fact.run('a', 'SEC availability report', '2026-11-26T01:10:00Z', 'Texas A&M', 'Texas A&M', 'Marcel Reed', 'questionable', 'upcoming', 'availability-report');
  fact.run('b', 'Aggies Wire', '2026-11-25T12:00:00Z', 'Texas A&M', 'Texas A&M', 'Brady Hart', 'limited', 'previous', 'claude-haiku-5-5');
  fact.run('c', 'Sooners Wire', '2026-11-25T12:00:00Z', 'UCLA', 'UCLA', 'Somebody', 'out', 'upcoming', 'claude-haiku-5-5');
  return db;
}

test('board week, game list with SEC flag, game detail from the home market', () => {
  const db = seed();
  assert.deepEqual(currentBoardWeek(db), { season: 2026, week: 13 });
  const gs = gamesForWeek(db, 2026, 13);
  assert.deepEqual(gs.map((g) => [g.home, g.sec]), [['Texas A&M', true], ['UCLA', false]]);
  const d = gameDetail(db, 1)!;
  assert.equal(d.snapshots.length, 1); // home market only
  assert.equal(d.snapshots[0].home_prob, 0.29);
  assert.deepEqual(d.facts.map((f) => [f.player, f.official]), [['Marcel Reed', true]]); // recap hidden
  assert.equal(gameDetail(db, 999), null);
});

test('news window, SEC filter, and health counts', () => {
  const db = seed();
  const now = new Date('2026-11-27T00:00:00Z');
  assert.equal(recentNews(db, { days: 4, now }).length, 2);
  assert.deepEqual(recentNews(db, { days: 4, now, secOnly: true }).map((f) => f.team), ['Texas A&M']);
  const h = health(db, '2026-11-24T13:00:05.000Z INFO  [snapshot:tuesday] done in 4s\n', true, 12);
  assert.equal(h.rows.forecasts, 3);
  assert.equal(h.jobs.find((j) => j.job === 'snapshot:tuesday')?.lastDone, '2026-11-24T13:00:05.000Z');
});

test('the app can only run fixed npm/git commands, none of them touching orders', () => {
  for (const a of Object.values(ACTIONS)) {
    for (const [cmd, args] of a.steps) {
      assert.ok(cmd === 'npm' || cmd === 'git');
      assert.ok(!args.join(' ').match(/order|trade|kalshi/i));
    }
  }
});

test('actions accept only POSTs from the page\'s own host', () => {
  assert.ok(sameOrigin('http://localhost:3300', 'localhost:3300'));
  assert.ok(sameOrigin('https://drews-mac.tail1234.ts.net', 'drews-mac.tail1234.ts.net'));
  assert.ok(!sameOrigin('https://evil.example', 'localhost:3300'));
  assert.ok(!sameOrigin('http://localhost:3300', undefined));
});
