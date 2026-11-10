import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb, upsertGames, type Db } from '../src/db';
import { tagOfficialGameRefs } from '../src/news';
import { logit } from '../src/model/v3';
import { latestStatuses, loadModelV4Config } from '../src/model/v4';
import { brierOf, crossValidate, fitRidgeLogistic, injuryWeight, loadModelV5Config, predictV5, type ModelV5Config, type V5Sample } from '../src/model/v5';
import { sigmoid } from '../src/util/math';
import { game } from './helpers';

const base = loadModelV5Config();
const fitted: ModelV5Config = { ...base, fitted_at: '2026-11-10T00:00:00Z', coefs: { a0: 0, a: 0.8, b: 0.2, c: 0.14 } };

test('shipped config: v3/v4 priors, fitted once, injury weight held at its prior', () => {
  assert.ok(Math.abs(base.priors.a + base.priors.b - 1) < 1e-6);
  // First fit 2026-11-09 (Drew approved committing it before v5 rows exist; any refit is a new model_version).
  assert.ok(base.fitted_at && !Number.isNaN(Date.parse(base.fitted_at)));
  assert.ok(base.coefs);
  // Too few graded rows carried an injury term, so c must still equal its prior rather than a noisy fit.
  const summary = (base as { fit_summary?: { rows_with_injury_term?: number } }).fit_summary;
  if ((summary?.rows_with_injury_term ?? 0) < base.min_injury_rows) assert.equal(base.coefs!.c, base.priors.c);
  // The line carries most of the weight, the ratings a little.
  assert.ok(base.coefs!.a > 0.5 && base.coefs!.b > 0 && base.coefs!.b < base.coefs!.a);
});

test('injury term is full early in the week and gone at kickoff', () => {
  assert.equal(injuryWeight(fitted, 100), 1);
  assert.equal(injuryWeight(fitted, 72), 1);
  assert.ok(Math.abs(injuryWeight(fitted, 36) - 0.5) < 1e-9);
  assert.equal(injuryWeight(fitted, 0), 0);
});

test('predictV5 sits between the line and v1, and injuries move it only while they still count', () => {
  const x = { p1: 0.75, pVegas: 0.6, injuryPoints: 0, hoursToKickoff: 100 };
  const p = predictV5(fitted, x);
  assert.ok(p > 0.6 && p < 0.75, `expected between line and v1, got ${p}`);
  const hurtOpp = predictV5(fitted, { ...x, injuryPoints: 6 }); // opponent lost 6 points of players
  assert.ok(hurtOpp > p);
  assert.ok(Math.abs(logit(hurtOpp) - logit(p) - 0.14 * 6) < 1e-9);
  const atKick = predictV5(fitted, { ...x, injuryPoints: 6, hoursToKickoff: 0 });
  assert.ok(Math.abs(atKick - p) < 1e-9); // faded out
  // No line: tempered v1 plus the injury term.
  const noLine = predictV5(fitted, { ...x, pVegas: null });
  assert.ok(Math.abs(noLine - sigmoid(logit(0.75) / fitted.temper)) < 1e-9);
});

test('ridge fit recovers planted weights with enough data and stays at the prior with none', () => {
  // Synthetic rows: truth is sigmoid(0.9*lv + 0.3*lm + 0.1*inj).
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const truth = [0, 0.9, 0.3, 0.1];
  const samples: V5Sample[] = [];
  for (let i = 0; i < 6000; i++) {
    const lv = (rnd() - 0.5) * 4;
    const lm = lv + (rnd() - 0.5) * 2;
    const inj = rnd() < 0.3 ? (rnd() - 0.5) * 8 : 0;
    const f = [1, lv, lm, inj];
    const p = sigmoid(truth[0] + truth[1] * lv + truth[2] * lm + truth[3] * inj);
    samples.push({ f, y: rnd() < p ? 1 : 0, group: `w${i % 6}` });
  }
  const prior = [0, 0.84, 0.16, 0.14];
  const w = fitRidgeLogistic(samples, prior, 1e-6);
  // The line and the ratings are highly correlated (as in real data), so only
  // their combined weight is well identified; the intercept and injury weight are.
  assert.ok(Math.abs(w[0] - truth[0]) < 0.08, `a0 ${w[0]}`);
  assert.ok(Math.abs(w[1] + w[2] - (truth[1] + truth[2])) < 0.08, `a+b ${w[1] + w[2]}`);
  assert.ok(Math.abs(w[3] - truth[3]) < 0.03, `c ${w[3]}`);
  // A huge prior weight pins the fit to the prior.
  const pinned = fitRidgeLogistic(samples, prior, 1e9);
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(pinned[i] - prior[i]) < 1e-3);
  // A held coefficient stays exactly at its prior while the others still fit.
  const held = fitRidgeLogistic(samples, prior, 1e-6, { fixed: [3] });
  assert.equal(held[3], prior[3]);
  assert.ok(Math.abs(held[1] + held[2] - (truth[1] + truth[2])) < 0.1);
  // Cross-validation scores close to the in-sample fit on this much data.
  const cv = crossValidate(samples, prior, 40);
  assert.ok(Math.abs(cv.brier - brierOf(samples, w)) < 0.01);
  assert.equal(Object.keys(cv.folds).length, 6);
});

// ---- the recap filter (game_ref) shared by v2/v4/v4.1/v5's injury layer

function fact(db: Db, f: { team: string; player: string; status: string; as_of: string; game_ref: string | null; position?: string }) {
  db.prepare(
    `INSERT INTO news_facts (source_url, source_channel, source_title, as_of, team_raw, team, player, position, status, scope, game_ref, detail, confidence, timestamp_sec, extracted_at, model)
     VALUES (?, 'show', 't', ?, ?, ?, ?, ?, ?, 'game', ?, 'd', 0.9, 0, '2026-11-09T00:00:00Z', 'claude-haiku-5-5')`,
  ).run(`u${Math.random()}`, f.as_of, f.team, f.team, f.player, f.position ?? 'QB', f.status, f.game_ref);
}

test('official report facts are tagged without a model call', () => {
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO news_facts (source_url, as_of, team_raw, team, player, status, scope, extracted_at, model) VALUES ('r1', '2026-11-05T01:00:00Z', 'Texas', 'Texas', 'Trevor Goosby', 'out', 'season', 'x', 'availability-report'), ('r2', '2026-11-05T01:00:00Z', 'Texas', 'Texas', 'Colin Simmons', 'questionable', 'game', 'x', 'availability-report'), ('s1', '2026-11-05T01:00:00Z', 'Texas', 'Texas', 'Arch Manning', 'probable', 'game', 'x', 'claude-haiku-5-5')`).run();
  assert.equal(tagOfficialGameRefs(db), 2);
  const refs = db.prepare('SELECT player, game_ref FROM news_facts ORDER BY player').all() as { player: string; game_ref: string | null }[];
  assert.deepEqual(refs, [{ player: 'Arch Manning', game_ref: null }, { player: 'Colin Simmons', game_ref: 'upcoming' }, { player: 'Trevor Goosby', game_ref: 'season' }]);
});

test('facts tagged as recaps of a played game do not set a player\'s status; untagged older facts still do', () => {
  const v4 = loadModelV4Config();
  const db = openDb(':memory:');
  upsertGames(db, [game({ game_id: 1, season: 2026, week: 11, home_team: 'LSU', away_team: 'Texas', kickoff_utc: '2026-11-14T23:30:00Z' })]);
  fact(db, { team: 'LSU', player: 'Sam Leavitt', status: 'limited', as_of: '2026-11-08T12:00:00Z', game_ref: 'previous' }); // "played through it in the loss"
  fact(db, { team: 'Texas', player: 'Ryan Wingo', status: 'limited', as_of: '2026-11-08T12:00:00Z', game_ref: null, position: 'WR' }); // stored before the tag existed
  const at = '2026-11-10T13:00:00Z';
  assert.deepEqual(latestStatuses(db, v4, 'LSU', at), []);
  assert.equal(latestStatuses(db, v4, 'Texas', at)[0]?.player, 'Ryan Wingo');
  fact(db, { team: 'LSU', player: 'Sam Leavitt', status: 'questionable', as_of: '2026-11-09T12:00:00Z', game_ref: 'upcoming' });
  assert.equal(latestStatuses(db, v4, 'LSU', at)[0]?.status, 'questionable');
});
