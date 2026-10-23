import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalCdf, sigmoid, spreadToHomeProb, clamp } from '../src/util/math';

test('sigmoid and normalCdf basics', () => {
  assert.equal(sigmoid(0), 0.5);
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-9);
  assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 1e-3);
  assert.ok(Math.abs(normalCdf(-1.96) - 0.025) < 1e-3);
});

test('spreadToHomeProb: negative spread favors home', () => {
  assert.ok(spreadToHomeProb(-7, 13.5) > 0.5);
  assert.ok(spreadToHomeProb(7, 13.5) < 0.5);
  assert.ok(Math.abs(spreadToHomeProb(0, 13.5) - 0.5) < 1e-9);
  assert.ok(Math.abs(spreadToHomeProb(-7, 13.5) + spreadToHomeProb(7, 13.5) - 1) < 1e-9);
});

test('clamp', () => {
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(clamp(-1, 0, 1), 0);
  assert.equal(clamp(0.3, 0, 1), 0.3);
});
