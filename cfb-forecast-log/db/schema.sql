-- cfb-forecast-log schema. Applied with CREATE ... IF NOT EXISTS on every open,
-- so it is safe to run repeatedly. Never edit existing columns in place; add a
-- migration instead.

CREATE TABLE IF NOT EXISTS games (
  game_id        INTEGER PRIMARY KEY,   -- CFBD id
  season         INTEGER NOT NULL,
  week           INTEGER NOT NULL,
  kickoff_utc    TEXT NOT NULL,
  home_team      TEXT NOT NULL,
  away_team      TEXT NOT NULL,
  neutral_site   INTEGER NOT NULL DEFAULT 0,
  home_points    INTEGER,
  away_points    INTEGER,
  completed      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ratings (
  season   INTEGER NOT NULL,
  week     INTEGER NOT NULL,          -- week the rating was published for
  source   TEXT NOT NULL,             -- 'sp', 'elo', 'fpi', 'fei'
  team     TEXT NOT NULL,             -- CFBD canonical name
  rating   REAL NOT NULL,
  extra    TEXT,                      -- JSON for sub-components (ofei/dfei)
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (season, week, source, team)
);

CREATE TABLE IF NOT EXISTS markets (
  ticker      TEXT PRIMARY KEY,
  game_id     INTEGER NOT NULL REFERENCES games(game_id),
  yes_team    TEXT NOT NULL,          -- team that pays $1 on YES
  close_utc   TEXT
);

CREATE TABLE IF NOT EXISTS forecasts (
  id              INTEGER PRIMARY KEY,
  game_id         INTEGER NOT NULL REFERENCES games(game_id),
  ticker          TEXT REFERENCES markets(ticker),
  snapshot_kind   TEXT NOT NULL,      -- 'tuesday' | 'pregame' | 'manual'
  snapshot_utc    TEXT NOT NULL,
  model_version   TEXT NOT NULL,
  my_prob         REAL NOT NULL,      -- P(yes_team wins)
  yes_bid         INTEGER,            -- cents
  yes_ask         INTEGER,            -- cents
  market_mid      REAL,               -- (bid+ask)/200
  vegas_spread    REAL,               -- home-perspective closing spread
  vegas_prob      REAL,               -- spread -> P(yes_team wins)
  outcome         INTEGER,            -- 1 yes_team won, 0 lost, NULL pending
  resolved_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_forecasts_game ON forecasts(game_id, snapshot_kind);

-- Idempotency: one row per (game, market, kind, model) for scheduled kinds.
-- Manual rows are excluded from scoring and may repeat.
CREATE UNIQUE INDEX IF NOT EXISTS ux_forecasts_snapshot
  ON forecasts(game_id, ticker, snapshot_kind, model_version)
  WHERE snapshot_kind <> 'manual';

-- Hard rule 1: append-only. Rows are never deleted, and the only permitted
-- update is filling outcome/resolved_at exactly once.
CREATE TRIGGER IF NOT EXISTS trg_forecasts_no_delete
  BEFORE DELETE ON forecasts
BEGIN
  SELECT RAISE(ABORT, 'forecasts is append-only: deletes are not allowed');
END;

CREATE TRIGGER IF NOT EXISTS trg_forecasts_resolve_only
  BEFORE UPDATE ON forecasts
  WHEN OLD.outcome IS NOT NULL
    OR NEW.game_id       IS NOT OLD.game_id
    OR NEW.ticker        IS NOT OLD.ticker
    OR NEW.snapshot_kind IS NOT OLD.snapshot_kind
    OR NEW.snapshot_utc  IS NOT OLD.snapshot_utc
    OR NEW.model_version IS NOT OLD.model_version
    OR NEW.my_prob       IS NOT OLD.my_prob
    OR NEW.yes_bid       IS NOT OLD.yes_bid
    OR NEW.yes_ask       IS NOT OLD.yes_ask
    OR NEW.market_mid    IS NOT OLD.market_mid
    OR NEW.vegas_spread  IS NOT OLD.vegas_spread
    OR NEW.vegas_prob    IS NOT OLD.vegas_prob
BEGIN
  SELECT RAISE(ABORT, 'forecasts is append-only: only outcome/resolved_at may be filled, once');
END;
