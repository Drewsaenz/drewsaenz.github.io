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

## Model v2 (`src/model/v2.ts`, `model_version = 'v2-qb'`, approved by Drew 2026-11-02)

v1-blend, then a fixed penalty when a team's starting QB is reported out or doubtful.
Logged next to v1 at every snapshot (same market prices, its own rows), so the report
scores the two side by side.

- Starter = the team's season pass-attempt leader (CFBD `/stats/player/season`,
  category passing), if he has >= 40% of the team's attempts. A backup being out does nothing.
- Status = the latest `news_facts` QB fact naming him (name match tolerates transcript
  misspellings), published at or before the snapshot, within 8 days (any time this season
  if stated as season-ending), confidence >= 0.5. A later "available" clears it.
- Shift = 6 points x status weight (out 1.0, doubtful 0.75), converted to logit with
  0.14105/point (mean of v1's SP+ and FPI slopes). Constants in `config/model-v2.json`.
- 6 points is a prior, not a fit. Changing it means a new `model_version`.
- `npm run v2:check` previews this week's penalties; `npm run v2:backtest` re-scores
  logged v1 rows as if v2 had run (rough: uses today's starters).

## Model v3 (`src/model/v3.ts`, `model_version = 'v3-anchor'`, approved by Drew 2026-11-05)

Anchored on the Vegas line; v1 only moves it. Logged next to v1 and v2 at every snapshot.

- `logit(p3) = logit(vegas) + lambda * (logit(v1) / temper - logit(vegas))`. No line posted: tempered v1 alone.
- `temper` undoes v1's fit leak (SP+/FPI/FEI were fit on season-final ratings). Measured on Elo, the
  only source available both ways: slope on season-final Elo / slope on prior-week Elo. Assumes the
  other sources leak about as much.
- `lambda` is fit leave-one-season-out on 2021-2025 with prior-week Elo standing in for the ratings
  model (leak-free). Conservative, since v1 has more sources than Elo.
- `npm run v3:fit` runs the backtest and writes `config/model-v3.json`; it refuses once v3 rows exist.
  `npm run v3:check` re-scores this season's logged v1 rows as v3 (out-of-sample: no 2026 data in the fit).
- First fit (2026-11-05, 3,461 games): temper 1.243, lambda 0.160. Backtest Brier: line 0.1786,
  prior-week Elo 0.1893, blend 0.1786. Leak-free ratings added almost nothing over the line historically.
- v3 does not apply the v2 QB penalty: the line usually prices a known QB absence already.
- The board (`src/board.ts`) shows v1/v2 only; v3 appears in the report.

## Model v4 (`src/model/v4.ts`, `model_version = 'v4-avail'`, approved by Drew 2026-11-05)

v1-blend ratings, adjusted for who is actually available on both teams and for recent coaching changes.
Logged next to v1-v3 at every snapshot; the board shows v4 as "the model" when its rows exist.

- `logit(p4) = logit(v1) + points_to_logit * (lost(opponent) - lost(yes team))`, lost = points of spread.
- Per player, the latest fact (official availability report, article or show; confidence >= 0.5, last 8
  days, or season-long) weighted by status (out 1, doubtful .75, limited .5, questionable .35, probable .1):
  starting QB (season pass-attempt leader) 6 pts, faded 25% per straight week already missed (the ratings
  have partly absorbed it; fixes the UCLA/Iamaleava double count); RB 3 x share of team rushing yards;
  WR/TE 4 x share of receiving yards; defenders 8 x share of team defensive impact (tackles + 2 TFL +
  3 sacks + 2 PD); OL 0.6 each, capped at 2; non-QB total capped at 6. Shares come from CFBD season stats.
- Coaching: a head-coach change in the last 21 days costs 1 pt; coordinator changes are detected and
  listed but weighted 0 until there is evidence. Roles are read from the fact wording (the extraction
  prompt asks for the role first, e.g. "Offensive coordinator X was fired").
- Every number is a prior (`config/model-v4.json`); there is no availability history to fit on yet.
  Changing one after v4 rows exist is a new model_version.
- v4 is not anchored to Vegas (that is v3). The question v4 answers: does knowing who plays beat the
  market before the market has priced it? The `report` snapshot is how that gets measured.
- `npm run v4:check [-- --all]` shows this week's games where v4 moves v1, with every player and points.

## Model v4.1 (`model_version = 'v4.1-avail'`, approved by Drew 2026-11-06)

v4-avail with identical player and coaching weights (`config/model-v4.1.json`); only the sources are layered
(`layeredStatuses` in `src/model/v4.ts`, switched on by the config's `sources` block). Logged next to v1-v4 at
every snapshot; the board shows v4.1 as "the model" when its rows exist.

- An official availability report posted since the team's previous game is the whole truth up to its posting
  time: listed players get the report's status, unlisted players count as available.
- Shows and articles count only when newer than that report (or for teams with no report), and only when at
  least 2 different outlets mention the player; the status used is the one two outlets support (each outlet's
  latest word counts once). A corroborated post-report status overrides the report for that player.
- Why: in week 10 one player's podcast facts flipped between out, questionable and returning daily, and
  single-show claims (Arch Manning probable, Missouri QB Austin Simmons questionable, Harris Seymour out) moved
  v4 though the SEC report listed none of them. Coaching changes are unchanged from v4 (still noisy: the fact
  date is when a show mentioned the change, not when it happened).
- `npm run v4:check -- --v41` previews it.

## Model v5 (`src/model/v5.ts`, `model_version = 'v5-fused'`, approved by Drew 2026-11-09)

The line, the ratings and the injury layer blended with weights fit on this project's own graded rows.

- `z = a0 + a*logit(vegas) + b*logit(v1)/temper + w(h)*c*injury`; no line posted: `logit(v1)/temper + w(h)*c*injury`.
  `injury` = points the opponent lost to unavailable players minus the yes team's, from v4.1's source-layered
  adjustment. `w(h)` fades the injury term from 1 at >= 72 h before kickoff to 0 at kickoff (`fade` in config):
  the line absorbs injury news during the week, and v2/v4 lost ground at kickoff by counting it twice.
- `npm run v5:fit`: ridge logistic regression on graded v1 Tuesday/pregame rows with a line (not manual, not
  voided), pulled toward the priors in `config/model-v5.json` (v3's anchor weights, v4's points-to-logit) with
  strength `prior_weight`; scored leave-one-week-out next to Kalshi, Vegas, v1 and the priors alone. Writes
  `coefs` and `fitted_at`. Refuses once v5 rows exist: a refit is a new model_version. Until fitted, the snapshot
  logs v1-v4.1 and skips v5 with a warning.
- The injury weight `c` stays at its prior until at least `min_injury_rows` (100) graded rows carry a non-zero injury term;
  the first fit (2026-11-09) had 12 such rows and the data alone put `c` at 3.5x the prior, which is noise.
- `npm run v5:check` previews this week's games with the injury term and its fade weight.
- Reads v4.1's config for the injury layer, so v5 inherits v4.1's "official report first, two outlets otherwise".

## Model v5.1 (`src/model/v51.ts`, `model_version = 'v5.1-fused'`, approved by Drew 2026-11-12)

v5's formula and fitted coefficients (`config/model-v5.1.json` copies them), with the injury term limited to
news the line is unlikely to have priced: from v4.1's adjustment it drops a starting QB who already missed the
team's previous game (CFBD weekly passing), any player already listed out/doubtful for that game (a fact within
10 days before its kickoff, or a season-long status stated before it), and coaching changes reported before it.
Caps are re-applied. Week 11 motivation: v5's edges on USC, Auburn and Michigan came from two- and three-week-old
news (a benching stored as "limited", Kamario Taylor out since October, Oregon's OC fired Oct 24). v5.1 is now the
main model (board and report); v5 keeps logging under "Also logged". Same day: `coachRole` reads "head coach X
fired his coordinator" as a coordinator change (it had been a head-coach change, costing a point); that fix
applies to v4, v4.1, v5 and v5.1 as a wrong-data fix.

## Model v5.2 (`model_version = 'v5.2-fused'`, approved by Drew 2026-11-12)

v5.1's formula, coefficients and fresh-news rule, with the injury layer read through `config/model-v4.2.json`
(`v4.2-avail`: v4.1's weights and layering; an input to v5.2 only, not logged as its own model). Two matching
changes, both behind config flags so v2 to v5.1 behave exactly as before:

- `name_match: "strict"` (`sameNameStrict` in `src/model/v2.ts`). `sameName` called two teammates one player
  whenever they shared a last name and a first initial; the stored facts held nine such pairs on 2026-11-12,
  two of them a starting QB with a non-QB (Oregon's Dante and Dakorien Moore, Vanderbilt's Jared and Jamison
  Curtis). Strict first names must be equal, an initial, a short form (Kam/Kamron) or a one- or two-letter
  misspelling. A bare last name joins a full name only when one player in the team's facts carries it
  (`resolveLoneSurnames`). Stat lookups fall back to "same last name, initial and position group" because the
  stats feed and the roster disagree on first names (Trey / Trevion Cooley). The starting-QB check stays on
  `sameName` in every version.
- `sources.unnamed_outlet: "by_site"`: a fact with no channel is its own outlet, keyed by its site. v4.1 pools
  them into one voice. No stored fact lacks a channel, so this changes nothing today.

Logged on every snapshot beside v5.1. v5.1 is still the main model; switching the board and report to v5.2 is
Drew's call (`DEFAULT_FOCUS_MODELS` in `src/config.ts`, model pick in `src/board.ts`). On the week 11 facts the
two differ for 2 of the teams playing: Washington (a bare "Davis" now counts for Elinneus Davis) and Mississippi
State (Amaree Williams no longer merged with Ayden Williams).

## Model v5.3 (`model_version = 'v5.3-fused'`, approved by Drew 2026-11-23)

v5.2's formula, coefficients and fresh-news rule, with the injury layer read through `config/model-v4.3.json`
(`v4.3-avail`: v4.2 plus a `depth_chart` block; an input to v5.3 only, not logged as its own model). It adds one
thing: a starting QB who lost the job without being hurt (`src/model/v43.ts`).

- Why: week 12 Oklahoma-Texas A&M. About ten outlets had Brady Hart starting over Marcel Reed. The SEC report
  listed Reed "Available" (he was healthy), which the v4.1 layering treats as the whole truth, and the extractor
  had filed the benching under out, unknown, questionable or available by turns. v5.1 and v5.2 saw nothing.
- Facts carry `role` (`starter | benched | competition | none`): a coach's lineup decision, separate from health.
  New column on `news_facts`; the extraction prompt fills it and leaves the status wording alone, so v2 to v5.2
  read the same inputs as before. Official report facts are `none`. Facts stored before 2026-11-23 were tagged by
  `npm run news:role` (QB facts only, a short classification call over `detail`, like `news:gameref`).
- For the team's starting QB (season pass-attempt leader), each outlet's latest word since the team's previous
  game is one vote: benched (he is benched, or another QB is named the starter), competition (the coach has not
  decided), or starter. A vote counts once 2 outlets cast it; the most recently corroborated vote wins, so two
  outlets saying he starts clear a benching. One benched plus one competition outlet is a competition. "Another QB
  will start" corroborates a benching but cannot establish one: at least one outlet must say the starter himself
  was benched (otherwise injury replacements and "if he can't go, the backup starts" counted). Recaps
  (`game_ref` previous) and confidence under 0.5 do not vote. The official report never enters.
- Points: benched 3 (half the 6 for an injured starter), competition 1.5. Priors. The QB item is the larger of
  the health penalty and this; they do not stack.
- The fresh-news rule still applies: a starter who threw no pass in the team's previous game is dropped as
  priced. So v5.3 moves in the first week of a benching, not the second.
- Known gap, not addressed: "starter" is still the season attempt leader, so a new starter getting hurt counts
  for nothing in any version.
- `npm run v4:check -- --v43` previews the layer. Logged on every snapshot beside v5.1 and v5.2.
- **Main model since 2026-11-23 (Drew).** Board, report focus list (`DEFAULT_FOCUS_MODELS`) and the Games tab use
  v5.3; for games logged before it existed the board and Games tab fall back to v5.1. v5.1 and v5.2 move to
  "Also logged, not read". v5.2 had matched v5.1 on every graded game when this was decided. The board's QB flag (`qbFlags`) is unchanged because the report's News check is scored off it.

## Spread model m1 (`src/model/m1.ts`, `model_version = 'm1-margin'`, approved by Drew 2026-11-22)

A point-spread model trained on final scoring margins (not a win probability turned into points). Rows go to
`spread_forecasts` (append-only, home perspective, one per game per snapshot, unique per game/kind/model for
non-manual kinds), logged by every snapshot once fitted; until then the snapshot warns and skips it.

- `m1 = v + lambda * (r - v) + w(h) * k * injury`, home margin. `v` = -Vegas spread. `r` = mean over SP+, FPI, FEI,
  Elo of a least-squares line `a + b * rating diff + c * home` per source, divided by `temper`. No line: `r + injury`.
- `npm run m1:fit` (needs CFBD + FEI, so it runs on the Mac): lines on 2021-2025 (SP+/FPI/FEI season-final, Elo
  prior-week), temper = Elo slope season-final / prior-week, lambda = least squares on (actual - line) vs
  (ratings - line) with out-of-fold prior-week Elo as the ratings (leak-free, conservative, as in v3). Prints
  leave-one-season-out MAE for line / Elo / blend and the against-the-spread record. Refuses once m1 rows exist.
- injury = v5.1's fresh-news points (away lost minus home lost), `injury_scale` 1 (a prior: they are already
  points), faded to 0 at kickoff like v5.
- `npm run m1:check`: m1 on this season's finished games (out of sample; no injury term), MAE vs Vegas and vs
  v5.1 turned into points, ATS record when |m1 - Vegas| >= `ats_min_gap` (2), plus this week's m1 vs Vegas.
- The weekly report adds a "Spread model" section (MAE, RMSE, ATS record; break-even 52.4% at -110). Graded:
  finished games, snapshot before kickoff, no void on that game and snapshot kind.
- Board "Spread" column: m1's line for the backed team when it has a row, otherwise the main model's probability
  as points (sd 13.5), with the Vegas spread and the gap. Forecast Desk Games tab: "Show spreads" toggle; m1 column.
- `npm run kalshi:series`: read-only `GET /series?category=Sports` search; samples open markets only for spread/total
  series, one request a second (the first version sampled all ~150 series and hit 429s). Kalshi spread markets are
  not logged; adding them is a separate decision.
- First fit (2026-11-22, 3,461 games): temper 1.031, lambda 0.047. Leave-one-season-out MAE: line 12.13, prior-week
  Elo 12.92, blend 12.14; m1 never moved 2 points off the line. m1:check on 2026: Tuesday MAE m1 12.56 vs Vegas 12.54
  (246 games). In practice m1 is the Vegas line. Kalshi lists full-game spreads as `KXNCAAFSPREAD` ("X wins by over
  N.5", several strikes per game), plus `KXNCAAFTOTAL`, `KXNCAAFWINMARGIN`, and half/quarter spreads.

### Fact timing (`game_ref`, 2026-11-09)

The extractor tags every fact with which game it is about: `upcoming`, `previous` (a recap of a game already
played: "left in the third quarter", "played through it"), `season`, or `unknown`. v2, v4, v4.1, v5 and the News
check ignore `previous` facts. Facts stored before 2026-11-09 have `game_ref` NULL and still count until `npm run news:gameref` tags them: official-report facts directly from their scope, the rest by a short classification call over their `detail` text (`classifyGameRefs`). Official
availability-report facts are `upcoming` (or `season` when exempt-Out). Drew approved applying this to the
existing versions too: it removes wrong data rather than changing what the models do with right data.

### `report` snapshot (Wednesday evening)

`npm run snapshot:report`: the same markets as Tuesday, re-priced after the SEC's initial availability report
is ingested (cron 19:40-21:40 CT Wednesday; first run after the report writes, later runs are no-ops via the
unique index). Writes nothing unless an official report was stored in the last 24 hours. Comparing Tuesday ->
report -> pregame Kalshi moves against v4 shows whether Kalshi lags official news.

### `friday` snapshot (Friday evening, approved by Drew 2026-11-23)

`npm run snapshot:friday` (cron Fri 19:40 CT, after the SEC's 19:10 update is ingested): the week's games that have
not kicked off, re-priced with every model, `snapshot_kind = 'friday'`. Why: most lineup and injury news lands
Thursday and Friday, after the Wednesday `report` snapshot, and by `pregame` the v5 family has faded its injury
term to zero (week 12: the Reed benching was corroborated Friday 5pm and no snapshot weighted it). Scored like
any other kind. Note the v5 fade is unchanged: about 20 hours before a Saturday kickoff the injury term counts at
roughly 0.25 to 0.35, so v5.x moves a little here; v4.x (no fade) and the Friday-to-pregame Kalshi move are the
cleaner read on whether Friday news is priced. One run per week: reruns are no-ops via the unique index.

## Jobs (`npm run <name>`)

| Job        | When (America/Chicago)          | Does |
|------------|----------------------------------|------|
| `ratings`  | Tue 06:00                        | Pull SP+, Elo, FPI from CFBD; scrape FEI; upsert `ratings` |
| `snapshot:tuesday` | Tue 07:00                | Pull games + lines + Kalshi markets for the week; write one `forecasts` row per market, `snapshot_kind='tuesday'` |
| `snapshot:friday`  | Fri 19:40                | Same markets as Tuesday that have not kicked off, `snapshot_kind='friday'` |
| `snapshot:pregame` | every 30 min Thu–Sat     | For games kicking off in the next 90 min with no `pregame` row yet, write a `pregame` row |
| `resolve`  | Sun 06:00 and Mon 06:00          | Pull completed games; fill `outcome` + `resolved_at` on all pending rows. Rows that can't be graded fairly (game cancelled, moved to another week, dropped by CFBD, or a pregame row whose kickoff later moved) go to `forecast_voids` instead (rules in `src/grading.ts`) |
| `report`   | Mon 06:30                        | Score everything resolved; write `reports/YYYY-WW.md` |

Reliability notes (2026-11-12):
- The week pointer (`currentWeek`) and the pregame "anything soon?" check look at
  games with an FBS team only. The CFBD feed carries every division.
- `ratings` fetches SP+, Elo and FPI fresh, never from the cache, and warns when a
  source is identical to the week before (week 10 ran on week 9's SP+). The
  tracker shows the same warning.
- A Kalshi market dated after the last scheduled game (bowls, playoff) is skipped
  with a warning. Any other unmapped market still fails the snapshot.
- The tracker warns when `news:extract` or `news:availability` fails three times
  in a row, and when any other job's latest run failed.

Every job is idempotent: re-running it in the same window must not create
duplicate rows (enforce with a UNIQUE index on
`(game_id, ticker, snapshot_kind, model_version)` for non-manual kinds).

### `export` (on demand; Drew's season book runs it)

`npm run export -- --team Texas --out <file.json>` (`scripts/export.ts`, math in `src/projection.ts`): the team's remaining
regular-season games with win probability and a projected score, for `~/Desktop/Home/stat-dash` (`npm run forecast` there).
Writes no rows. Probability = latest scheduled v4-avail row for the game if logged, else v1-blend on the latest ratings week.
Margin = sd 13.5 normal quantile of that probability; total = Vegas over/under when posted, else SP+ off + opp SP+ def - national
average, both sides (checked 2026-11-05 on 96 posted totals: bias -0.2, MAE 4.1). Exports probabilities and scores only, never FEI numbers.

### `app` (on demand): Forecast Desk

`npm run app`, then http://localhost:3300 (`APP_PORT` to change). A local web page over the same database
(`src/app/server.ts`, queries in `src/app/data.ts`, page in `src/app/page.ts`). Listens on 127.0.0.1 only.
Tabs: Board (the tracker page), Games (every model, Kalshi and Vegas at each snapshot for one game, plus that
game's availability news), News (facts by team, recaps hidden, SEC filter), Health & actions (job runs from
data/jobs.log, caffeinate and cron checks, counts). Its only actions are the fixed npm/git commands in `ACTIONS`
(preview = ratings + snapshot:manual + tracker; grade = resolve + tracker; tracker; git pull --ff-only), one at
a time, POSTs from other origins refused. It writes nothing itself and has no order or Kalshi-auth code.
Phone access: Tailscale on the Mac and phone, then `tailscale serve --bg 3300` publishes it inside the tailnet
only (HTTPS at the Mac's tailnet name); the app itself stays bound to 127.0.0.1. Cron `@reboot` starts it at login.

### `power` (on demand)

`npm run power -- [--week N] [--out <file.json>]` (`scripts/power.ts`): every rated team's expected margin, in points, against an
FBS-average team on a neutral field, ranked, with record and movement since the previous ratings week. v1 per-source
probabilities (opponent = each source's mean rating, home = 0) averaged unclamped, tempered by v3's divisor, then the sd 13.5
normal quantile. No line, no availability. Reads only: no rows, no model_version. Exports the blended rating only, never FEI numbers.

### Which models to read (Drew, 2026-11-09)

Read three: **v5.3-fused** (main model; v5-fused until 2026-11-12, v5.1-fused until 2026-11-23), **v3-anchor** (market baseline), **v1-blend** (raw-ratings check). The others
(v2, v4, v4.1) keep logging but are not read. The weekly report puts the three first, summarizes only them, and
scores the rest below an "Also logged, not read" divider (`focus_models` in config/scoring.json overrides the
default list in `src/config.ts`). The tracker board shows v5 as "the model" once its rows exist.

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

**One row per game (2026-11-12).** Kalshi lists a market for each team, and the
two are mirror images. `onePerGame` keeps the alphabetically first ticker per
(game, snapshot kind, model) before anything is scored, in the report and in the
tracker's results view. Both markets are still logged. Before this, every N,
calibration count and P&L figure counted each game twice.

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

## Picks scorecard (claims layer, phase 1; approved by Drew 2026-11-23)

What shows and articles pick for upcoming games, graded after the games (`src/picks.ts`, `scripts/picks.ts`). The point
is to learn which sources, if any, beat the line. **No model reads picks.** Making a source or claim type a model
input is phase 3, needs a few hundred graded examples and a new `model_version`, and needs asking.

- `npm run picks:extract` (Haiku; not on cron): windows that sound like a pick (`PICK_RE`) go to one
  extraction call per transcript; rows land in `picks` (append-only, triggers refuse update and delete). `pick_runs`
  remembers each file by hash, including files with no pick windows. `--dry-run` sizes a job with no API calls.
- Kinds: spread, moneyline, total over/under, team total over/under, lean. Fields: channel, collection, host when
  the text names one (rare: captions do not label speakers), stated line, strength, quote.
- A pick maps to the first game between its two teams that kicks off after the publish time, within 9 days
  (`mapPickToGame`). Mascots fall away in `resolvePickTeam`. Unmatched picks are stored with `game_id` NULL and
  never graded; a recap published after the game cannot match.
- Grades are computed at read time (`gradePick`), never stored. Spread picks grade against the stated line when it
  is within 6 points of the logged Vegas line, else the Vegas line (the last non-manual snapshot's `vegas_spread`
  before kickoff). Totals and team totals need a stated number. Games this project never snapshotted have no Vegas
  line, so a spread pick there grades only with a stated line.
- One episode picking both sides of a game on the same board with no named host is a panel disagreeing; those
  picks are stored and set aside (`conflictedIds`).
- Leaderboard per channel and per collection: against the spread, straight up, underdogs picked, totals, leans.
  `npm run picks:report`, a "Picks scorecard" section in the weekly report, and the Picks tab in Forecast Desk.
  Break-even against the spread is 52.4%.
- First backfill 2026-11-23 over transcripts published since 2026-10-20, stopped at 2,831 of 3,293 files when the API
  balance ran low; Drew chose to leave the rest (348 files with pick windows, `npm run picks:extract` resumes it).
  No picks cron is installed: extraction runs only when started by hand.
- Not built: phase 2 (matchup claims tied to a CFBD stat).

## Transcripts (context, and the input to the injury layer of v2, v4, v4.1 and v5)

`data/transcripts/<collection>/*.md|*.txt` are YouTube transcripts (Texas football shows, pressers, film reviews) pushed from `~/Desktop/Home/TranscriptGPT`. The `.md` ones carry YAML frontmatter (title, channel, url, video_id, saved). They are gitignored with the rest of `data/`. Use them when Drew asks for qualitative context on a game or team (injuries, QB situation, coaching sentiment). They are not a rating source for v1. The only model that reads them is `v2-qb` (see Model v2 above), which Drew approved on 2026-11-02; wiring them into anything else still needs asking.

Availability facts go in `news_facts` (see `src/news.ts`). Two ways to fill it: `npm run news:extract` calls the Claude API (needs a funded `ANTHROPIC_API_KEY` in `.env`), or the no-API path: `npm run news:windows` dumps the availability segments to `data/news-work/*.windows.json`, a Claude Code session writes the matching `*.facts.json` by hand, and `npm run news:import` stores them through the same code path. Player names are resolved to the official CFBD roster on every extract/import (`src/players.ts`; spoken form kept in `player_raw`), so caption misspellings like Kamarion/Kamario Taylor collapse to one name. `npm run news:players -- --dry-run` previews a backfill of already-stored facts; it only renames when the match is unambiguous (last name within one edit, then position, then first name), and leaves the name alone otherwise. Team names the extractor writes differently from CFBD ("Central Florida", "Brigham Young") go in the `news` section of `config/team-aliases.json`; after adding one, `npx tsx scripts/news.ts teams --dry-run` previews giving the already-stored facts their team (and roster names), and the same command without the flag applies it. Only rows with no team are touched. Official conference availability reports are a second source: TranscriptGPT's `availability.js` saves each SEC report (all 16 teams, posted Wed-Fri evenings and ~90 min before kickoff) as slim JSON under `data/availability/sec/`, and `npm run news:availability` turns it into facts at confidence 1.0 with as_of = the report's posting time (`src/availability.ts`; no model, no API cost). It stores every non-available row, and an "Available" row only when it clears a non-available fact from the last 21 days. The fetch is a POST to the vendor API, which is why it lives in TranscriptGPT: this project stays GET-only. TranscriptGPT's `rss.js` also saves injury-relevant articles from the Yahoo college football feed into `data/transcripts/rss news/`, which news:extract handles like any transcript. The scraper now writes `published:` (video publish time) next to `saved:`; `as_of` uses it when present and falls back to `saved`. After backfilling `published:` into older transcripts (`node backfill-published.js` in TranscriptGPT), run `npm run news:restamp` to move already-stored facts to their publish dates so the News check attaches them to the right game.
