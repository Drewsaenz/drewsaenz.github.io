import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { mapMarketsToGames, tickerDate, type KalshiMarket } from '../src/sources/kalshi';
import { game } from './helpers';

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'kalshi-markets.json'), 'utf8')) as { markets: KalshiMarket[] };
const aliases = { 'Miami (FL)': 'Miami' };

test('tickerDate parses YYMMMDD after the series segment', () => {
  assert.equal(tickerDate('KXNCAAFGAME-25OCT25TEXOU-TEX')!.toISOString().slice(0, 10), '2025-10-25');
  assert.equal(tickerDate('KXNCAAFGAME-26JAN01ABC-A')!.toISOString().slice(0, 10), '2026-01-01');
  assert.equal(tickerDate('NODATE'), null);
});

test('mapMarketsToGames maps by yes team + date and applies aliases', () => {
  const games = [
    game({ game_id: 1, home_team: 'Oklahoma', away_team: 'Texas', kickoff_utc: '2025-10-25T19:30:00Z' }),
    game({ game_id: 2, home_team: 'SMU', away_team: 'Miami', kickoff_utc: '2025-10-26T00:00:00Z' }),
    game({ game_id: 3, home_team: 'Texas', away_team: 'Vanderbilt', kickoff_utc: '2025-11-01T19:30:00Z', week: 10 }),
  ];
  const mapped = mapMarketsToGames(fixture.markets, games, aliases);
  assert.equal(mapped.length, 3);
  assert.equal(mapped[0].game.game_id, 1);
  assert.equal(mapped[0].yes_team, 'Texas');
  assert.equal(mapped[0].yes_bid, 44);
  assert.equal(mapped[1].yes_team, 'Oklahoma');
  assert.equal(mapped[2].game.game_id, 2);
  assert.equal(mapped[2].yes_team, 'Miami');
  assert.equal(mapped[2].close_utc, '2025-10-26T02:00:00.000Z');
});

test('mapMarketsToGames fails loud on an unmapped market instead of guessing', () => {
  const games = [game({ game_id: 1, home_team: 'Oklahoma', away_team: 'Texas', kickoff_utc: '2025-10-25T19:30:00Z' })];
  assert.throws(() => mapMarketsToGames(fixture.markets, games, {}), /Miami \(FL\).*matched 0.*kalshi.*alias/s);
});

test('v1 has no code path that could place an order', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'sources', 'kalshi.ts'), 'utf8');
  for (const forbidden of ['/orders', '/portfolio', 'Authorization', 'KALSHI-ACCESS', 'method: \'POST\'', 'method: "POST"']) {
    assert.ok(!src.includes(forbidden), `kalshi.ts must not contain ${forbidden}`);
  }
  const http = fs.readFileSync(path.join(__dirname, '..', 'src', 'util', 'http.ts'), 'utf8');
  assert.ok(!/method:\s*['"](POST|PUT|DELETE|PATCH)['"]/.test(http));
  assert.ok(/method:\s*'GET'/.test(http));
});
