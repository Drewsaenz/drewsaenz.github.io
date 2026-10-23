import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertFitted, homeIndicator, predictV1, vegasProb } from '../src/model/v1';
import { fittedConfig } from './helpers';

function ratings(sources: Record<string, Record<string, number>>) {
  return new Map(Object.entries(sources).map(([s, t]) => [s, new Map(Object.entries(t))]));
}

test('predictV1 averages available sources and favours the stronger team', () => {
  const r = ratings({ sp: { A: 20, B: 0 }, elo: { A: 1800, B: 1500 }, fei: { A: 10, B: -10 } });
  const p = predictV1(fittedConfig, { yes_team: 'A', opponent: 'B', home: 0, ratings: r })!;
  assert.ok(p.prob > 0.8 && p.prob <= 0.98, `prob ${p.prob}`);
  assert.deepEqual(p.sources_used, ['sp', 'elo', 'fei']);
  const q = predictV1(fittedConfig, { yes_team: 'B', opponent: 'A', home: 0, ratings: r })!;
  assert.ok(Math.abs(p.prob + q.prob - 1) < 1e-9, 'symmetric');
});

test('predictV1 returns null below min_sources', () => {
  const r = ratings({ sp: { A: 20, B: 0 }, elo: { A: 1800 } });
  assert.equal(predictV1(fittedConfig, { yes_team: 'A', opponent: 'B', home: 1, ratings: r }), null);
});

test('predictV1 clamps extreme probabilities', () => {
  const r = ratings({ sp: { A: 200, B: 0 }, fpi: { A: 200, B: 0 } });
  assert.equal(predictV1(fittedConfig, { yes_team: 'A', opponent: 'B', home: 1, ratings: r })!.prob, 0.98);
});

test('home field increases the home side probability for points-scale sources', () => {
  const r = ratings({ sp: { A: 0, B: 0 }, fpi: { A: 0, B: 0 } });
  const home = predictV1(fittedConfig, { yes_team: 'A', opponent: 'B', home: 1, ratings: r })!.prob;
  const neutral = predictV1(fittedConfig, { yes_team: 'A', opponent: 'B', home: 0, ratings: r })!.prob;
  const away = predictV1(fittedConfig, { yes_team: 'A', opponent: 'B', home: -1, ratings: r })!.prob;
  assert.ok(home > neutral && neutral > away);
  assert.ok(Math.abs(neutral - 0.5) < 1e-9);
});

test('homeIndicator', () => {
  assert.equal(homeIndicator('A', 'A', false), 1);
  assert.equal(homeIndicator('B', 'A', false), -1);
  assert.equal(homeIndicator('A', 'A', true), 0);
});

test('vegasProb respects yes-team side', () => {
  const pHome = vegasProb(fittedConfig, -7, true);
  const pAway = vegasProb(fittedConfig, -7, false);
  assert.ok(pHome > 0.5);
  assert.ok(Math.abs(pHome + pAway - 1) < 1e-9);
});

test('assertFitted refuses unfitted config', () => {
  assert.throws(() => assertFitted({ ...fittedConfig, fitted_at: null }), /npm run fit/);
  assert.doesNotThrow(() => assertFitted(fittedConfig));
});
