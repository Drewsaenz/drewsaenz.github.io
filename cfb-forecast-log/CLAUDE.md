# cfb-forecast-log — CLAUDE.md

## Purpose

A small, boring worker that logs my own win-probability forecasts for college
football games next to the Kalshi market price and the Vegas closing line, then
scores them after games resolve. The point is to find out, cheaply, whether my
model beats the market after fees **before** any money is at risk.

This is NOT a trading bot. v1 places no orders and holds no API keys with
trading permission. Do not add order placement, even behind a flag.

## Stack

- Node 20+, TypeScript, run with `tsx`
- SQLite via `better-sqlite3` (single file: `data/forecasts.db`)
- `node-cron` for scheduling, or plain shell cron calling `npm run <job>`
- `zod` for validating API responses before they touch the DB
- No framework, no ORM, no web UI in v1. Reports are printed as tables to stdout
  and written to `reports/YYYY-WW.md`.

## Hard rules

1. **Append-only log.** Rows in `forecasts` are never updated or deleted except
   to fill `outcome` and `resolved_at` once a game is final. Never backfill a
   prediction for a snapshot time that has already passed.
2. **Fixed snapshot times.** Forecasts are recorded only at the scheduled
   snapshot times (see Jobs). An ad-hoc run writes a row with
   `snapshot_kind = 'manual'` and manual rows are excluded from scoring.
3. **Model versions are immutable.** Changing weights, inputs, or the fit =
   new `model_version` string. Old rows keep their version.
4. **Be polite to sources.** FEI is scraped at most once per day, cached to
   `data/cache/fei-YYYY-MM-DD.html`, with a real User-Agent and a 2s delay
   between requests. Never redistribute FEI numbers; they stay local.
5. **Fail loud, write nothing.** If any source fails validation, the job exits
   non-zero and writes no partial rows for that snapshot.

## Data sources

### CollegeFootballData (CFBD)
- Base: `https://api.collegefootballdata.com`
- Auth: `Authorization: Bearer $CFBD_API_KEY` (tier-2 key, 30k calls/mo —
  budget ~200 calls/week, cache aggressively)
- Endpoints used:
  - `GET /games?year=&week=&seasonType=regular` → schedule, final scores
  - `GET /lines?year=&week=` → spreads/totals by book; take consensus or
    the book with the latest `updated` timestamp
  - `GET /ratings/sp?year=` → SP+ overall rating per team
  - `GET /ratings/elo?year=&week=` → Elo per team
  - `GET /ratings/fpi?year=` → FPI (optional third rating)

### FEI (bcftoys.com)
- Weekly team ratings table. Scrape with `cheerio`.
- Respect `robots.txt` and site terms; one fetch per day max.
- Store: `team, week, fei, ofei, dfei, fetched_at`.
- Team names differ from CFBD. Maintain `config/team-aliases.json` and fail
  the job if any FEI team cannot be mapped.

### Kalshi (public market data, read-only)
- Base: `https://api.elections.kalshi.com/trade-api/v2`
- Public GET endpoints need no auth. Do not add auth headers in v1.
- Discover the NCAAF game-winner series via `GET /series` or
  `GET /markets?series_ticker=...` (expected `KXNCAAFGAME` — verify on first
  run and store the confirmed value in `config/kalshi.json`).
- Per market, store `yes_bid, yes_ask, volume, open_interest` from
  `GET /markets/{ticker}` (and `GET /markets/{ticker}/orderbook` if depth is
  needed later).
- Map each market to a CFBD `game_id` using team names + kickoff date. Fail
  the job on unmapped markets rather than guessing.

## Schema (`db/schema.sql`)

```sql
CREATE TABLE games (
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

CREATE TABLE ratings (
  season   INTEGER NOT NULL,
  week     INTEGER NOT NULL,          -- week the rating was published for
  source   TEXT NOT NULL,             -- 'sp', 'elo', 'fpi', 'fei'
  team     TEXT NOT NULL,             -- CFBD canonical name
  rating   REAL NOT NULL,
  extra    TEXT,                      -- JSON for sub-components (ofei/dfei)
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (season, week, source, team)
);

CREATE TABLE markets (
  ticker      TEXT PRIMARY KEY,
  game_id     INTEGER NOT NULL REFERENCES games(game_id),
  yes_team    TEXT NOT NULL,          -- team that pays $1 on YES
  close_utc   TEXT
);

CREATE TABLE forecasts (
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
  vegas_prob      REAL,               -- spread → P(yes_team wins)
  outcome         INTEGER,            -- 1 yes_team won, 0 lost, NULL pending
  resolved_at     TEXT
);

CREATE INDEX idx_forecasts_game ON forecasts(game_id, snapshot_kind);
```

## Model v1 (`src/model/v1.ts`, `model_version = 'v1-blend'`)

Keep it dumb on purpose. This is the baseline everything later must beat.

1. For each rating source, compute `diff = rating(yes_team) - rating(opponent)`,
   plus a home-field term (`+2.5` points-equivalent for home, 0 if neutral).
   For sources not on a points scale (Elo), fit the scale in step 2.
2. Fit one logistic regression per source on CFBD historical games
   (seasons 2021–2025): `P(win) = sigmoid(a + b*diff + c*home)`. Save
   coefficients to `config/model-v1.json`. Fitting is a one-time script
   (`npm run fit`), not part of the weekly job.
3. `my_prob` = simple mean of the per-source probabilities that are available
   that week (SP+, FEI, Elo; FPI if present). If fewer than 2 sources are
   available for a game, skip the game and log a warning.
4. Clamp to [0.02, 0.98].

Vegas comparison: convert the closing spread to a probability with
`sigmoid(spread / 7.0)` style normal approximation (`stdDev ≈ 13.5` points
for CFB). Put the constant in config.

## Jobs (`npm run <name>`)

| Job        | When (America/Chicago)          | Does |
|------------|----------------------------------|------|
| `ratings`  | Tue 06:00                        | Pull SP+, Elo, FPI from CFBD; scrape FEI; upsert `ratings` |
| `snapshot:tuesday` | Tue 07:00                | Pull games + lines + Kalshi markets for the week; write one `forecasts` row per market, `snapshot_kind='tuesday'` |
| `snapshot:pregame` | every 30 min Thu–Sat     | For games kicking off in the next 90 min with no `pregame` row yet, write a `pregame` row |
| `resolve`  | Sun 06:00 and Mon 06:00          | Pull completed games; fill `outcome` + `resolved_at` on all pending rows |
| `report`   | Mon 06:30                        | Score everything resolved; write `reports/YYYY-WW.md` |

Every job is idempotent: re-running it in the same window must not create
duplicate rows (enforce with a UNIQUE index on
`(game_id, ticker, snapshot_kind, model_version)` for non-manual kinds).

## Scoring (`src/score.ts`)

Compute per `snapshot_kind` and per `model_version`, over resolved,
non-manual rows:

1. **Brier score** for `my_prob`, `market_mid`, and `vegas_prob`, side by side.
   Lower is better. Also report log loss.
2. **Calibration table** in 10% bins: predicted vs observed frequency, with N.
3. **Hypothetical P&L** per row, 1 contract, only when `|my_prob - market_mid| >= EDGE_MIN` (config, start 0.05):
   - Taker: buy YES at `yes_ask` (or NO at `100 - yes_bid`), fee =
     `ceil(0.07 * P * (1 - P) * 100)/100` dollars with P in dollars, rounded
     up to the cent per Kalshi's schedule.
   - Maker: assume fill at `yes_bid` (or `100 - yes_ask` for NO), fee = 0.
     Flag that maker fills are not guaranteed.
   Report total P&L, ROI on amount risked, and count of qualifying rows.
4. **Edge decay**: Brier for `tuesday` vs `pregame` rows on the same games.

## Report format (`reports/YYYY-WW.md`)

Short. One table per section above, then a 3-line plain-English summary:
is my Brier better than the market's, is the gap shrinking by kickoff, and
would maker-only trading on the EDGE_MIN filter have been profitable.
No charts in v1.

## Project layout

```
cfb-forecast-log/
  CLAUDE.md
  package.json
  config/
    model-v1.json        # fitted coefficients
    team-aliases.json    # FEI/Kalshi name → CFBD name
    kalshi.json          # confirmed series ticker
  db/schema.sql
  data/                  # forecasts.db, cache/  (gitignored)
  reports/               # gitignored
  src/
    sources/cfbd.ts
    sources/fei.ts
    sources/kalshi.ts
    model/v1.ts
    jobs/*.ts
    score.ts
    db.ts
  scripts/fit.ts
```

## Environment

```
CFBD_API_KEY=
FEI_USER_AGENT="cfb-forecast-log (personal research; drew@tagstrategies.co)"
TZ=America/Chicago
```

## Definition of done for v1

- `npm run ratings && npm run snapshot:tuesday` runs clean for the current
  week and writes one row per Kalshi NCAAF game market.
- `npm run resolve && npm run report` after the weekend produces a report
  with all three Brier scores and the calibration table.
- Re-running any job twice produces zero duplicate rows.
- No code path can place an order.

## Things to ask Drew before doing

- Changing any constant in `config/` after the first snapshot has been written.
- Adding a new rating source (needs a new `model_version`).
- Anything touching Kalshi auth or order endpoints (answer is no in v1).
