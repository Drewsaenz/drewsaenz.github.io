import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalQuantile, probToMargin, spPoints, splitScore } from '../src/projection';
import { normalCdf } from '../src/util/math';

test('normalQuantile inverts normalCdf', () => {
  for (const p of [0.05, 0.3, 0.5, 0.646, 0.9]) assert.ok(Math.abs(normalCdf(normalQuantile(p)) - p) < 1e-6);
  assert.ok(Math.abs(normalQuantile(0.5)) < 1e-6);
});

test('probToMargin: 50% is a pick-em, a favorite gets points, symmetric', () => {
  assert.ok(Math.abs(probToMargin(0.5, 13.5)) < 1e-6);
  const m = probToMargin(0.646, 13.5);
  assert.ok(m > 4.9 && m < 5.1, `got ${m}`);
  assert.ok(Math.abs(probToMargin(0.354, 13.5) + m) < 1e-6);
});

test('SP+ points and the score split', () => {
  // Texas 34.6 off vs a 20.0 defense, national average 26.5 -> 28.1.
  assert.ok(Math.abs(spPoints(34.6, 20, 26.5) - 28.1) < 1e-9);
  assert.deepEqual(splitScore(50, 6), { team: 28, opp: 22 });
});
