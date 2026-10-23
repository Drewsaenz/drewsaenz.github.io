import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitLogistic, type FitSample } from '../src/model/logistic';
import { sigmoid } from '../src/util/math';

/** Deterministic LCG so the test is reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

test('fitLogistic recovers known coefficients on synthetic data', () => {
  const r = rng(42);
  const [a, b, c] = [0.1, 0.12, 0.3];
  const samples: FitSample[] = [];
  for (let i = 0; i < 20000; i++) {
    const x = (r() - 0.5) * 60;
    const h = ([-1, 0, 1] as const)[Math.floor(r() * 3)];
    const p = sigmoid(a + b * x + c * h);
    samples.push({ x, h, y: r() < p ? 1 : 0 });
  }
  const fit = fitLogistic(samples);
  assert.ok(Math.abs(fit.a - a) < 0.08, `a=${fit.a}`);
  assert.ok(Math.abs(fit.b - b) < 0.01, `b=${fit.b}`);
  assert.ok(Math.abs(fit.c - c) < 0.12, `c=${fit.c}`);
  assert.equal(fit.n, 20000);
});

test('fitLogistic rejects tiny samples', () => {
  assert.throws(() => fitLogistic([{ x: 1, h: 0, y: 1 }]), /at least 10/);
});
