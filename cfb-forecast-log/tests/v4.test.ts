import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb, type Db } from '../src/db';
import { buildImportance, coachChanges, coachRole, latestStatuses, positionGroup, predictV4, teamAdjustment, weeksMissed, type ModelV4Config, type StatRow } from '../src/model/v4';

const cfg: ModelV4Config = {
  model_version: 'v4-avail',
  base_model_version: 'v1-blend',
  created_at: '2026-11-05',
  points_to_logit: 0.14105,
  status_weights: { out: 1, doubtful: 0.75, limited: 0.5, questionable: 0.35, probable: 0.1, available: 0, returning: 0 },
  lookback_days: 8,
  min_confidence: 0.5,
  qb: { points: 6, min_starter_share: 0.4, weeks_checked: 3, fade_per_missed_week: 0.25, min_fade: 0.25 },
  rb_points: 3,
  receiver_points: 4,
  defense_points: 8,
  ol_points_each: 0.6,
  ol_cap: 2,
  non_qb_cap: 6,
  coach: { window_days: 21, head_coach_change_points: 1, coordinator_change_points: 0 },
  clamp: [0.02, 0.98],
};

const row = (team: string, player: string, position: string, statType: string, stat: number): StatRow => ({ team, player, position, statType, stat });
const importance = buildImportance(
  [row('Texas', 'Hollywood Smothers', 'RB', 'YDS', 450), row('Texas', 'Raleek Brown', 'RB', 'YDS', 550)],
  [row('Texas', 'Ryan Wingo', 'WR', 'YDS', 300), row('Texas', 'Cam Coleman', 'WR', 'YDS', 700)],
  [row('Texas', 'Colin Simmons', 'EDGE', 'TOT', 20), row('Texas', 'Colin Simmons', 'EDGE', 'SACKS', 6), row('Texas', 'Somebody Else', 'LB', 'TOT', 62)],
);

test('importance is each player’s share of his team’s production', () => {
  const tex = importance.get('Texas')!;
  assert.equal(tex.find((p) => p.name === 'Hollywood Smothers')!.rush, 0.45);
  assert.equal(tex.find((p) => p.name === 'Cam Coleman')!.rec, 0.7);
  assert.ok(Math.abs(tex.find((p) => p.name === 'Colin Simmons')!.def - 38 / 100) < 1e-9);
});

test('position codes group as expected', () => {
  assert.equal(positionGroup('EDG'), 'DEF');
  assert.equal(positionGroup('TE'), 'REC');
  assert.equal(positionGroup('IOL'), 'OL');
  assert.equal(positionGroup('LS'), 'OTHER');
});

test('weeks missed counts straight recent weeks without the starter, skipping byes', () => {
  const wk = (att: [string, number][]) => att.map(([p, n]) => row('UCLA', p, 'QB', 'ATT', n));
  const weeks = [wk([['Ty Dieffenbach', 30]]), [], wk([['Ty Dieffenbach', 28]]), wk([['Nico Iamaleava', 31]])];
  assert.equal(weeksMissed(weeks, 'UCLA', 'Nico Iamaleava'), 2);
  assert.equal(weeksMissed(weeks, 'UCLA', 'Ty Dieffenbach'), 0);
});

const st = (player: string, position: string, status: string, weight: number) => ({ player, position, status, weight, as_of: 'x', source: null, detail: null });

test('team adjustment weights each player by status and importance, and fades a long-out QB', () => {
  const starter = { team: 'Texas', player: 'Arch Manning', attempts: 300, share: 0.9 };
  const a = teamAdjustment(cfg, 'Texas', [st('Hollywood Smothers', 'RB', 'out', 1), st('Colin Simmons', 'EDGE', 'questionable', 0.35), st('Arch Manning', 'QB', 'out', 1), st('Backup Guy', 'QB', 'out', 1)], importance, starter, 2, []);
  const pts = Object.fromEntries(a.items.map((i) => [i.player, Number(i.points.toFixed(3))]));
  assert.equal(pts['Hollywood Smothers'], 1.35);
  assert.equal(pts['Colin Simmons'], Number((8 * 0.38 * 0.35).toFixed(3)));
  assert.equal(pts['Arch Manning'], 3); // 6 pts, half after two missed weeks
  assert.equal(pts['Backup Guy'], undefined);
});

test('offensive line is capped, and so is the non-QB total', () => {
  const ol = Array.from({ length: 6 }, (_, i) => st(`Lineman ${i}`, 'OL', 'out', 1));
  assert.equal(teamAdjustment(cfg, 'Texas', ol, importance, undefined, 0, []).points, 2);
});

test('a head coach change costs head_coach_change_points; a coordinator change is free by default', () => {
  const ev = (role: 'head' | 'coordinator') => [{ name: 'X', role, detail: '', as_of: 'x' }];
  assert.equal(teamAdjustment(cfg, 'FSU', [], importance, undefined, 0, ev('head')).points, 1);
  assert.equal(teamAdjustment(cfg, 'OU', [], importance, undefined, 0, ev('coordinator')).points, 0);
  assert.equal(coachRole('Offensive coordinator Ben Arbuckle was fired'), 'coordinator');
  assert.equal(coachRole('Interim head coach Rick Stockstill will coach Saturday'), 'head');
});

test('v4 moves probability toward the healthier team', () => {
  const none = teamAdjustment(cfg, 'A', [], importance, undefined, 0, []);
  const hurt = { ...none, points: 6 };
  const p = predictV4(cfg, 0.6, hurt, none);
  assert.ok(p < 0.45 && p > 0.35, `got ${p}`);
  assert.ok(Math.abs(predictV4(cfg, 0.6, none, none) - 0.6) < 1e-9);
});

function fact(db: Db, f: Record<string, unknown>) {
  db.prepare(
    `INSERT INTO news_facts (source_url, source_channel, source_title, as_of, team_raw, team, player, position, status, scope, detail, confidence, timestamp_sec, extracted_at, model)
     VALUES (@source_url, 'ch', 't', @as_of, @team, @team, @player, @position, @status, @scope, @detail, @confidence, 0, 'x', 'm')`,
  ).run({ source_url: `u${Math.random()}`, scope: 'game', detail: '', confidence: 1, ...f });
}

test('latest fact per player wins; old, low-confidence and future facts are ignored', () => {
  const db = openDb(':memory:');
  fact(db, { team: 'Texas', player: 'Cam Coleman', position: 'WR', status: 'out', as_of: '2026-11-03T00:00:00Z' });
  fact(db, { team: 'Texas', player: 'Cam Coleman', position: 'WR', status: 'questionable', as_of: '2026-11-05T01:00:00Z' });
  fact(db, { team: 'Texas', player: 'Cade Phillips', position: 'DB', status: 'out', as_of: '2026-10-01T00:00:00Z' }); // too old
  fact(db, { team: 'Texas', player: 'Ryan Wingo', position: 'WR', status: 'out', as_of: '2026-11-04T00:00:00Z', confidence: 0.2 });
  fact(db, { team: 'Texas', player: 'Trevor Goosby', position: 'OL', status: 'out', as_of: '2026-10-20T00:00:00Z', scope: 'season' });
  fact(db, { team: 'Texas', player: 'Future Fact', position: 'RB', status: 'out', as_of: '2026-11-09T00:00:00Z' });
  const s = latestStatuses(db, cfg, 'Texas', '2026-11-06T00:00:00Z');
  assert.deepEqual(s.map((x) => `${x.player}:${x.status}`).sort(), ['Cam Coleman:questionable', 'Trevor Goosby:out']);
});

test('coaching changes are found in the window from the fact wording', () => {
  const db = openDb(':memory:');
  fact(db, { team: 'Oklahoma', player: 'Ben Arbuckle', position: 'coach', status: 'out', scope: 'season', as_of: '2026-11-03T00:00:00Z', detail: 'Offensive coordinator Ben Arbuckle was fired.' });
  fact(db, { team: 'Texas', player: 'Steve Sarkisian', position: 'coach', status: 'unknown', as_of: '2026-11-03T00:00:00Z', detail: 'Coach Steve Sarkisian said his team will be undermanned.' });
  assert.deepEqual(coachChanges(db, cfg, 'Oklahoma', '2026-11-06T00:00:00Z').map((c) => c.role), ['coordinator']);
  assert.deepEqual(coachChanges(db, cfg, 'Texas', '2026-11-06T00:00:00Z'), []);
});
