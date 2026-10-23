import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { CONFIG_DIR } from './paths';

const SourceCoef = z.object({
  points_scale: z.boolean(),
  a: z.number(),
  b: z.number(),
  c: z.number(),
  n: z.number().int().nonnegative(),
});

export const ModelConfigSchema = z.object({
  model_version: z.string().min(1),
  fitted_at: z.string().nullable(),
  fit_seasons: z.array(z.number().int()),
  constants: z.object({
    home_field_points: z.number(),
    vegas_std_dev: z.number().positive(),
    clamp: z.tuple([z.number(), z.number()]),
    min_sources: z.number().int().min(1),
  }),
  sources: z.object({
    sp: SourceCoef,
    fpi: SourceCoef,
    fei: SourceCoef,
    elo: SourceCoef,
  }),
  _note: z.string().optional(),
  fit_summary: z.record(z.string(), z.unknown()).optional(),
});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export const ScoringConfigSchema = z.object({
  edge_min: z.number().min(0).max(1),
  taker_fee_rate: z.number().min(0),
  calibration_bins: z.number().int().min(2),
});
export type ScoringConfig = z.infer<typeof ScoringConfigSchema>;

export const KalshiConfigSchema = z.object({
  base_url: z.string().url(),
  series_ticker: z.string().min(1),
  series_confirmed: z.boolean(),
  series_title_pattern: z.string(),
  page_size: z.number().int().min(1).max(1000),
});
export type KalshiConfig = z.infer<typeof KalshiConfigSchema>;

export const FeiConfigSchema = z.object({
  season_url: z.string().url(),
  robots_url: z.string().url(),
  request_delay_ms: z.number().int().nonnegative(),
  _note: z.string().optional(),
});
export type FeiConfig = z.infer<typeof FeiConfigSchema>;

export const CfbdConfigSchema = z.object({
  base_url: z.string().url(),
  season_type: z.string(),
  use_fpi: z.boolean().default(true),
  line_provider_priority: z.array(z.string()),
  cache_ttl_hours: z.object({
    games: z.number(),
    lines: z.number(),
    ratings: z.number(),
    historical: z.number(),
  }),
});
export type CfbdConfig = z.infer<typeof CfbdConfigSchema>;

export const AliasesSchema = z.object({
  _note: z.string().optional(),
  fei: z.record(z.string(), z.string()),
  kalshi: z.record(z.string(), z.string()),
});
export type Aliases = z.infer<typeof AliasesSchema>;

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, file), 'utf8'));
}

export function loadModelConfig(): ModelConfig {
  return ModelConfigSchema.parse(readJson('model-v1.json'));
}
export function loadScoringConfig(): ScoringConfig {
  return ScoringConfigSchema.parse(readJson('scoring.json'));
}
export function loadKalshiConfig(): KalshiConfig {
  return KalshiConfigSchema.parse(readJson('kalshi.json'));
}
export function loadFeiConfig(): FeiConfig {
  return FeiConfigSchema.parse(readJson('fei.json'));
}
export function loadCfbdConfig(): CfbdConfig {
  return CfbdConfigSchema.parse(readJson('cfbd.json'));
}
export function loadAliases(): Aliases {
  return AliasesSchema.parse(readJson('team-aliases.json'));
}

/** Writes a config file back (used only by `fit` and Kalshi series confirmation). */
export function writeConfig(file: string, value: unknown): void {
  fs.writeFileSync(path.join(CONFIG_DIR, file), JSON.stringify(value, null, 2) + '\n');
}
