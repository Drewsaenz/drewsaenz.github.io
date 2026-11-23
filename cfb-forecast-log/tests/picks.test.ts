import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb, upsertGames } from '../src/db';
import { parseTranscript } from '../src/news';
import { buildPicksSection, conflictedIds, gradePick, leaderboard, loadPicks, mapPickToGame, pickWindows, resolvePickTeam, resolvePicks, storePicks, winRate, type Pick, type PickRow } from '../src/picks';
import { game } from './helpers';

const canonical = new Set(['Notre Dame', 'Miami', 'Ole Miss', 'Georgia', 'Texas', 'Texas A&M', 'BYU', 'Utah', 'Ohio State']);
const aliases = { 'Mississippi': 'Ole Miss', 'Brigham Young': 'BYU' };

test('team names: mascots and "University" fall away, aliases apply, unknown names stay unresolved', () => {
  assert.equal(resolvePickTeam('Notre Dame Fighting Irish', aliases, canonical), 'Notre Dame');
  assert.equal(resolvePickTeam('Mississippi Rebels', aliases, canonical), 'Ole Miss');
  assert.equal(resolvePickTeam('Brigham Young University', aliases, canonical), 'BYU');
  assert.equal(resolvePickTeam('University of Utah', aliases, canonical), 'Utah');
  assert.equal(resolvePickTeam('Texas A&M', aliases, canonical), 'Texas A&M');
  assert.equal(resolvePickTeam('Texas Longhorns', aliases, canonical), 'Texas');
  assert.equal(resolvePickTeam('Dallas Cowboys', aliases, canonical), null);
});

const games = [
  { game_id: 1, kickoff_utc: '2026-11-07T20:00:00.000Z', home_team: 'Notre Dame', away_team: 'Miami' },
  { game_id: 2, kickoff_utc: '2026-11-28T00:30:00.000Z', home_team: 'Texas A&M', away_team: 'Texas' },
];

test('a pick maps to the first game between the two teams after it was published, within nine days', () => {
  assert.equal(mapPickToGame(games, 'Miami', 'Notre Dame', '2026-11-04T12:00:00Z')?.game_id, 1);
  assert.equal(mapPickToGame(games, 'Notre Dame', 'Miami', '2026-11-08T12:00:00Z'), null); // published after kickoff: a recap
  assert.equal(mapPickToGame(games, 'Texas', 'Texas A&M', '2026-11-10T12:00:00Z'), null); // 17 days out
  assert.equal(mapPickToGame(games, 'Texas', 'Texas A&M', '2026-11-22T12:00:00Z')?.game_id, 2);
  assert.equal(mapPickToGame(games, 'Texas', null, '2026-11-22T12:00:00Z'), null);
  assert.equal(mapPickToGame(games, 'Texas', 'Miami', '2026-11-22T12:00:00Z'), null);
});

const row = (p: Partial<PickRow>): PickRow => ({
  id: 1, source_url: 'u', source_channel: 'Show', collection: 'national', as_of: '2026-11-04T12:00:00Z', host: null, team: 'Notre Dame', opponent: 'Miami', game_id: 1,
  kind: 'spread', line: -5.5, strength: 'pick', quote: 'q', home_team: 'Notre Dame', away_team: 'Miami', home_points: 31, away_points: 27, completed: 1,
  kickoff_utc: '2026-11-07T20:00:00.000Z', vegas_spread: -5.5, ...p,
});

test('grading: spread, moneyline, totals and team totals', () => {
  // Notre Dame 31, Miami 27.
  assert.equal(gradePick(row({})).grade, 'loss'); // -5.5, won by 4
  assert.equal(gradePick(row({ team: 'Miami', opponent: 'Notre Dame', line: 5.5 })).grade, 'win');
  assert.equal(gradePick(row({ line: -4 })).grade, 'push');
  assert.equal(gradePick(row({ kind: 'moneyline', line: null })).grade, 'win');
  assert.equal(gradePick(row({ kind: 'moneyline', line: null, team: 'Miami' })).grade, 'loss');
  assert.equal(gradePick(row({ kind: 'lean', line: null })).board, 'lean');
  assert.equal(gradePick(row({ kind: 'total_over', line: 57.5 })).grade, 'win'); // 58
  assert.equal(gradePick(row({ kind: 'total_under', line: 57.5 })).grade, 'loss');
  assert.equal(gradePick(row({ kind: 'team_total_under', line: 27.5, team: 'Miami' })).grade, 'win'); // Miami 27
  assert.equal(gradePick(row({ kind: 'team_total_over', line: 27.5 })).grade, 'win'); // Notre Dame 31
});

test('grading: the stated line is used when believable, the logged Vegas line otherwise', () => {
  const stated = gradePick(row({ line: -3.5 }));
  assert.deepEqual([stated.grade, stated.line_used, stated.line_source], ['win', -3.5, 'stated']);
  // "Notre Dame +5.5" when Vegas has them -5.5: a sign error, graded on Vegas.
  const flipped = gradePick(row({ line: 5.5 }));
  assert.deepEqual([flipped.grade, flipped.line_used, flipped.line_source], ['loss', -5.5, 'vegas']);
  const none = gradePick(row({ line: null }));
  assert.deepEqual([none.grade, none.line_source], ['loss', 'vegas']);
  // Away side: the Vegas number flips.
  assert.equal(gradePick(row({ team: 'Miami', line: null })).line_used, 5.5);
  assert.equal(gradePick(row({ line: null, vegas_spread: null })).ungraded, 'no line stated or logged');
  assert.equal(gradePick(row({ line: -7, vegas_spread: null })).line_source, 'stated');
});

test('grading: unmatched and unplayed picks get no grade', () => {
  assert.equal(gradePick(row({ game_id: null, home_team: null })).ungraded, 'no game matched');
  assert.equal(gradePick(row({ completed: 0, home_points: null, away_points: null })).ungraded, 'not played yet');
  assert.equal(gradePick(row({ kind: 'total_over', line: null })).ungraded, 'no total stated');
});

test('conflicts: both sides of one board in one episode with no named host', () => {
  const r = (id: number, p: Partial<PickRow>) => row({ id, ...p });
  // Miami covers and Notre Dame wins: different boards, no conflict.
  assert.equal(conflictedIds([r(1, { kind: 'spread', team: 'Miami' }), r(2, { kind: 'moneyline', team: 'Notre Dame' })]).size, 0);
  // Two unnamed speakers on opposite sides of the spread.
  assert.deepEqual([...conflictedIds([r(1, { team: 'Miami' }), r(2, { team: 'Notre Dame' }), r(3, { kind: 'total_over', line: 57.5 })])].sort(), [1, 2]);
  // Named hosts are their own picks.
  assert.equal(conflictedIds([r(1, { team: 'Miami', host: 'A' }), r(2, { team: 'Notre Dame', host: 'B' })]).size, 0);
  // Over and under on the same game.
  assert.equal(conflictedIds([r(1, { kind: 'total_over' }), r(2, { kind: 'total_under' })]).size, 2);
  // A lean one way and a moneyline pick the other way.
  assert.equal(conflictedIds([r(1, { kind: 'lean', team: 'Miami' }), r(2, { kind: 'moneyline', team: 'Notre Dame' })]).size, 2);
  // Another episode is another matter.
  assert.equal(conflictedIds([r(1, { team: 'Miami' }), r(2, { team: 'Notre Dame', source_url: 'other' })]).size, 0);
});

test('pick windows keep betting talk and drop the rest', () => {
  const lines = Array.from({ length: 200 }, (_, i) => ({ t: i * 5, text: i === 120 ? 'I am taking the Longhorns minus 7 on Saturday' : 'they ran the ball well in the second half' }));
  const ws = pickWindows(lines);
  assert.equal(ws.length, 1);
  assert.match(ws[0].text, /minus 7/);
  assert.equal(pickWindows(lines.filter((_, i) => i !== 120)).length, 0);
});

const pick = (p: Partial<Pick>): Pick => ({ team_picked: 'Notre Dame', opponent: 'Miami Hurricanes', kind: 'spread', line: -5.5, host: null, strength: 'pick', predicted_score: null, quote: 'q', timestamp_sec: 0, ...p });

test('store, reload, grade and rank; the table refuses updates and deletes', () => {
  const db = openDb(':memory:');
  upsertGames(db, [game({ game_id: 1, season: 2026, week: 10, home_team: 'Notre Dame', away_team: 'Miami', kickoff_utc: '2026-11-07T20:00:00.000Z', home_points: 31, away_points: 27, completed: 1 })]);
  const t = parseTranscript('---\ntitle: Picks show\nchannel: Show A\nurl: https://x.example/1\npublished: 2026-11-04T12:00:00Z\n---\n[0:01] hello\n');
  const picks = [pick({}), pick({ team_picked: 'Miami', opponent: 'Notre Dame', kind: 'moneyline', line: null, host: 'Sam' }), pick({ team_picked: 'Dallas Cowboys', opponent: 'Miami', kind: 'moneyline', line: null })];
  const resolved = resolvePicks(picks, {}, canonical, [{ game_id: 1, kickoff_utc: '2026-11-07T20:00:00.000Z', home_team: 'Notre Dame', away_team: 'Miami' }], t.meta.as_of);
  assert.deepEqual(resolved.map((p) => p.game_id), [1, 1, null]);
  const run = { file: 'f', sha1: 'h', windows: 1, input_tokens: 10, output_tokens: 5, model: 'm' };
  assert.equal(storePicks(db, t.meta, 'national', resolved, run), 3);
  assert.equal(storePicks(db, t.meta, 'national', resolved, run), 0); // idempotent
  const loaded = loadPicks(db);
  assert.equal(loaded.length, 3);
  const board = leaderboard(loaded);
  assert.equal(board.length, 1);
  assert.deepEqual([board[0].source, board[0].graded, board[0].unmatched], ['Show A', 2, 1]);
  assert.deepEqual(board[0].ats, { w: 0, l: 1, p: 0 }); // no logged Vegas line, stated -5.5, won by 4
  assert.deepEqual(board[0].su, { w: 0, l: 1, p: 0 });
  assert.equal(winRate(board[0].ats), 0);
  assert.match(buildPicksSection(loaded, 1), /\| Show A \| 2 \| 0-1 \| 0% \| 0-1 \| 0% \|/);
  assert.throws(() => db.prepare('DELETE FROM picks').run(), /append-only/);
  assert.throws(() => db.prepare("UPDATE picks SET kind = 'lean'").run(), /append-only/);
});

test('the report section says so when there are no picks', () => {
  assert.match(buildPicksSection([]), /No picks stored yet/);
});
