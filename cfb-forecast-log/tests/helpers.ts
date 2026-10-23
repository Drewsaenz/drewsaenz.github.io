import type { ModelConfig } from '../src/config';
import type { GameRow } from '../src/types';

export const fittedConfig: ModelConfig = {
  model_version: 'v1-blend',
  fitted_at: '2026-01-01T00:00:00Z',
  fit_seasons: [2021],
  constants: { home_field_points: 2.5, vegas_std_dev: 13.5, clamp: [0.02, 0.98], min_sources: 2 },
  sources: {
    sp: { points_scale: true, a: 0, b: 0.126, c: 0, n: 1 },
    fpi: { points_scale: true, a: 0, b: 0.126, c: 0, n: 1 },
    fei: { points_scale: true, a: 0, b: 0.126, c: 0, n: 1 },
    elo: { points_scale: false, a: 0, b: 0.00576, c: 0.3, n: 1 },
  },
};

export function game(partial: Partial<GameRow> & { game_id: number }): GameRow {
  return {
    season: 2025,
    week: 9,
    kickoff_utc: '2025-10-25T19:30:00.000Z',
    home_team: 'Oklahoma',
    away_team: 'Texas',
    neutral_site: 0,
    home_points: null,
    away_points: null,
    completed: 0,
    ...partial,
  };
}
