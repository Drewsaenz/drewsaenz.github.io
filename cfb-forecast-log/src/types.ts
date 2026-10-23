export type Source = 'sp' | 'elo' | 'fpi' | 'fei';
export const SOURCES: Source[] = ['sp', 'elo', 'fpi', 'fei'];

export type SnapshotKind = 'tuesday' | 'pregame' | 'manual';
export const SNAPSHOT_KINDS: SnapshotKind[] = ['tuesday', 'pregame', 'manual'];

export interface GameRow {
  game_id: number;
  season: number;
  week: number;
  kickoff_utc: string;
  home_team: string;
  away_team: string;
  neutral_site: 0 | 1;
  home_points: number | null;
  away_points: number | null;
  completed: 0 | 1;
}

export interface MarketRow {
  ticker: string;
  game_id: number;
  yes_team: string;
  close_utc: string | null;
}

export interface ForecastInsert {
  game_id: number;
  ticker: string;
  snapshot_kind: SnapshotKind;
  snapshot_utc: string;
  model_version: string;
  my_prob: number;
  yes_bid: number | null;
  yes_ask: number | null;
  market_mid: number | null;
  vegas_spread: number | null;
  vegas_prob: number | null;
}

export interface ForecastRow extends ForecastInsert {
  id: number;
  outcome: 0 | 1 | null;
  resolved_at: string | null;
}
