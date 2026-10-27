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
