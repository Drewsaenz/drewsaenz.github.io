/**
 * Model v5 ("v5-fused"): the Vegas line, the ratings model and the injury
 * layer combined with weights fit on this project's own logged rows.
 *
 *   z = a0 + a * logit(vegas) + b * logit(v1) / temper + w(h) * c * injury
 *   p5 = sigmoid(z), clamped
 *
 *   vegas   closing-line probability at the snapshot (v3's anchor)
 *   v1      v1-blend probability; temper divides out v1's fit leak (from v3)
 *   injury  points of spread the opponent has lost to unavailable players
 *           minus the points the yes team has lost (v4.1's source-layered
 *           adjustment, so official reports come first and other news needs
 *           two outlets)
 *   w(h)    how much of the injury term still counts h hours before kickoff:
 *           1 at or beyond fade.full_hours, falling linearly to 0 at
 *           fade.zero_hours. Early in the week the line has not priced the
 *           news yet; by kickoff it has, so the term fades out instead of
 *           double counting (the pattern that cost v2 and v4 at kickoff).
 *   no line posted: z = logit(v1) / temper + w(h) * c * injury
 *
 * The weights a0, a, b, c come from `npm run v5:fit`: a ridge logistic
 * regression on the logged v1 rows (Tuesday and pregame, graded, with a line),
 * pulled toward the priors in config (v3's anchor weights and v4's injury
 * scale) with strength prior_weight, scored leave-one-week-out. With a few
 * hundred rows the prior matters; the fit reports how far the data moved it.
 * Fitting is refused once v5 rows exist: any later refit is a new version.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { CONFIG_DIR } from '../paths';
import { clamp, sigmoid } from '../util/math';
import { logit } from './v3';

export const MODEL_V5_FILE = 'model-v5.json';

const Coefs = z.object({ a0: z.number(), a: z.number(), b: z.number(), c: z.number() });

export const ModelV5ConfigSchema = z.object({
  model_version: z.string().min(1),
  base_model_version: z.string().min(1),
  injury_model_version: z.string().min(1),
  fitted_at: z.string().nullable(),
  temper: z.number().positive(),
  coefs: Coefs.nullable(),
  priors: Coefs,
  prior_weight: z.number().nonnegative(),
  /** Below this many rows with a non-zero injury term, c stays at its prior (too few rows to learn it). */
  min_injury_rows: z.number().int().nonnegative().default(100),
  fade: z.object({ full_hours: z.number().positive(), zero_hours: z.number().nonnegative() }),
  clamp: z.tuple([z.number(), z.number()]),
  fit_summary: z.record(z.string(), z.unknown()).optional(),
  _note: z.string().optional(),
});
export type ModelV5Config = z.infer<typeof ModelV5ConfigSchema>;

export function loadModelV5Config(file = MODEL_V5_FILE): ModelV5Config {
  return ModelV5ConfigSchema.parse(JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, file), 'utf8')));
}

export function assertV5Fitted(cfg: ModelV5Config): void {
  if (!cfg.fitted_at || !cfg.coefs) throw new Error(`config/${MODEL_V5_FILE} has no fit: run \`npm run v5:fit\` before recording ${cfg.model_version} forecasts`);
}

/** Share of the injury term that still counts `hoursToKickoff` before the game. */
export function injuryWeight(cfg: ModelV5Config, hoursToKickoff: number): number {
  const { full_hours, zero_hours } = cfg.fade;
  if (full_hours <= zero_hours) return hoursToKickoff > zero_hours ? 1 : 0;
  return clamp((hoursToKickoff - zero_hours) / (full_hours - zero_hours), 0, 1);
}

export interface V5Input {
  p1: number;
  pVegas: number | null;
  /** Points of spread the opponent lost to injuries minus the yes team's. */
  injuryPoints: number;
  hoursToKickoff: number;
}

/** Feature vector for the fit and for prediction: [1, logit(vegas), logit(v1)/temper, w*injury]. Null when no line is posted. */
export function v5Features(cfg: ModelV5Config, x: V5Input): number[] | null {
  if (x.pVegas === null) return null;
  return [1, logit(x.pVegas), logit(x.p1) / cfg.temper, injuryWeight(cfg, x.hoursToKickoff) * x.injuryPoints];
}

export function predictV5(cfg: ModelV5Config, x: V5Input): number {
  const k = cfg.coefs ?? cfg.priors;
  const f = v5Features(cfg, x);
  const zz = f ? k.a0 + k.a * f[1] + k.b * f[2] + k.c * f[3] : logit(x.p1) / cfg.temper + injuryWeight(cfg, x.hoursToKickoff) * k.c * x.injuryPoints;
  const [lo, hi] = cfg.clamp;
  return clamp(sigmoid(zz), lo, hi);
}

// ------------------------------------------------------------ fitting

export interface V5Sample {
  f: number[];
  y: 0 | 1;
  /** Fold key for leave-one-group-out, e.g. "2026-10". */
  group: string;
}

/**
 * Ridge logistic regression toward a prior mean: minimises
 *   sum log loss + (priorWeight / 2) * sum_i (w_i - prior_i)^2
 * by Newton's method. Any number of features; the first is the intercept.
 */
export function fitRidgeLogistic(samples: { f: number[]; y: 0 | 1 }[], prior: number[], priorWeight: number, opts: { fixed?: number[]; maxIter?: number } = {}): number[] {
  const maxIter = opts.maxIter ?? 100;
  const fixed = new Set(opts.fixed ?? []);
  if (samples.length < 20) throw new Error(`fitRidgeLogistic: need at least 20 samples, got ${samples.length}`);
  const n = prior.length;
  let w = [...prior];
  for (let it = 0; it < maxIter; it++) {
    const g = new Array(n).fill(0);
    const H = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? priorWeight : 0)));
    for (let i = 0; i < n; i++) g[i] += priorWeight * (w[i] - prior[i]);
    for (const s of samples) {
      const p = sigmoid(dot(w, s.f));
      const r = p - s.y;
      const wgt = p * (1 - p);
      for (let i = 0; i < n; i++) {
        g[i] += r * s.f[i];
        for (let j = 0; j < n; j++) H[i][j] += wgt * s.f[i] * s.f[j];
      }
    }
    for (const i of fixed) {
      g[i] = 0;
      for (let j = 0; j < n; j++) H[i][j] = H[j][i] = i === j ? 1 : 0;
    }
    const step = solve(H, g);
    w = w.map((v, i) => v - step[i]);
    if (Math.max(...step.map(Math.abs)) < 1e-9) break;
  }
  return w;
}

export function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    if (Math.abs(M[col][col]) < 1e-14) throw new Error('fitRidgeLogistic: singular system (degenerate inputs)');
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export function brierOf(samples: { f: number[]; y: 0 | 1 }[], w: number[]): number {
  let b = 0;
  for (const s of samples) b += (sigmoid(dot(w, s.f)) - s.y) ** 2;
  return b / samples.length;
}

/** Leave-one-group-out: fit on every other group, score the held-out one; returns the pooled Brier. */
export function crossValidate(samples: V5Sample[], prior: number[], priorWeight: number, fixed: number[] = []): { brier: number; folds: Record<string, { n: number; brier: number }> } {
  const groups = [...new Set(samples.map((s) => s.group))];
  const folds: Record<string, { n: number; brier: number }> = {};
  let total = 0;
  for (const g of groups) {
    const train = samples.filter((s) => s.group !== g);
    const test = samples.filter((s) => s.group === g);
    if (train.length < 20 || test.length === 0) continue;
    const w = fitRidgeLogistic(train, prior, priorWeight, { fixed });
    const b = brierOf(test, w);
    folds[g] = { n: test.length, brier: b };
    total += b * test.length;
  }
  const n = Object.values(folds).reduce((a, f) => a + f.n, 0);
  return { brier: n ? total / n : NaN, folds };
}
