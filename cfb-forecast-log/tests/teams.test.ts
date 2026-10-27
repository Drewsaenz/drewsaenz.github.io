import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapTeams, suggestTeams } from '../src/teams';

const cfbd = new Set(['UL Monroe', 'Louisiana', 'Miami', 'Miami (OH)', 'Ohio State', 'Southern Miss', 'Texas']);

test('suggestTeams finds close CFBD names', () => {
  assert.ok(suggestTeams('Louisiana Monroe', cfbd).includes('UL Monroe'));
  assert.equal(suggestTeams('Miami-FL', cfbd)[0], 'Miami');
  assert.equal(suggestTeams('Southern Mississippi', cfbd)[0], 'Southern Miss');
  assert.deepEqual(suggestTeams('Zzz', cfbd), []);
});

test('mapTeams reports every problem at once, distinguishing bad aliases from missing ones', () => {
  const rows = [{ team: 'Texas' }, { team: 'Miami-FL' }, { team: 'UL Monroe' }, { team: 'Southern Mississippi' }];
  const res = mapTeams(rows, (r) => r.team, { 'Miami-FL': 'Miami', 'UL Monroe': 'Louisiana Monroe' }, cfbd, 'FEI 2021');
  assert.deepEqual(res.mapped.map((m) => m.team), ['Texas', 'Miami']);
  assert.equal(res.problems.length, 3); // header + 2
  assert.match(res.problems[1], /aliased to "Louisiana Monroe", which is not a CFBD team.*"UL Monroe"/);
  assert.match(res.problems[2], /has no alias.*"Southern Miss"/);
});

test('expandStateAbbrev expands Kalshi "St." but leaves Saint alone', () => {
  const { expandStateAbbrev, resolveTeam } = require('../src/teams');
  assert.equal(expandStateAbbrev('Boise St.'), 'Boise State');
  assert.equal(expandStateAbbrev('Southeast Missouri St.'), 'Southeast Missouri State');
  assert.equal(expandStateAbbrev('St. Thomas'), 'St. Thomas');
  assert.equal(expandStateAbbrev('Texas'), 'Texas');
  const aliases = { 'San Jose State': 'San José State', 'NC St.': 'NC State', 'St. Thomas': 'St. Thomas (MN)' };
  assert.equal(resolveTeam('San Jose St.', aliases), 'San José State'); // alias of expanded form
  assert.equal(resolveTeam('NC St.', aliases), 'NC State'); // exact alias
  assert.equal(resolveTeam('St. Thomas', aliases), 'St. Thomas (MN)');
  assert.equal(resolveTeam('Ohio St.', aliases), 'Ohio State'); // expansion only
});
