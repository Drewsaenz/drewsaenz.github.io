import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb, type Db } from '../src/db';
import { adjustForQb, sameName, starterStatus, startersFromAttempts, type ModelV2Config } from '../src/model/v2';

const cfg: ModelV2Config = {
  model_version: 'v2-qb',
  base_model_version: 'v1-blend',
  created_at: '2026-11-02',
  points_to_logit: 0.14105,
  qb: {
    out_points: 6,
    status_weights: { out: 1, doubtful: 0.75, questionable: 0, limited: 0, probable: 0, available: 0, returning: 0 },
    lookback_days: 8,
    min_confidence: 0.5,
    min_starter_share: 0.4,
  },
  clamp: [0.02, 0.98],
};

let n = 0;
function fact(db: Db, f: { team: string; player: string; status: string; as_of: string; scope?: string; confidence?: number; position?: string }): void {
  n += 1;
  db.prepare(
    `INSERT INTO news_facts (source_url, source_channel, source_title, as_of, team_raw, team, player, position, status, scope, detail, confidence, timestamp_sec, extracted_at, model)
     VALUES (?, 'c', 't', ?, ?, ?, ?, ?, ?, ?, 'd', ?, 0, '2026-11-02T00:00:00Z', 'test')`,
  ).run(`https://x/${n}`, f.as_of, f.team, f.team, f.player, f.position ?? 'QB', f.status, f.scope ?? 'game', f.confidence ?? 1);
}

const starters = startersFromAttempts(
  [
    { team: 'Mississippi State', player: 'Kamario Taylor', attempts: 240 },
    { team: 'Mississippi State', player: 'Blake Shapen', attempts: 30 },
    { team: 'Texas', player: 'Arch Manning', attempts: 300 },
    { team: 'Committee U', player: 'A One', attempts: 50 },
    { team: 'Committee U', player: 'B Two', attempts: 45 },
    { team: 'Committee U', player: 'C Three', attempts: 40 },
  ],
  0.4,
);

test('starters are season attempt leaders with a real share', () => {
  assert.equal(starters.get('Mississippi State')?.player, 'Kamario Taylor');
  assert.equal(starters.get('Texas')?.player, 'Arch Manning');
  assert.equal(starters.has('Committee U'), false); // 37% share: no clear starter
});

test('sameName tolerates transcript misspellings but not different players', () => {
  assert.ok(sameName('Kamarion Taylor', 'Kamario Taylor'));
  assert.ok(sameName('Cade Klubnik', 'Kade Klubnik'));
  assert.ok(sameName('Grayson McCall', 'Graceson McCall'));
  assert.ok(sameName('Manning', 'Arch Manning'));
  assert.ok(sameName('D.J. Lagway', 'DJ Lagway'));
  assert.ok(sameName('Nico Iamaleava Jr.', 'Nico Iamaleava'));
  assert.ok(!sameName('Blake Shapen', 'Kamario Taylor'));
  assert.ok(!sameName('Peyton Manning', 'Arch Manning'));
});

test('starterStatus: latest fact before the snapshot wins; backups, speculation and future facts are ignored', () => {
  const db = openDb(':memory:');
  const at = '2026-11-03T13:00:00.000Z';
  fact(db, { team: 'Mississippi State', player: 'Blake Shapen', status: 'out', as_of: '2026-11-02T12:00:00Z' }); // backup
  assert.equal(starterStatus(db, cfg, 'Mississippi State', starters.get('Mississippi State'), at), null);

  fact(db, { team: 'Mississippi State', player: 'Kamarion Taylor', status: 'out', as_of: '2026-11-01T12:00:00Z', confidence: 0.2 }); // speculation
  assert.equal(starterStatus(db, cfg, 'Mississippi State', starters.get('Mississippi State'), at), null);

  fact(db, { team: 'Mississippi State', player: 'Kamarion Taylor', status: 'out', as_of: '2026-11-02T12:00:00Z' });
  assert.equal(starterStatus(db, cfg, 'Mississippi State', starters.get('Mississippi State'), at)?.weight, 1);

  fact(db, { team: 'Mississippi State', player: 'Kamario Taylor', status: 'available', as_of: '2026-11-04T12:00:00Z' }); // after snapshot
  assert.equal(starterStatus(db, cfg, 'Mississippi State', starters.get('Mississippi State'), at)?.status, 'out');
  assert.equal(starterStatus(db, cfg, 'Mississippi State', starters.get('Mississippi State'), '2026-11-05T00:00:00Z')?.weight, 0); // cleared
});

test('starterStatus: game-scope facts expire after the lookback, season-ending ones do not', () => {
  const db = openDb(':memory:');
  fact(db, { team: 'Texas', player: 'Arch Manning', status: 'doubtful', as_of: '2026-10-01T12:00:00Z' });
  assert.equal(starterStatus(db, cfg, 'Texas', starters.get('Texas'), '2026-11-03T13:00:00Z'), null);
  fact(db, { team: 'Texas', player: 'Arch Manning', status: 'out', scope: 'season', as_of: '2026-10-02T12:00:00Z' });
  assert.equal(starterStatus(db, cfg, 'Texas', starters.get('Texas'), '2026-11-03T13:00:00Z')?.status, 'out');
});

test('adjustForQb moves probability against the team missing its starter, symmetrically', () => {
  const out = { team: 'A', player: 'p', status: 'out', weight: 1, as_of: '', detail: null };
  const none = adjustForQb(cfg, 0.6, null, null);
  assert.equal(none.prob, 0.6);
  const yesOut = adjustForQb(cfg, 0.5, out, null).prob;
  const oppOut = adjustForQb(cfg, 0.5, null, out).prob;
  assert.ok(Math.abs(yesOut - 0.3) < 0.01, `6 points at a coin flip ~ 30%, got ${yesOut}`);
  assert.ok(Math.abs(yesOut + oppOut - 1) < 1e-9);
  assert.equal(adjustForQb(cfg, 0.6, out, out).prob, 0.6); // both out: cancels
  assert.equal(adjustForQb(cfg, 0.02, out, null).prob, 0.02); // clamp holds
});
