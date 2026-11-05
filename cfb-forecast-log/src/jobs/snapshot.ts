/**
 * Job: snapshot <tuesday|report|pregame|manual>
 *   tuesday : Tue 07:00 — one row per open Kalshi market for this week's games.
 *   report  : Wed evening, after the SEC's initial availability report is ingested —
 *             the same markets again, to measure whether Kalshi lags official news.
 *             Skips (writes nothing) unless a report was stored in the last 24 h.
 *   pregame : every 30 min Thu-Sat — rows for games kicking off within 90 min.
 *   manual  : ad hoc; rows are excluded from scoring and may repeat.
 * Everything is validated first; rows are written in one transaction.
 * Idempotent via the partial UNIQUE index on (game_id, ticker, kind, model).
 */
import { loadAliases, loadModelConfig } from '../config';
import { openDb, loadRatings, upsertGames, upsertMarkets } from '../db';
import { log, runJob } from '../log';
import { assertFitted, homeIndicator, predictV1, vegasProb } from '../model/v1';
import { adjustForQb, loadModelV2Config, starterStatus, startersFromAttempts } from '../model/v2';
import { assertV3Fitted, loadModelV3Config, predictV3 } from '../model/v3';
import { loadModelV4Config, predictV4, type TeamAdjustment } from '../model/v4';
import { adjustmentFor, describe, loadV4Inputs } from '../model/v4-inputs';
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
  const v2 = loadModelV2Config();
  if (v2.base_model_version !== model.model_version) {
    throw new Error(`config/model-v2.json builds on ${v2.base_model_version} but model-v1.json is ${model.model_version}`);
  }
  const v3 = loadModelV3Config();
  assertV3Fitted(v3);
  if (v3.base_model_version !== model.model_version) {
    throw new Error(`config/model-v3.json builds on ${v3.base_model_version} but model-v1.json is ${model.model_version}`);
  }
  const v4 = loadModelV4Config();
  if (v4.base_model_version !== model.model_version) {
    throw new Error(`config/model-v4.json builds on ${v4.base_model_version} but model-v1.json is ${model.model_version}`);
  }
  const now = new Date();
  const { cfbd, season, week, games } = await seasonContext(now);
  const aliases = loadAliases();

  const db = openDb();
  if (kind === 'report') {
    const since = new Date(now.getTime() - 24 * 3_600_000).toISOString();
    const rep = db.prepare(`SELECT MAX(as_of) AS at FROM news_facts WHERE model = 'availability-report' AND as_of >= ?`).get(since) as { at: string | null };
    if (!rep.at) {
      log.info('no official availability report stored in the last 24 h; nothing to snapshot');
      return;
    }
    log.info(`latest official availability report posted ${rep.at}`);
  }
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
    if (kind === 'tuesday' || kind === 'report') return game.week === week;
    if (kind === 'pregame') return kick - now.getTime() <= PREGAME_WINDOW_MS;
    return true;
  });
  log.info(`${selected.length} market(s) selected for kind=${kind}`);

  // Closing lines for every week that has a selected game (normally just one).
  const spreads = new Map<number, number | null>();
  for (const w of new Set(selected.map((m) => m.game.week))) {
    for (const l of await cfbd.lines(season, w)) spreads.set(l.game_id, l.spread);
  }

  // v2 inputs: each team's starting QB (season pass-attempt leader). Fetched
  // before anything is written, so a failure here writes nothing (hard rule 5).
  const starters = selected.length > 0 ? startersFromAttempts(await cfbd.passAttempts(season), v2.qb.min_starter_share) : new Map();
  const v4Starters = selected.length > 0 ? startersFromAttempts(await cfbd.passAttempts(season), v4.qb.min_starter_share) : new Map();
  const v4Inputs = selected.length > 0 ? await loadV4Inputs(cfbd, v4, season, week) : null;
  const adj = new Map<string, TeamAdjustment>();
  const adjFor = (team: string, at: string) => {
    if (!adj.has(team)) adj.set(team, adjustmentFor(db, v4, v4Inputs!, v4Starters, team, at));
    return adj.get(team)!;
  };

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
    const q = adjustForQb(
      v2,
      pred.prob,
      starterStatus(db, v2, m.yes_team, starters.get(m.yes_team), snapshot_utc),
      starterStatus(db, v2, opponent, starters.get(opponent), snapshot_utc),
    );
    const v1Row = rows[rows.length - 1];
    rows.push({ ...v1Row, model_version: v2.model_version, my_prob: q.prob });
    const p3 = predictV3(v3, pred.prob, v1Row.vegas_prob);
    rows.push({ ...v1Row, model_version: v3.model_version, my_prob: p3 });
    const ay = adjFor(m.yes_team, snapshot_utc);
    const ao = adjFor(opponent, snapshot_utc);
    const p4 = predictV4(v4, pred.prob, ay, ao);
    rows.push({ ...v1Row, model_version: v4.model_version, my_prob: p4 });
    if (ay.points > 0.05 || ao.points > 0.05 || ay.coach.length || ao.coach.length) log.info(`  v4 ${describe(ay)} | ${describe(ao)}`);
    const qbNote = [q.yes_qb, q.opp_qb].filter((x) => x && x.weight > 0).map((x) => `${x!.team} QB ${x!.player} ${x!.status}`);
    log.info(
      `${m.ticker}: ${m.yes_team} my=${pred.prob.toFixed(3)} v2=${q.prob.toFixed(3)} v3=${p3.toFixed(3)} v4=${p4.toFixed(3)}${qbNote.length ? ` (${qbNote.join('; ')})` : ''} [${pred.sources_used.join(',')}] ` +
        `mkt=${hasQuote ? ((m.yes_bid! + m.yes_ask!) / 200).toFixed(3) : 'n/a'} vegas=${spread === null ? 'n/a' : vegasProb(model, spread, yesIsHome).toFixed(3)}`,
    );
  }

  // A market snapshot without market prices is useless for scoring. If most
  // selected markets came back unquoted, the Kalshi response shape has
  // probably changed: fail loud rather than log rows with no comparison.
  const quoted = rows.filter((r) => r.market_mid !== null).length; // v1-v4 rows share quotes, so the ratio is unchanged
  if (rows.length > 0 && quoted * 2 < rows.length) {
    throw new Error(`only ${quoted} of ${rows.length} markets have a Kalshi bid/ask; refusing to write a snapshot without market prices`);
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
