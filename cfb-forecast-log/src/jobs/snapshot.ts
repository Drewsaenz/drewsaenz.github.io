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
import { loadModelV4Config, nameMatcher, predictV4, type TeamAdjustment } from '../model/v4';
import { adjustmentFor, describe, loadV4Inputs } from '../model/v4-inputs';
import { loadModelV5Config, predictV5 } from '../model/v5';
import { freshAdjustment } from '../model/v51';
import { isM1Fitted, loadModelM1Config, predictM1 } from '../model/m1';
import { weeksMissed } from '../model/v4';
import { KalshiClient, mapMarketsToGames } from '../sources/kalshi';
import { SNAPSHOT_KINDS, type ForecastInsert, type SnapshotKind } from '../types';
import { fbsGames } from '../season';
import { seasonContext } from './context';
import { saveStarters } from '../news';

const PREGAME_WINDOW_MS = 90 * 60_000;
const PREGAME_STALE_SCHEDULE_HOURS = 24;

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
  // m1: the point-spread model. Optional until `npm run m1:fit`, like v5.
  const m1cfg = loadModelM1Config();
  const m1 = isM1Fitted(m1cfg) ? m1cfg : null;
  if (!m1) log.warn(`config/model-m1.json is not fitted yet; run \`npm run m1:fit\`. No ${m1cfg.model_version} spread rows this snapshot.`);
  else if (m1.injury_model_version !== v41.model_version) throw new Error(`model-m1.json expects injury model ${m1.injury_model_version} but model-v4.1.json is ${v41.model_version}`);
  // v5.2: v5.1 with stricter name matching in the injury layer (config/model-v4.2.json, not logged on its own).
  const v42 = loadModelV4Config('model-v4.2.json');
  if (v42.base_model_version !== model.model_version) {
    throw new Error(`config/model-v4.2.json builds on ${v42.base_model_version} but model-v1.json is ${model.model_version}`);
  }
  const v52cfg = loadModelV5Config('model-v5.2.json');
  const v52 = v52cfg.fitted_at && v52cfg.coefs ? v52cfg : null;
  if (!v52) log.warn(`config/model-v5.2.json has no coefficients; no ${v52cfg.model_version} rows this snapshot.`);
  else if (v52.injury_model_version !== v42.model_version) throw new Error(`model-v5.2.json expects injury model ${v52.injury_model_version} but model-v4.2.json is ${v42.model_version}`);
  const v43 = loadModelV4Config('model-v4.3.json');
  if (v43.base_model_version !== model.model_version) {
    throw new Error(`config/model-v4.3.json builds on ${v43.base_model_version} but model-v1.json is ${model.model_version}`);
  }
  const v53cfg = loadModelV5Config('model-v5.3.json');
  const v53 = v53cfg.fitted_at && v53cfg.coefs ? v53cfg : null;
  if (!v53) log.warn(`config/model-v5.3.json has no coefficients; no ${v53cfg.model_version} rows this snapshot.`);
  else if (v53.injury_model_version !== v43.model_version) throw new Error(`model-v5.3.json expects injury model ${v53.injury_model_version} but model-v4.3.json is ${v43.model_version}`);
  const now = new Date();
  // Pregame only: if CFBD is down, decide "anything kicking off soon?" from the last cached schedule
  // (up to 24 h old) instead of failing. A game that is due still needs CFBD's lines, so that run fails loud.
  const { cfbd, season, week, games } = await seasonContext(now, kind === 'pregame' ? { staleScheduleHours: PREGAME_STALE_SCHEDULE_HOURS } : {});
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
    const soon = fbsGames(games).filter((g) => {
      const kick = Date.parse(g.kickoff_utc);
      return kick > now.getTime() && kick - now.getTime() <= PREGAME_WINDOW_MS;
    });
    if (soon.length === 0) {
      log.info('no game kicks off in the next 90 min; nothing to snapshot');
      return;
    }
  }
  const ratings = loadRatings(db, season, week);
  const noRatings = () => new Error(`no ratings stored for season ${season} week ${week}; run \`npm run ratings\` first`);
  // Pregame decides after the markets are matched: right after the week's last kickoff the pointer
  // moves to a week with no ratings yet, and a run with nothing to snapshot is not a failure.
  if (ratings.size === 0 && kind !== 'pregame') throw noRatings();

  const kalshi = new KalshiClient();
  await kalshi.confirmSeries();
  const markets = await kalshi.listMarkets('open');
  log.info(`Kalshi: ${markets.length} open markets in ${kalshi.cfg.series_ticker}`);
  const mapped = mapMarketsToGames(markets, games, aliases.kalshi, (msg) => log.warn(msg));

  // Which games this snapshot kind covers. Never a game that has already kicked off.
  const selected = mapped.filter(({ game }) => {
    const kick = Date.parse(game.kickoff_utc);
    if (kick <= now.getTime()) return false;
    if (kind === 'tuesday' || kind === 'report' || kind === 'friday') return game.week === week;
    if (kind === 'pregame') return kick - now.getTime() <= PREGAME_WINDOW_MS;
    return true;
  });
  log.info(`${selected.length} market(s) selected for kind=${kind}`);
  if (ratings.size === 0) {
    if (selected.length > 0) throw noRatings();
    log.info('no ratings for this week yet and nothing to snapshot');
    return;
  }

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
  const adj52 = new Map<string, TeamAdjustment>();
  const adjFor52 = (team: string, at: string) => {
    if (!adj52.has(team)) {
      const st = v4Starters.get(team);
      const base = adjustmentFor(db, v42, v4Inputs!, v4Starters, team, at);
      adj52.set(team, freshAdjustment(db, v42, base, at, st ? weeksMissed(v4Inputs!.weekly, team, st.player, nameMatcher(v42)) : 0));
    }
    return adj52.get(team)!;
  };
  // v5.3: v5.2 plus the depth-chart layer (a benched or undecided starting QB).
  const adj53 = new Map<string, TeamAdjustment>();
  const adjFor53 = (team: string, at: string) => {
    if (!adj53.has(team)) {
      const st = v4Starters.get(team);
      const base = adjustmentFor(db, v43, v4Inputs!, v4Starters, team, at);
      adj53.set(team, freshAdjustment(db, v43, base, at, st ? weeksMissed(v4Inputs!.weekly, team, st.player, nameMatcher(v43)) : 0));
    }
    return adj53.get(team)!;
  };

  const snapshot_utc = now.toISOString();
  const rows: ForecastInsert[] = [];
  const spreadRows: { game_id: number; snapshot_kind: SnapshotKind; snapshot_utc: string; model_version: string; home_margin: number; vegas_spread: number | null; ratings_margin: number; injury_term: number }[] = [];
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
    let p52: number | null = null;
    if (v52) {
      const hours = (Date.parse(g.kickoff_utc) - now.getTime()) / 3_600_000;
      p52 = predictV5(v52, { p1: pred.prob, pVegas: v1Row.vegas_prob, injuryPoints: adjFor52(opponent, snapshot_utc).points - adjFor52(m.yes_team, snapshot_utc).points, hoursToKickoff: hours });
      rows.push({ ...v1Row, model_version: v52.model_version, my_prob: p52 });
    }
    let p53: number | null = null;
    if (v53) {
      const hours = (Date.parse(g.kickoff_utc) - now.getTime()) / 3_600_000;
      const [y53, o53] = [adjFor53(m.yes_team, snapshot_utc), adjFor53(opponent, snapshot_utc)];
      p53 = predictV5(v53, { p1: pred.prob, pVegas: v1Row.vegas_prob, injuryPoints: o53.points - y53.points, hoursToKickoff: hours });
      rows.push({ ...v1Row, model_version: v53.model_version, my_prob: p53 });
      for (const a of [y53, o53]) for (const i of a.items) if (i.status === 'benched' || i.status === 'competition') log.info(`  v5.3 ${a.team} QB ${i.player} ${i.status} ${i.points.toFixed(1)} (${i.note})`);
    }
    if (m1 && !spreadRows.some((r) => r.game_id === g.game_id)) {
      const hours = (Date.parse(g.kickoff_utc) - now.getTime()) / 3_600_000;
      const pm = predictM1(m1, {
        home_team: g.home_team,
        away_team: g.away_team,
        neutral: g.neutral_site === 1,
        ratings,
        vegasSpread: spread,
        injuryPoints: adjFor51(g.away_team, snapshot_utc).points - adjFor51(g.home_team, snapshot_utc).points,
        hoursToKickoff: hours,
      });
      if (pm) {
        spreadRows.push({ game_id: g.game_id, snapshot_kind: kind, snapshot_utc, model_version: m1.model_version, home_margin: pm.home_margin, vegas_spread: spread, ratings_margin: pm.ratings_margin, injury_term: pm.injury_term });
        log.info(`  m1 ${g.home_team} ${(-pm.home_margin).toFixed(1)} (Vegas ${spread === null ? 'n/a' : spread}; ratings ${(-pm.ratings_margin).toFixed(1)}, injury ${pm.injury_term.toFixed(1)})`);
      }
    }
    if (ay.points > 0.05 || ao.points > 0.05 || ay.coach.length || ao.coach.length) log.info(`  v4 ${describe(ay)} | ${describe(ao)}`);
    const qbNote = [q.yes_qb, q.opp_qb].filter((x) => x && x.weight > 0).map((x) => `${x!.team} QB ${x!.player} ${x!.status}`);
    log.info(
      `${m.ticker}: ${m.yes_team} my=${pred.prob.toFixed(3)} v2=${q.prob.toFixed(3)} v3=${p3.toFixed(3)} v4=${p4.toFixed(3)} v4.1=${p41.toFixed(3)}${p5 === null ? '' : ` v5=${p5.toFixed(3)}`}${p51 === null ? '' : ` v5.1=${p51.toFixed(3)}`}${p52 === null ? '' : ` v5.2=${p52.toFixed(3)}`}${p53 === null ? '' : ` v5.3=${p53.toFixed(3)}`}${qbNote.length ? ` (${qbNote.join('; ')})` : ''} [${pred.sources_used.join(',')}] ` +
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

  const insertSpread = db.prepare(`
    INSERT ${kind === 'manual' ? '' : 'OR IGNORE'} INTO spread_forecasts
      (game_id, snapshot_kind, snapshot_utc, model_version, home_margin, vegas_spread, ratings_margin, injury_term)
    VALUES (@game_id, @snapshot_kind, @snapshot_utc, @model_version, @home_margin, @vegas_spread, @ratings_margin, @injury_term)`);

  let inserted = 0;
  let spreadInserted = 0;
  db.transaction(() => {
    upsertGames(db, games);
    upsertMarkets(db, selected.map((m) => ({ ticker: m.ticker, game_id: m.game.game_id, yes_team: m.yes_team, close_utc: m.close_utc })));
    saveStarters(db, season, starters.values()); // who starts, for the board's QB flags
    for (const r of rows) inserted += insert.run(r).changes;
    for (const r of spreadRows) spreadInserted += insertSpread.run(r).changes;
  })();
  if (m1) log.info(`spread forecasts: ${spreadInserted} inserted, ${spreadRows.length - spreadInserted} already present`);
  log.info(`forecasts: ${inserted} inserted, ${rows.length - inserted} already present (idempotent); CFBD calls this run: ${cfbd.callCount}`);
});
