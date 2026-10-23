/**
 * Tiny logistic regression by Newton-Raphson (IRLS) for P = sigmoid(a + b*x + c*h).
 * Three parameters, so a dense 3x3 solve is plenty.
 */
import { sigmoid } from '../util/math';

export interface FitSample {
  x: number; // rating diff (yes team minus opponent), home term already added for points-scale sources
  h: number; // +1 yes team home, -1 away, 0 neutral
  y: 0 | 1;
}

export interface FitResult {
  a: number;
  b: number;
  c: number;
  n: number;
  logLoss: number;
  iterations: number;
}

export function fitLogistic(samples: FitSample[], opts: { maxIter?: number; ridge?: number; tol?: number } = {}): FitResult {
  if (samples.length < 10) throw new Error(`fitLogistic: need at least 10 samples, got ${samples.length}`);
  const maxIter = opts.maxIter ?? 100;
  const ridge = opts.ridge ?? 1e-6;
  const tol = opts.tol ?? 1e-8;
  let w = [0, 0, 0];
  let iterations = 0;
  for (; iterations < maxIter; iterations++) {
    const g = [0, 0, 0];
    const H = [
      [ridge, 0, 0],
      [0, ridge, 0],
      [0, 0, ridge],
    ];
    for (const s of samples) {
      const f = [1, s.x, s.h];
      const p = sigmoid(w[0] * f[0] + w[1] * f[1] + w[2] * f[2]);
      const r = p - s.y;
      const wgt = p * (1 - p);
      for (let i = 0; i < 3; i++) {
        g[i] += r * f[i] + ridge * w[i];
        for (let j = 0; j < 3; j++) H[i][j] += wgt * f[i] * f[j];
      }
    }
    const step = solve3(H, g);
    w = [w[0] - step[0], w[1] - step[1], w[2] - step[2]];
    if (Math.max(...step.map(Math.abs)) < tol) break;
  }
  let ll = 0;
  for (const s of samples) {
    const p = Math.min(1 - 1e-12, Math.max(1e-12, sigmoid(w[0] + w[1] * s.x + w[2] * s.h)));
    ll -= s.y === 1 ? Math.log(p) : Math.log(1 - p);
  }
  return { a: w[0], b: w[1], c: w[2], n: samples.length, logLoss: ll / samples.length, iterations };
}

function solve3(A: number[][], b: number[]): number[] {
  // Gaussian elimination with partial pivoting on a 3x3 system.
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    if (Math.abs(M[col][col]) < 1e-14) throw new Error('fitLogistic: singular Hessian (degenerate inputs)');
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c < 4; c++) M[r][c] -= f * M[col][c];
    }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}
