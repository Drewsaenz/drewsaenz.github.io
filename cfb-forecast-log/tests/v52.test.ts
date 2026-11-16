import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb, upsertGames, type Db } from '../src/db';
import { resolveLoneSurnames, sameName, sameNameStrict } from '../src/model/v2';
import { buildImportance, latestStatuses, loadModelV4Config, lookupImportance, nameMatcher, teamAdjustment, type StatRow } from '../src/model/v4';
import { loadModelV5Config, predictV5 } from '../src/model/v5';
import { alreadyOut } from '../src/model/v51';
import { game } from './helpers';

const v41 = loadModelV4Config('model-v4.1.json');
const v42 = loadModelV4Config('model-v4.2.json');

test('v4.2 config keeps every v4.1 weight and only changes matching', () => {
  const { model_version: a, created_at: _a, _note: _n, name_match, sources: s42, ...rest42 } = v42;
  const { model_version: b, created_at: _b, _note: _m, sources: s41, ...rest41 } = v41;
  assert.equal(a, 'v4.2-avail');
  assert.equal(b, 'v4.1-avail');
  assert.deepEqual(rest42, rest41);
  assert.equal(name_match, 'strict');
  assert.deepEqual(s42, { ...s41, unnamed_outlet: 'by_site' });
  assert.equal(nameMatcher(v41), sameName);
  assert.equal(nameMatcher(v42), sameNameStrict);
});

test('v5.2 config carries v5.1 weights under its own version and reads v4.2', () => {
  const v51 = loadModelV5Config('model-v5.1.json');
  const v52 = loadModelV5Config('model-v5.2.json');
  assert.equal(v52.model_version, 'v5.2-fused');
  assert.equal(v52.injury_model_version, v42.model_version);
  assert.deepEqual(v52.coefs, v51.coefs);
  const x = { p1: 0.55, pVegas: 0.43, injuryPoints: 1.2, hoursToKickoff: 60 };
  assert.equal(predictV5(v52, x), predictV5(v51, x));
});

test('strict names: misspellings and short forms match, teammates who share a last name and initial do not', () => {
  for (const [a, b] of [
    ['Kamarion Taylor', 'Kamario Taylor'],
    ['Cade Klubnik', 'Kade Klubnik'],
    ['Grayson McCall', 'Graceson McCall'],
    ['Xavian Brown', 'Xavon Brown'],
    ["Ja'Kobi Jackson", 'Jacoby Jackson'],
    ['J. Jackson', "Ja'Kobi Jackson"],
    ['D.J. Lagway', 'DJ Lagway'],
    ['Nico Iamaleava Jr.', 'Nico Iamaleava'],
    ['Kam Franklin', 'Kamron Franklin'],
    ['Ryan Coleman Williams', 'Ryan Coleman-Williams'],
  ]) {
    assert.ok(sameNameStrict(a, b), `${a} = ${b}`);
  }
  // Every pair below is two different teammates that sameName calls one player.
  for (const [a, b] of [
    ['Dakorien Moore', 'Dante Moore'],
    ['Jamison Curtis', 'Jared Curtis'],
    ['Cayden Jones', 'Kedrick Bingley-Jones'],
    ['Ahmir Smith', 'Antwan Smith'],
    ['Kenneth Williams', 'Keshawn Williams'],
    ['Amaree Williams', 'Ayden Williams'],
    ['TJ Lockhart', 'Tyler Lockhart'],
    ['Cedrick Beavers', 'Kamron Beavers'],
    ['KK Johnson', 'Kelshaun Johnson'],
  ]) {
    assert.ok(sameName(a, b), `sameName merges ${a} and ${b}`);
    assert.ok(!sameNameStrict(a, b), `${a} != ${b}`);
  }
});

test('strict names: a bare last name matches a full name only when the caller allows it', () => {
  assert.ok(!sameNameStrict('Manning', 'Arch Manning'));
  assert.ok(sameNameStrict('Manning', 'Arch Manning', true));
  assert.ok(sameNameStrict('Gby', 'GBY'));
  assert.ok(!sameNameStrict('Manning', 'Arch Mannion', true)); // two letters apart
});

test('bare last names resolve to the one full name that carries them', () => {
  const m = resolveLoneSurnames(['Toney', 'Malachi Toney', 'Coleman', 'Cam Coleman', 'Devin Coleman', 'Davis', 'Kamario Taylor', 'Kamarion Taylor', 'Taylor']);
  assert.equal(m.get('Toney'), 'Malachi Toney');
  assert.equal(m.get('Coleman'), undefined); // two Colemans: ambiguous
  assert.equal(m.get('Davis'), undefined); // nobody to join
  assert.equal(m.get('Taylor'), 'Kamario Taylor'); // two spellings of one player are one candidate
});

let n = 0;
function fact(db: Db, f: { team: string; player: string; status: string; as_of: string; channel: string | null; url?: string; position?: string; scope?: string }) {
  n += 1;
  db.prepare(
    `INSERT INTO news_facts (source_url, source_channel, source_title, as_of, team_raw, team, player, position, status, scope, detail, confidence, timestamp_sec, extracted_at, model)
     VALUES (?, ?, 't', ?, ?, ?, ?, ?, ?, ?, 'd', 0.9, 0, '2026-11-06T00:00:00Z', 'claude-haiku-5-5')`,
  ).run(f.url ?? `https://site${n}.example/a`, f.channel, f.as_of, f.team, f.team, f.player, f.position ?? 'unknown', f.status, f.scope ?? 'game');
}
function oregon(): Db {
  const db = openDb(':memory:');
  upsertGames(db, [
    game({ game_id: 1, season: 2026, week: 10, home_team: 'Oregon', away_team: 'Iowa', kickoff_utc: '2026-11-07T23:30:00Z' }),
    game({ game_id: 2, season: 2026, week: 11, home_team: 'Oregon', away_team: 'Washington', kickoff_utc: '2026-11-14T20:30:00Z' }),
  ]);
  return db;
}
const AT = '2026-11-13T15:00:00.000Z';
const byName = (rows: ReturnType<typeof latestStatuses>) => Object.fromEntries(rows.map((r) => [r.player, r.status]));

test('v4.2: one outlet on the receiver and one on the quarterback no longer add up to two outlets on one player', () => {
  const db = oregon();
  fact(db, { team: 'Oregon', player: 'Dakorien Moore', status: 'out', position: 'WR', as_of: '2026-11-11T18:00:00Z', channel: 'A' });
  fact(db, { team: 'Oregon', player: 'Dante Moore', status: 'questionable', position: 'QB', as_of: '2026-11-11T19:00:00Z', channel: 'B' });
  assert.deepEqual(byName(latestStatuses(db, v41, 'Oregon', AT)), { 'Dante Moore': 'questionable' }); // the bug
  assert.deepEqual(byName(latestStatuses(db, v42, 'Oregon', AT)), {});
  fact(db, { team: 'Oregon', player: 'Dakorien Moore', status: 'out', position: 'WR', as_of: '2026-11-12T18:00:00Z', channel: 'C' });
  assert.deepEqual(byName(latestStatuses(db, v42, 'Oregon', AT)), { 'Dakorien Moore': 'out' });
});

test('v4.2: a bare last name is a second outlet for the one teammate who has it, and nobody when two do', () => {
  const db = oregon();
  fact(db, { team: 'Oregon', player: 'Malik Benson', status: 'out', position: 'WR', as_of: '2026-11-11T18:00:00Z', channel: 'A' });
  fact(db, { team: 'Oregon', player: 'Benson', status: 'out', as_of: '2026-11-11T19:00:00Z', channel: 'B' });
  fact(db, { team: 'Oregon', player: 'Cam Coleman', status: 'out', position: 'WR', as_of: '2026-11-11T18:00:00Z', channel: 'A' });
  fact(db, { team: 'Oregon', player: 'Devin Coleman', status: 'available', position: 'OL', as_of: '2026-11-11T18:00:00Z', channel: 'A' });
  fact(db, { team: 'Oregon', player: 'Coleman', status: 'out', as_of: '2026-11-11T19:00:00Z', channel: 'B' });
  assert.deepEqual(byName(latestStatuses(db, v42, 'Oregon', AT)), { 'Malik Benson': 'out' });
});

test('v4.2: facts with no channel are separate outlets when they come from different sites', () => {
  const db = oregon();
  fact(db, { team: 'Oregon', player: 'Malik Benson', status: 'out', position: 'WR', as_of: '2026-11-11T18:00:00Z', channel: null, url: 'https://www.one.example/x' });
  fact(db, { team: 'Oregon', player: 'Malik Benson', status: 'out', position: 'WR', as_of: '2026-11-11T19:00:00Z', channel: null, url: 'https://two.example/y' });
  fact(db, { team: 'Oregon', player: 'Evan Stewart', status: 'out', position: 'WR', as_of: '2026-11-11T18:00:00Z', channel: null, url: 'https://www.one.example/x' });
  fact(db, { team: 'Oregon', player: 'Evan Stewart', status: 'out', position: 'WR', as_of: '2026-11-11T19:00:00Z', channel: null, url: 'https://one.example/z' });
  assert.deepEqual(byName(latestStatuses(db, v41, 'Oregon', AT)), {}); // v4.1: all one voice
  assert.deepEqual(byName(latestStatuses(db, v42, 'Oregon', AT)), { 'Malik Benson': 'out' }); // same site twice is still one outlet
});

const row = (team: string, player: string, position: string, statType: string, stat: number): StatRow => ({ team, player, position, statType, stat });
const importance = buildImportance(
  [row('Washington', 'Trevion Cooley', 'RB', 'YDS', 400), row('Washington', 'Jonah Coleman', 'RB', 'YDS', 600), row('Oregon', 'Dante Moore', 'QB', 'YDS', 100)],
  [row('Oregon', 'Evan Stewart', 'WR', 'YDS', 500)],
  [row('Washington', 'Tacario Cooley', 'LB', 'TOT', 40)],
);

test('strict stat lookup: a roster nickname finds the stats row only in the same position group', () => {
  assert.equal(lookupImportance(importance, 'Washington', 'Trey Cooley', sameNameStrict, 'RB')?.name, 'Trevion Cooley');
  assert.equal(lookupImportance(importance, 'Washington', 'Trey Cooley', sameNameStrict, null), null);
  assert.equal(lookupImportance(importance, 'Oregon', 'Dakorien Moore', sameNameStrict, 'WR'), null); // not the quarterback's numbers
  assert.equal(lookupImportance(importance, 'Oregon', 'Dakorien Moore', sameName)?.name, 'Dante Moore'); // what v4.1 does
  assert.equal(lookupImportance(importance, 'Oregon', 'Stewart', sameNameStrict)?.name, 'Evan Stewart');
});

test('v4.2 adjustment: a receiver who shares the quarterback’s last name does not cost QB points', () => {
  const starter = { team: 'Oregon', player: 'Dante Moore', attempts: 300, share: 0.9 };
  const s = [{ player: 'Dakorien Moore', position: 'WR', status: 'out', weight: 1, as_of: AT, source: null, detail: null }];
  assert.equal(teamAdjustment(v41, 'Oregon', s, importance, starter, 0, []).points, v41.qb.points);
  assert.equal(teamAdjustment(v42, 'Oregon', s, importance, starter, 0, []).points, 0);
});

test('v5.2 already-out check uses strict names', () => {
  const db = oregon();
  fact(db, { team: 'Oregon', player: 'Jamison Moore', status: 'out', position: 'LB', as_of: '2026-11-05T18:00:00Z', channel: 'A' });
  fact(db, { team: 'Oregon', player: 'Benson', status: 'out', as_of: '2026-11-05T18:00:00Z', channel: 'A' });
  const prev = '2026-11-07T23:30:00Z';
  assert.ok(alreadyOut(db, 'Oregon', 'Jared Moore', prev)); // v5.1
  assert.ok(!alreadyOut(db, 'Oregon', 'Jared Moore', prev, undefined, sameNameStrict));
  assert.ok(alreadyOut(db, 'Oregon', 'Malik Benson', prev, undefined, sameNameStrict));
});
