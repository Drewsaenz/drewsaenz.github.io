import type { ModelConfig } from '../config';
import { SOURCES, type Source } from '../types';
import { clamp, mean, sigmoid, spreadToHomeProb } from '../util/math';

export interface PredictInput {
  yes_team: string;
  opponent: string;
  /** +1 if yes_team is home, -1 if away, 0 if neutral site. */
  home: -1 | 0 | 1;
  /** source -> team -> rating, as loaded from the ratings table for the week. */
  ratings: Map<string, Map<string, number>>;
}

export interface Prediction {
  prob: number;
  per_source: Partial<Record<Source, number>>;
  sources_used: Source[];
}

/** Home indicator for the yes team given the game's home/away/neutral layout. */
export function homeIndicator(yesTeam: string, homeTeam: string, neutral: boolean): -1 | 0 | 1 {
  if (neutral) return 0;
  return yesTeam === homeTeam ? 1 : -1;
}

/** The feature a source feeds into its logistic: diff (+ home-field points for points-scale sources). */
export function sourceFeature(cfg: ModelConfig, source: Source, diff: number, home: -1 | 0 | 1): number {
  const s = cfg.sources[source];
  return s.points_scale ? diff + cfg.constants.home_field_points * home : diff;
}

export function sourceProb(cfg: ModelConfig, source: Source, diff: number, home: -1 | 0 | 1): number {
  const s = cfg.sources[source];
  return sigmoid(s.a + s.b * sourceFeature(cfg, source, diff, home) + s.c * home);
}

/**
 * Model v1 ("v1-blend"): simple mean of per-source logistic probabilities over
 * whichever sources have both teams rated this week; clamped. Returns null
 * (caller skips the game with a warning) when fewer than min_sources apply.
 */
export function predictV1(cfg: ModelConfig, input: PredictInput): Prediction | null {
  const per_source: Partial<Record<Source, number>> = {};
  const used: Source[] = [];
  for (const source of SOURCES) {
    const table = input.ratings.get(source);
    if (!table) continue;
    const a = table.get(input.yes_team);
    const b = table.get(input.opponent);
    if (a === undefined || b === undefined) continue;
    per_source[source] = sourceProb(cfg, source, a - b, input.home);
    used.push(source);
  }
  if (used.length < cfg.constants.min_sources) return null;
  const [lo, hi] = cfg.constants.clamp;
  const prob = clamp(mean(used.map((s) => per_source[s]!)), lo, hi);
  return { prob, per_source, sources_used: used };
}

/** Closing spread (home perspective) -> P(yes_team wins). */
export function vegasProb(cfg: ModelConfig, homeSpread: number, yesIsHome: boolean): number {
  const pHome = spreadToHomeProb(homeSpread, cfg.constants.vegas_std_dev);
  return yesIsHome ? pHome : 1 - pHome;
}

export function assertFitted(cfg: ModelConfig): void {
  if (!cfg.fitted_at) {
    throw new Error(`config/model-v1.json has no fitted_at: run \`npm run fit\` before recording forecasts for ${cfg.model_version}`);
  }
}
