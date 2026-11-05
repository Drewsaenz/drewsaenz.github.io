import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalPlayer, indexRoster } from '../src/players';

const roster = indexRoster([
  { team: 'Mississippi State', first: 'AJ', last: 'Swann', position: 'QB' },
  { team: 'Mississippi State', first: 'Parker', last: 'Puckett', position: 'QB' },
  { team: 'Mississippi State', first: 'Kamario', last: 'Taylor', position: 'QB' },
  { team: 'Mississippi State', first: 'Quentin', last: 'Taylor', position: 'CB' },
  { team: 'Texas', first: 'Cam', last: 'Coleman', position: 'WR' },
  { team: 'Texas', first: 'Jordan', last: 'Coleman', position: 'OL' },
  { team: 'Texas', first: 'Devin', last: 'Coleman', position: 'OL' },
  { team: 'Texas', first: 'Kade', last: 'Phillips', position: 'DB' },
  { team: 'Texas', first: 'Graceson', last: 'Littleton', position: 'DB' },
  { team: 'Texas', first: 'Trevor', last: 'Goosby', position: 'OL' },
  { team: 'Texas', first: 'Kaliq', last: 'Lockett', position: 'WR' },
]);

const c = (team: string, spoken: string, pos: string | null) => canonicalPlayer(roster, team, spoken, pos);

test('caption misspellings resolve to the roster name', () => {
  assert.equal(c('Mississippi State', 'Kamarion Taylor', 'QB'), 'Kamario Taylor');
  assert.equal(c('Mississippi State', 'Camario Taylor', 'QB'), 'Kamario Taylor');
  assert.equal(c('Mississippi State', 'AJ Swan', 'QB'), 'AJ Swann');
  assert.equal(c('Texas', 'Cade Phillips', 'DB'), 'Kade Phillips');
  assert.equal(c('Texas', 'Grayson Littleton', 'DB'), 'Graceson Littleton');
  assert.equal(c('Texas', 'Trevor Goodsby', 'OL'), 'Trevor Goosby');
  assert.equal(c('Texas', 'Kik Lockett', 'unknown'), 'Kaliq Lockett');
});

test('a wrong first name still resolves when the last name and position are unique', () => {
  assert.equal(c('Mississippi State', 'Billy Puckett', 'QB'), 'Parker Puckett');
});

test('an unmatched first name does not pick among several same-named teammates', () => {
  assert.equal(c('Mississippi State', 'Bobby Taylor', 'QB'), null);
});

test('an unmatched first name with no known position does not guess, even for a unique last name', () => {
  assert.equal(c('Mississippi State', 'Billy Puckett', 'unknown'), null);
});

test('a bare last name resolves by position, and stays put when ambiguous', () => {
  assert.equal(c('Texas', 'Coleman', 'WR'), 'Cam Coleman');
  assert.equal(c('Texas', 'Coleman', 'OL'), null);
  assert.equal(c('Mississippi State', 'Taylor', 'QB'), 'Kamario Taylor');
});

test('position separates teammates who share a last name', () => {
  assert.equal(c('Texas', 'Jordan Coleman', 'OL'), 'Jordan Coleman');
  assert.equal(c('Mississippi State', 'Taylor', 'DB'), 'Quentin Taylor');
});

test('no match, unknown team, or a coach: no change', () => {
  assert.equal(c('Texas', 'Arch Manning', 'QB'), null);
  assert.equal(c('Nowhere', 'Cam Coleman', 'WR'), null);
  assert.equal(canonicalPlayer(roster, 'Texas', 'Steve Sarkisian', 'coach'), null);
  assert.equal(canonicalPlayer(roster, 'Texas', null, 'WR'), null);
});

test('a position that rules out the only last-name match does not guess', () => {
  assert.equal(c('Texas', 'Goosby', 'QB'), null);
});

test('a full-name match wins over a wrong position label', () => {
  assert.equal(c('Texas', 'Cade Phillips', 'LB'), 'Kade Phillips');
  assert.equal(c('Mississippi State', 'Camario Taylor', 'RB'), 'Kamario Taylor');
});
