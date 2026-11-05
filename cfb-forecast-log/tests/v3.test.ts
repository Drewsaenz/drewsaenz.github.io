import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitLambda, logit, predictV3, type ModelV3Config } from '../src/model/v3';
import { sigmoid } from '../src/util/math';

const cfg: ModelV3Config = { model_version: 'v3-anchor', base_model_version: 'v1-blend', fitted_at: 'x', temper: 1.25, lambda: 0.2, clamp: [0.02, 0.98] };

test('v3 with lambda 0 returns the line', () => {
  assert.ok(Math.abs(predictV3({ ...cfg, lambda: 0 }, 0.9, 0.6) - 0.6) < 1e-9);
});

test('v3 with lambda 1 and temper 1 returns v1', () => {
  assert.ok(Math.abs(predictV3({ ...cfg, lambda: 1, temper: 1 }, 0.9, 0.6) - 0.9) < 1e-9);
});

test('v3 sits between the line and v1, closer to the line', () => {
  const p = predictV3(cfg, 0.85, 0.6);
  assert.ok(p > 0.6 && p < 0.7, `got ${p}`);
});

test('v3 without a line falls back to tempered v1, pulled toward 50%', () => {
  const p = predictV3(cfg, 0.9, null);
  assert.ok(Math.abs(p - sigmoid(logit(0.9) / 1.25)) < 1e-9);
  assert.ok(p < 0.9 && p > 0.5);
});

test('v3 is symmetric between the two sides of a game', () => {
  assert.ok(Math.abs(predictV3(cfg, 0.7, 0.55) + predictV3(cfg, 0.3, 0.45) - 1) < 1e-9);
});

test('fitLambda recovers the weight that generated the data', () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const samples: { v: number; m: number; y: 0 | 1 }[] = [];
  for (let i = 0; i < 20000; i++) {
    const v = (rand() - 0.5) * 4;
    const m = v + (rand() - 0.5) * 3;
    const p = sigmoid(v + 0.3 * (m - v));
    samples.push({ v, m, y: rand() < p ? 1 : 0 });
  }
  const lam = fitLambda(samples);
  assert.ok(Math.abs(lam - 0.3) < 0.06, `got ${lam}`);
});
