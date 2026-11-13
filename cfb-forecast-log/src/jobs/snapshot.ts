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
import { loadModelV5Config, predictV5 } from '../model/v5';
import { freshAdjustment } from '../model/v51';
import { weeksMissed } from '../model/v4';
import { KalshiClient, mapMarketsToGames } from '../sources/kalshi';
import { SNAPSHOT_KINDS, type ForecastInsert, type SnapshotKind } from '../types';
import { seasonContext } from './context';
import { saveStarters } from '../news';

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
  const v41 = loadModelV4Config('model-v4.1.json');
  if (v41.base_model_version !== model.model_version) {
    throw new Error(`config/model-v4.1.json builds on ${v41.base_model_version} but model-v1.json is ${model.model_version}`);
  }
  // v5 is optional until `npm run v5:fit` has written its weights: an unfitted
  // v5 must not cost the snapshot its v1-v4.1 rows, so it is skipped with a warning.
  const v5cfg = loadModelV5Config();
  const v5 = v5cfg.fitted_at && v5cfg.coefs ? v5cfg : null;
  if (!v5) log.warn(`config/model-v5.json is not fitted yet; run \`npm run v5:fit\`. No ${v5cfg.model_version} rows this snapshot.`);
  else if (v5.injury_model_version !== v41.model_version) throw new Error(`model-v5.json expects injury model ${v5.injury_model_version} but model-v4.1.json is ${v41.model_version}`);
  // v5.1: v5's weights, injury term limited to news since each team's previous game.
  const v51cfg = loadModelV5Config('model-v5.1.json');
  const v51 = v51cfg.fitted_at && v51cfg.coefs ? v51cfg : null;
  if (!v51) log.warn(`config/model-v5.1.json has no coefficients; no ${v51cfg.model_version} rows this snapshot.`);
  else if (v51.injury_model_version !== v41.model_version) throw new Error(`model-v5.1.json expects injury model ${v51.injury_model_version} but model-v4.1.json is ${v41.model_version}`);
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
  // Pregame runs every 30 min Thu-Sat. When nothing kicks off in the window there is
  // nothing to snapshot; after Saturday's last kickoff the season week rolls over to one
  // whose ratings are not pulled until Tuesday, so checking first avoids a false failure.
  if (kind === 'pregame') {
    const soon = games.filter((g) => {
      const kick = Date.parse(g.kickoff_utc);
      return kick > now.getTime() && kick - now.getTime() <= PREGAME_WINDOW_MS;
    });
    if (soon.length === 0) {
      log.info('no game kicks off in the next 90 min; nothing to snapshot');
      return;
    }
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
  // v4.1 shares v4's stats, starters and weights; only the source layering differs.
  const adj41 = new Map<string, TeamAdjustment>();
  const adjFor41 = (team: string, at: string) => {
    if (!adj41.has(team)) adj41.set(team, adjustmentFor(db, v41, v4Inputs!, v4Starters, team, at));
    return adj41.get(team)!;
  };
  const adj51 = new Map<string, TeamAdjustment>();
  const adjFor51 = (team: string, at: string) => {
    if (!adj51.has(team)) {
      const st = v4Starters.get(team);
      adj51.set(team, freshAdjustment(db, v41, adjFor41(team, at), at, st ? weeksMissed(v4Inputs!.weekly, team, st.player) : 0));
    }
    return adj51.get(team)!;
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
    const a41y = adjFor41(m.yes_team, snapshot_utc);
    const a41o = adjFor41(opponent, snapshot_utc);
    const p41 = predictV4(v41, pred.prob, a41y, a41o);
    rows.push({ ...v1Row, model_version: v41.model_version, my_prob: p41 });
    let p5: number | null = null;
    if (v5) {
      const hours = (Date.parse(g.kickoff_utc) - now.getTime()) / 3_600_000;
      p5 = predictV5(v5, { p1: pred.prob, pVegas: v1Row.vegas_prob, injuryPoints: a41o.points - a41y.points, hoursToKickoff: hours });
      rows.push({ ...v1Row, model_version: v5.model_version, my_prob: p5 });
    }
    let p51: number | null = null;
    if (v51) {
      const hours = (Date.parse(g.kickoff_utc) - now.getTime()) / 3_600_000;
      p51 = predictV5(v51, { p1: pred.prob, pVegas: v1Row.vegas_prob, injuryPoints: adjFor51(opponent, snapshot_utc).points - adjFor51(m.yes_team, snapshot_utc).points, hoursToKickoff: hours });
      rows.push({ ...v1Row, model_version: v51.model_version, my_prob: p51 });
    }
    if (ay.points > 0.05 || ao.points > 0.05 || ay.coach.length || ao.coach.length) log.info(`  v4 ${describe(ay)} | ${describe(ao)}`);
    const qbNote = [q.yes_qb, q.opp_qb].filter((x) => x && x.weight > 0).map((x) => `${x!.team} QB ${x!.player} ${x!.status}`);
    log.info(
      `${m.ticker}: ${m.yes_team} my=${pred.prob.toFixed(3)} v2=${q.prob.toFixed(3)} v3=${p3.toFixed(3)} v4=${p4.toFixed(3)} v4.1=${p41.toFixed(3)}${p5 === null ? '' : ` v5=${p5.toFixed(3)}`}${p51 === null ? '' : ` v5.1=${p51.toFixed(3)}`}${qbNote.length ? ` (${qbNote.join('; ')})` : ''} [${pred.sources_used.join(',')}] ` +
        `mkt=${hasQuote ? ((m.yes_bid! + m.yes_ask!) / 200).toFixed(3) : 'n/a'} vegas=${spread === null ? 'n/a' : vegasProb(model, spread, yesIsHome).toFixed(3)}`,
    );
  }

  // A market snapshot without market prices is useless for scoring. If most
  // selected markets came back unquoted, the Kalshi response shape has
  // probably changed: fail loud rather than log rows with no comparison.
  const quoted = rows.filter((r) => r.market_mid !== null).length; // v1-v5 rows share quotes, so the ratio is unchanged
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
    saveStarters(db, season, starters.values()); // who starts, for the board's QB flags
    for (const r of rows) inserted += insert.run(r).changes;
  })();
  log.info(`forecasts: ${inserted} inserted, ${rows.length - inserted} already present (idempotent); CFBD calls this run: ${cfbd.callCount}`);
});
