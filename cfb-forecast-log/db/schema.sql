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
  snapshot_kind   TEXT NOT NULL,      -- 'tuesday' | 'report' | 'pregame' | 'manual'
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

-- Forecasts that can never be graded fairly: the game was cancelled, moved to
-- another week, or dropped by CFBD, or a pregame row was taken for a kickoff
-- that later moved. Kept apart from forecasts so that table stays append-only.
-- Voided rows are excluded from grading and scoring. Voids are permanent.
CREATE TABLE IF NOT EXISTS forecast_voids (
  forecast_id INTEGER PRIMARY KEY REFERENCES forecasts(id),
  reason      TEXT NOT NULL,
  voided_at   TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS trg_voids_append_only_del
  BEFORE DELETE ON forecast_voids
BEGIN
  SELECT RAISE(ABORT, 'forecast_voids is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_voids_append_only_upd
  BEFORE UPDATE ON forecast_voids
BEGIN
  SELECT RAISE(ABORT, 'forecast_voids is append-only');
END;

-- News facts extracted from podcast / video transcripts (data/transcripts).
-- Facts, not opinions: who is out/doubtful/probable, as stated on a show.
CREATE TABLE IF NOT EXISTS news_facts (
  id            INTEGER PRIMARY KEY,
  source_url    TEXT NOT NULL,
  source_channel TEXT,
  source_title  TEXT,
  as_of         TEXT NOT NULL,        -- video publish date if the scraper recorded one, else the scrape time
  team_raw      TEXT NOT NULL,        -- team name as spoken
  team          TEXT,                 -- CFBD canonical name when resolvable
  player        TEXT,                 -- official roster name when it resolves (src/players.ts), else as spoken
  player_raw    TEXT,                 -- name as spoken / extracted, before roster resolution
  position      TEXT,                 -- QB, RB, WR, OL, DL, LB, DB, K, P, coach, or NULL
  status        TEXT NOT NULL,        -- out | doubtful | questionable | probable | available | returning | limited | unknown
  scope         TEXT,                 -- game | weeks | season | unknown
  game_ref      TEXT,                 -- upcoming | previous | season | unknown: which game the statement is about (NULL before 2026-11-09)
  detail        TEXT,                 -- short paraphrase or quote
  confidence    REAL,
  timestamp_sec INTEGER,
  extracted_at  TEXT NOT NULL,
  model         TEXT NOT NULL,
  UNIQUE (source_url, team_raw, player, status)
);
CREATE INDEX IF NOT EXISTS idx_news_facts_team ON news_facts(team, as_of);

-- One row per processed transcript so re-runs skip files already extracted.
CREATE TABLE IF NOT EXISTS news_runs (
  source_url    TEXT PRIMARY KEY,
  file          TEXT NOT NULL,
  sha1          TEXT NOT NULL,
  windows       INTEGER NOT NULL,
  facts         INTEGER NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  processed_at  TEXT NOT NULL,
  model         TEXT NOT NULL
);

-- Each team's starting QB (season pass-attempt leader with >= 40% of attempts), refreshed by every
-- snapshot run and by `npm run starters`. Read by qbFlags so the board flags the starter only.
CREATE TABLE IF NOT EXISTS qb_starters (
  season      INTEGER NOT NULL,
  team        TEXT NOT NULL,
  player      TEXT NOT NULL,
  attempts    INTEGER NOT NULL,
  share       REAL NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (season, team)
);
