/**
 * Model m1 ("m1-margin"): a point-spread model trained on scoring margins,
 * not a win probability turned into points.
 *
 *   ratings margin  r = mean over sources of (a_s + b_s * (rating_home - rating_away) + c_s * h) / temper
 *                       h = 1 at a home stadium, 0 neutral; one least-squares line per source,
 *                       fit on 2021-2025 final margins (`npm run m1:fit`)
 *   line margin     v = -vegas_spread (home perspective)
 *   home margin     m1 = v + lambda * (r - v) + w(h) * k * injury
 *                       no line posted: r + w(h) * k * injury
 *
 * temper: SP+, FPI and FEI are season-final ratings in the historical fit, so
 * they "know" the results and their slopes are too steep. As in v3, the leak is
 * measured on Elo, the one source available both ways (slope on season-final
 * Elo / slope on prior-week Elo), and divided out of the whole ratings margin.
 *
 * lambda: how far to move from the line toward the ratings, least squares on
 * (actual - line) vs (ratings - line), with leak-free prior-week Elo standing in
 * for the ratings, out of fold by season. Conservative, like v3's.
 *
 * injury: v5.1's fresh-news injury points (opponent lost minus home lost), in
 * points already, so k = 1 is the natural prior; it fades to 0 at kickoff with
 * v5.1's fade because the line absorbs the news during the week. k is a prior,
 * not a fit, until there is history to fit it on.
 *
 * Writes nothing itself. Rows go to `spread_forecasts` (append-only), one per
 * game per snapshot. Any change after rows exist is a new model_version.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { CONFIG_DIR } from '../paths';
import { clamp } from '../util/math';

export const MODEL_M1_FILE = 'model-m1.json';
export const M1_SOURCES = ['sp', 'fpi', 'fei', 'elo'] as const;
export type M1Source = (typeof M1_SOURCES)[number];

const Line = z.object({ a: z.number(), b: z.number(), c: z.number(), n: z.number().int().nonnegative() });

export const ModelM1ConfigSchema = z.object({
  model_version: z.string().min(1),
  injury_model_version: z.string().min(1),
  fitted_at: z.string().nullable(),
  sources: z.record(z.enum(M1_SOURCES), Line).nullable(),
  temper: z.number().positive().nullable(),
  lambda: z.number().min(0).max(1).nullable(),
  injury_scale: z.number().min(0),
  fade: z.object({ full_hours: z.number(), zero_hours: z.number() }),
  min_sources: z.number().int().positive(),
  /** |m1 - line| in points at or above which the report counts an against-the-spread pick. */
  ats_min_gap: z.number().positive(),
  fit_summary: z.record(z.string(), z.unknown()).optional(),
  _note: z.string().optional(),
});
export type ModelM1Config = z.infer<typeof ModelM1ConfigSchema>;
export type FittedM1 = ModelM1Config & { sources: NonNullable<ModelM1Config['sources']>; temper: number; lambda: number; fitted_at: string };

export function loadModelM1Config(file = MODEL_M1_FILE): ModelM1Config {
  return ModelM1ConfigSchema.parse(JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, file), 'utf8')));
}

export function isM1Fitted(cfg: ModelM1Config): cfg is FittedM1 {
  return cfg.fitted_at !== null && cfg.sources !== null && cfg.temper !== null && cfg.lambda !== null;
}

/** Share of the injury term still counted `hoursToKickoff` before the game (same shape as v5's). */
export function m1InjuryWeight(cfg: ModelM1Config, hoursToKickoff: number): number {
  const { full_hours, zero_hours } = cfg.fade;
  if (full_hours <= zero_hours) return hoursToKickoff > zero_hours ? 1 : 0;
  return clamp((hoursToKickoff - zero_hours) / (full_hours - zero_hours), 0, 1);
}

export interface M1Input {
  home_team: string;
  away_team: string;
  neutral: boolean;
  /** source -> team -> rating */
  ratings: Map<string, Map<string, number>>;
  /** Home-perspective Vegas spread (negative = home favored), or null. */
  vegasSpread: number | null;
  /** Points the away team lost to unavailable players minus the home team's. */
  injuryPoints: number;
  hoursToKickoff: number;
}

/** Ratings-only home margin, tempered; null with fewer than min_sources sources. */
export function ratingsMargin(cfg: FittedM1, x: Pick<M1Input, 'home_team' | 'away_team' | 'neutral' | 'ratings'>): { margin: number; sources: M1Source[] } | null {
  const h = x.neutral ? 0 : 1;
  const per: number[] = [];
  const used: M1Source[] = [];
  for (const s of M1_SOURCES) {
    const line = cfg.sources[s];
    const t = x.ratings.get(s);
    const a = t?.get(x.home_team);
    const b = t?.get(x.away_team);
    if (!line || a === undefined || b === undefined) continue;
    per.push(line.a + line.b * (a - b) + line.c * h);
    used.push(s);
  }
  if (per.length < cfg.min_sources) return null;
  return { margin: per.reduce((s, v) => s + v, 0) / per.length / cfg.temper, sources: used };
}

export interface M1Prediction {
  home_margin: number;
  ratings_margin: number;
  injury_term: number;
  sources: M1Source[];
}

export function predictM1(cfg: FittedM1, x: M1Input): M1Prediction | null {
  const r = ratingsMargin(cfg, x);
  if (!r) return null;
  const injury_term = m1InjuryWeight(cfg, x.hoursToKickoff) * cfg.injury_scale * x.injuryPoints;
  const base = x.vegasSpread === null ? r.margin : -x.vegasSpread + cfg.lambda * (r.margin - -x.vegasSpread);
  return { home_margin: base + injury_term, ratings_margin: r.margin, injury_term, sources: r.sources };
}

// ------------------------------------------------------------ fitting helpers

/** Least squares y = a + b*x + c*h (normal equations, 3x3). */
export function fitLine(samples: { x: number; h: number; y: number }[]): { a: number; b: number; c: number; n: number; rmse: number } {
  const n = samples.length;
  if (n < 10) throw new Error(`fitLine: only ${n} samples`);
  // X'X and X'y for columns [1, x, h]
  const S = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const t = [0, 0, 0];
  for (const s of samples) {
    const row = [1, s.x, s.h];
    for (let i = 0; i < 3; i++) {
      t[i] += row[i] * s.y;
      for (let j = 0; j < 3; j++) S[i][j] += row[i] * row[j];
    }
  }
  // If h never varies (all neutral or all home), drop it.
  const hVar = S[2][2] - (S[0][2] * S[0][2]) / n;
  const k = Math.abs(hVar) < 1e-9 ? 2 : 3;
  const coef = solve(S.slice(0, k).map((r) => r.slice(0, k)), t.slice(0, k));
  const [a, b, c = 0] = coef;
  let se = 0;
  for (const s of samples) se += (s.y - (a + b * s.x + c * s.h)) ** 2;
  return { a, b, c, n, rmse: Math.sqrt(se / n) };
}

function solve(A: number[][], y: number[]): number[] {
  const n = y.length;
  const M = A.map((r, i) => [...r, y[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) throw new Error('fitLine: singular system');
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

/** Least-squares weight on (ratings - line) for (actual - line), clipped to [0, 1]. */
export function fitMarginLambda(samples: { v: number; r: number; y: number }[]): number {
  let num = 0;
  let den = 0;
  for (const s of samples) {
    num += (s.y - s.v) * (s.r - s.v);
    den += (s.r - s.v) ** 2;
  }
  return den === 0 ? 0 : clamp(num / den, 0, 1);
}

export interface SpreadScore {
  n: number;
  mae_model: number;
  mae_line: number;
  rmse_model: number;
  rmse_line: number;
  /** Games where |model - line| >= gap, graded against the line: model side covers, loses, or pushes. */
  ats: { picks: number; won: number; lost: number; push: number; rate: number | null };
}

/** Home margins: model prediction, line margin (-spread), actual. */
export function scoreSpreads(rows: { model: number; line: number; actual: number }[], gap: number): SpreadScore {
  const n = rows.length;
  const mean = (f: (r: (typeof rows)[number]) => number) => (n === 0 ? NaN : rows.reduce((s, r) => s + f(r), 0) / n);
  const ats = { picks: 0, won: 0, lost: 0, push: 0, rate: null as number | null };
  for (const r of rows) {
    if (Math.abs(r.model - r.line) < gap) continue;
    ats.picks += 1;
    const beat = r.actual - r.line; // > 0: home covered
    if (beat === 0) ats.push += 1;
    else if (beat > 0 === r.model > r.line) ats.won += 1;
    else ats.lost += 1;
  }
  ats.rate = ats.won + ats.lost > 0 ? ats.won / (ats.won + ats.lost) : null;
  return {
    n,
    mae_model: mean((r) => Math.abs(r.actual - r.model)),
    mae_line: mean((r) => Math.abs(r.actual - r.line)),
    rmse_model: Math.sqrt(mean((r) => (r.actual - r.model) ** 2)),
    rmse_line: Math.sqrt(mean((r) => (r.actual - r.line) ** 2)),
    ats,
  };
}

/** Break-even against-the-spread rate at standard -110 pricing. */
export const ATS_BREAK_EVEN = 110 / 210;
