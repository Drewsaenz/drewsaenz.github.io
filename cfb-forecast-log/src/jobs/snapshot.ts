/**
 * Job: snapshot <tuesday|pregame|manual>
 *   tuesday : Tue 07:00 — one row per open Kalshi market for this week's games.
 *   pregame : every 30 min Thu-Sat — rows for games kicking off within 90 min.
 *   manual  : ad hoc; rows are excluded from scoring and may repeat.
 * Everything is validated first; rows are written in one transaction.
 * Idempotent via the partial UNIQUE index on (game_id, ticker, kind, model).
 */
import { loadAliases, loadModelConfig } from '../config';
import { openDb, loadRatings, upsertGames, upsertMarkets } from '../db';
import { log, runJob } from '../log';
import { assertFitted, homeIndicator, predictV1, vegasProb } from '../model/v1';
import { KalshiClient, mapMarketsToGames } from '../sources/kalshi';
import { SNAPSHOT_KINDS, type ForecastInsert, type SnapshotKind } from '../types';
import { seasonContext } from './context';

const PREGAME_WINDOW_MS = 90 * 60_000;

const kind = process.argv[2] as SnapshotKind;
if (!SNAPSHOT_KINDS.includes(kind)) {
  console.error(`usage: tsx src/jobs/snapshot.ts <${SNAPSHOT_KINDS.join('|')}>`);
  process.exit(2);
}

runJob(`snapshot:${kind}`, async () => {
  const model = loadModelConfig();
  assertFitted(model);
  const now = new Date();
  const { cfbd, season, week, games } = await seasonContext(now);
  const aliases = loadAliases();

  const db = openDb();
  const ratings = loadRatings(db, season, week);
  if (ratings.size === 0) throw new Error(`no ratings stored for season ${season} week ${week}; run \`npm run ratings\` first`);

  const kalshi = new KalshiClient();
  await kalshi.confirmSeries();
  const markets = await kalshi.listMarkets('open');
  log.info(`Kalshi: ${markets.length} open markets in ${kalshi.cfg.series_ticker}`);
  const mapped = mapMarketsToGames(markets, games, aliases.kalshi);

  // Which games this snapshot kind covers. Never a game that has already kicked off.
  const selected = mapped.filter(({ game }) => {
    const kick = Date.parse(game.kickoff_utc);
    if (kick <= now.getTime()) return false;
    if (kind === 'tuesday') return game.week === week;
    if (kind === 'pregame') return kick - now.getTime() <= PREGAME_WINDOW_MS;
    return true;
  });
  log.info(`${selected.length} market(s) selected for kind=${kind}`);

  // Closing lines for every week that has a selected game (normally just one).
  const spreads = new Map<number, number | null>();
  for (const w of new Set(selected.map((m) => m.game.week))) {
    for (const l of await cfbd.lines(season, w)) spreads.set(l.game_id, l.spread);
  }

  const snapshot_utc = now.toISOString();
  const rows: ForecastInsert[] = [];
  for (const m of selected) {
    const g = m.game;
    const yesIsHome = m.yes_team === g.home_team;
    const opponent = yesIsHome ? g.away_team : g.home_team;
    const home = homeIndicator(m.yes_team, g.home_team, g.neutral_site === 1);
    const pred = predictV1(model, { yes_team: m.yes_team, opponent, home, ratings });
    if (!pred) {
      log.warn(`skip ${m.ticker}: fewer than ${model.constants.min_sources} rating sources cover ${m.yes_team} vs ${opponent}`);
      continue;
    }
    const spread = spreads.get(g.game_id) ?? null;
    const hasQuote = m.yes_bid !== null && m.yes_ask !== null && m.yes_ask > 0;
    rows.push({
      game_id: g.game_id,
      ticker: m.ticker,
      snapshot_kind: kind,
      snapshot_utc,
      model_version: model.model_version,
      my_prob: pred.prob,
      yes_bid: m.yes_bid,
      yes_ask: m.yes_ask,
      market_mid: hasQuote ? (m.yes_bid! + m.yes_ask!) / 200 : null,
      vegas_spread: spread,
      vegas_prob: spread === null ? null : vegasProb(model, spread, yesIsHome),
    });
    log.info(
      `${m.ticker}: ${m.yes_team} my=${pred.prob.toFixed(3)} [${pred.sources_used.join(',')}] ` +
        `mkt=${hasQuote ? ((m.yes_bid! + m.yes_ask!) / 200).toFixed(3) : 'n/a'} vegas=${spread === null ? 'n/a' : vegasProb(model, spread, yesIsHome).toFixed(3)}`,
    );
  }

  const insert = db.prepare(`
    INSERT ${kind === 'manual' ? '' : 'OR IGNORE'} INTO forecasts
      (game_id, ticker, snapshot_kind, snapshot_utc, model_version, my_prob, yes_bid, yes_ask, market_mid, vegas_spread, vegas_prob)
    VALUES (@game_id, @ticker, @snapshot_kind, @snapshot_utc, @model_version, @my_prob, @yes_bid, @yes_ask, @market_mid, @vegas_spread, @vegas_prob)`);

  let inserted = 0;
  db.transaction(() => {
    upsertGames(db, games);
    upsertMarkets(db, selected.map((m) => ({ ticker: m.ticker, game_id: m.game.game_id, yes_team: m.yes_team, close_utc: m.close_utc })));
    for (const r of rows) inserted += insert.run(r).changes;
  })();
  log.info(`forecasts: ${inserted} inserted, ${rows.length - inserted} already present (idempotent); CFBD calls this run: ${cfbd.callCount}`);
});
