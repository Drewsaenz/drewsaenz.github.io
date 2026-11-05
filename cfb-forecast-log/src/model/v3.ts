/**
 * Model v3 ("v3-anchor"): start from the Vegas line, then move toward the
 * ratings model by a fitted fraction of their disagreement.
 *
 *   m      = logit(v1) / temper           (v1 with its overconfidence divided out)
 *   logit(p3) = logit(vegas) + lambda * (m - logit(vegas))
 *
 * temper: v1's SP+, FPI and FEI slopes were fit on season-final ratings, which
 * already "know" the results they were fit on, so v1 is too extreme. The size
 * of that leak is measured on Elo, the one source available both ways: the
 * slope fit on season-final Elo divided by the slope fit on prior-week Elo.
 *
 * lambda: how much a ratings model should be trusted over the line, fit by
 * leave-one-season-out on 2021-2025 using prior-week Elo (leak-free) as the
 * ratings model. v1 is a richer model than Elo alone, so this is conservative.
 *
 * Both constants come from `npm run v3:fit`; neither is fit on 2026 rows, so
 * the 2026 rows already logged are an honest out-of-sample check.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { CONFIG_DIR } from '../paths';
import { clamp, sigmoid } from '../util/math';

export const ModelV3ConfigSchema = z.object({
  model_version: z.string().min(1),
  base_model_version: z.string().min(1),
  fitted_at: z.string().nullable(),
  temper: z.number().positive(),
  lambda: z.number().min(0).max(1),
  clamp: z.tuple([z.number(), z.number()]),
  fit_summary: z.record(z.string(), z.unknown()).optional(),
  _note: z.string().optional(),
});
export type ModelV3Config = z.infer<typeof ModelV3ConfigSchema>;

export const MODEL_V3_FILE = 'model-v3.json';

export function loadModelV3Config(): ModelV3Config {
  return ModelV3ConfigSchema.parse(JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, MODEL_V3_FILE), 'utf8')));
}

export function logit(p: number): number {
  const q = Math.min(1 - 1e-9, Math.max(1e-9, p));
  return Math.log(q / (1 - q));
}

/** v3 probability from a v1 probability and the Vegas probability (null when no line is posted). */
export function predictV3(cfg: ModelV3Config, p1: number, pVegas: number | null): number {
  const m = logit(p1) / cfg.temper;
  const z = pVegas === null ? m : logit(pVegas) + cfg.lambda * (m - logit(pVegas));
  const [lo, hi] = cfg.clamp;
  return clamp(sigmoid(z), lo, hi);
}

/**
 * Least-log-loss lambda for logit(p) = v + lambda * (m - v), by golden-section
 * search on [0, 1] (log loss is convex in lambda).
 */
export function fitLambda(samples: { v: number; m: number; y: 0 | 1 }[]): number {
  if (samples.length === 0) throw new Error('fitLambda: no samples');
  const loss = (lam: number) => {
    let ll = 0;
    for (const s of samples) {
      const p = Math.min(1 - 1e-12, Math.max(1e-12, sigmoid(s.v + lam * (s.m - s.v))));
      ll -= s.y === 1 ? Math.log(p) : Math.log(1 - p);
    }
    return ll;
  };
  let a = 0;
  let b = 1;
  const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a);
  let d = a + g * (b - a);
  for (let i = 0; i < 80; i++) {
    if (loss(c) < loss(d)) b = d;
    else a = c;
    c = b - g * (b - a);
    d = a + g * (b - a);
  }
  return (a + b) / 2;
}

export function assertV3Fitted(cfg: ModelV3Config): void {
  if (!cfg.fitted_at) throw new Error(`config/${MODEL_V3_FILE} has no fitted_at: run \`npm run v3:fit\` before recording ${cfg.model_version} forecasts`);
}
