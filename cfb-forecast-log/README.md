# cfb-forecast-log

Logs my college-football win-probability forecasts next to the Kalshi market
price and the Vegas closing line, then scores them after games resolve.
Read `CLAUDE.md` for the full spec and hard rules. **This is not a trading
bot**: there are no credentials with trading permission and no order code.

## Setup

```
npm install
cp .env.example .env     # fill in CFBD_API_KEY
npm run fit              # one-time: fits config/model-v1.json on 2021-2025 (~90 CFBD calls)
```

## Weekly jobs (America/Chicago)

| Command                    | When                 |
|----------------------------|----------------------|
| `npm run ratings`          | Tue 06:00            |
| `npm run snapshot:tuesday` | Tue 07:00            |
| `npm run snapshot:pregame` | every 30 min Thu–Sat |
| `npm run resolve`          | Sun 06:00, Mon 06:00 |
| `npm run report`           | Mon 06:30            |

Run them with `npm run scheduler` (node-cron) or install `cron.example`.
`npm run snapshot:manual` writes rows that are excluded from scoring.

## Progress tracker

`npm run tracker` writes `reports/tracker.html`, a one-page view of where the
current week stands: ratings, Tuesday predictions, pregame checks, grading and
the report, plus season progress, last job runs, and warnings when a job fails
or the Mac sleeps through a pregame window. It reads only the local database
and `data/jobs.log`; it makes no network calls and writes nothing to the
database. The cron file regenerates it every 15 minutes and the page reloads
itself every 5. Open it with `open reports/tracker.html`.

## First-run checks

- Kalshi: the series ticker in `config/kalshi.json` is verified against
  `GET /series/{ticker}` on the first snapshot and `series_confirmed` is set.
- FEI: `config/fei.json` holds the page URL pattern; the parser is header
  driven (needs `Team` and `FEI` columns). Unmapped team names fail the job;
  add them to `config/team-aliases.json`.
- Overrides: `SEASON=` and `WEEK=` env vars force a season/week.

## Development

```
npm run typecheck
npm test
```
