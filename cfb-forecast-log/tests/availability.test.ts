import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanName, factPosition, factStatus, localToUtc, teamReportFacts, type AvailabilityGame } from '../src/availability';

test('conference local time converts to UTC across the DST change', () => {
  assert.equal(localToUtc('2026-11-04', '19:10:00', 'CT'), '2026-11-05T01:10:00.000Z'); // CST, UTC-6
  assert.equal(localToUtc('2026-10-28', '19:10:00', 'CT'), '2026-10-29T00:10:00.000Z'); // CDT, UTC-5
  assert.equal(localToUtc('2026-11-04', '19:10:00', 'ET'), '2026-11-05T00:10:00.000Z');
});

test('report codes map to fact enums', () => {
  assert.equal(factPosition('EDG'), 'EDGE');
  assert.equal(factPosition('NCK'), 'DB');
  assert.equal(factPosition('ILB'), 'LB');
  assert.equal(factPosition('LS'), 'unknown');
  assert.equal(factStatus('Out - (1st Half)'), 'limited');
  assert.equal(factStatus('Game Time Decision'), 'questionable');
  assert.equal(factStatus('Exempt'), null);
});

test('nicknames in quotes are dropped from names', () => {
  assert.equal(cleanName('Karle "KJ" Lacey Jr.'), 'Karle Lacey Jr.');
});

const game: AvailabilityGame = {
  game_key: '10003016',
  report_type: 'Initial',
  publish_date: '2026-11-04',
  posted_time: '19:10:00',
  time_zone: 'CT',
  kickoff_date: '2026-11-07',
  kickoff_time: '15:15:00',
  location: 'Starkville, MS',
  neutral: false,
  teams: [
    {
      team: 'Mississippi St.',
      opponent: 'Vanderbilt',
      rows: [
        { pos: 'QB', jersey: '1', name: 'Kamario Taylor', status: 'Out', exempt: 'Out' },
        { pos: 'LB', jersey: '11', name: 'Tyler Lockhart', status: 'Questionable', exempt: 'NonExempt' },
        { pos: 'QB', jersey: '7', name: 'AJ Swann', status: 'Available', exempt: 'NonExempt' },
        { pos: 'WR', jersey: '3', name: 'Someone Healthy', status: 'Available', exempt: 'NonExempt' },
      ],
    },
  ],
};

test('a team report becomes facts; Available rows only when they clear something', () => {
  const tr = teamReportFacts('SEC', 'https://www.secsports.com/fbreports', game, game.teams[0], (n) => n === 'AJ Swann')!;
  assert.equal(tr.as_of, '2026-11-05T01:10:00.000Z');
  assert.deepEqual(
    tr.facts.map((f) => [f.player, f.position, f.status, f.scope, f.confidence]),
    [
      ['Kamario Taylor', 'QB', 'out', 'season', 1],
      ['Tyler Lockhart', 'LB', 'questionable', 'game', 1],
      ['AJ Swann', 'QB', 'available', 'game', 1],
    ],
  );
  assert.match(tr.url, /#10003016-Mississippi-St--Initial-2026-11-04T19:10:00$/);
  assert.match(tr.facts[0].detail, /SEC initial availability report/);
});

test('a report without a posting time is skipped', () => {
  assert.equal(teamReportFacts('SEC', null, { ...game, posted_time: null }, game.teams[0], () => true), null);
});
