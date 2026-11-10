/**
 * npm run export -- [--team Texas] [--out <file.json>]
 *
 * One team's remaining regular-season games with the model's win probability and
 * a projected score (src/projection.ts), as JSON for another project to read
 * (Drew's Texas season book). Reads the database and CFBD's cache; writes no
 * rows (hard rule 1 untouched) and exports only probabilities and scores, never
 * the FEI numbers themselves.
 *
 * The probability is the latest scheduled (non-manual) v4-avail row for that
 * game when one is logged (this week's game, once the Tuesday snapshot has run),
 * else v1-blend on the latest stored ratings. v4's availability inputs only
 * cover the coming game, so later weeks are ratings-only.
 *
 * CFBD budget: the schedule and SP+ come from the jobs' cache; lines are one
 * call per remaining week (cached an hour).
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadModelConfig } from '../src/config';
import { openDb, loadRatings } from '../src/db';
import { loadEnv, optionalInt, requireEnv } from '../src/env';
import { log, runJob } from '../src/log';
import { assertFitted, homeIndicator, predictV1, vegasProb } from '../src/model/v1';
import { loadModelV4Config } from '../src/model/v4';
import { probToMargin, spPoints, splitScore } from '../src/projection';
import { seasonFor } from '../src/season';
import { CfbdClient } from '../src/sources/cfbd';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--') && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) args.set(a.slice(2), process.argv[++i]);
}
const TEAM = args.get('team') ?? 'Texas';
const OUT = args.get('out');

const round1 = (x: number) => Math.round(x * 10) / 10;
const round3 = (x: number) => Math.round(x * 1000) / 1000;

runJob('export', async () => {
  loadEnv();
  const model = loadModelConfig();
  assertFitted(model);
  const v4 = loadModelV4Config();
  const sd = model.constants.vegas_std_dev;
  const now = new Date();
  const cfbd = new CfbdClient(requireEnv('CFBD_API_KEY'));
  const season = optionalInt('SEASON') ?? seasonFor(now);
  const games = await cfbd.games(season);

  const db = openDb();
  const { week: ratingsWeek } = db.prepare('SELECT MAX(week) AS week FROM ratings WHERE season = ?').get(season) as { week: number | null };
  if (ratingsWeek === null) throw new Error(`no ratings stored for ${season}; run \`npm run ratings\` first`);
  const ratings = loadRatings(db, season, ratingsWeek);
  const sp = await cfbd.spUnits(season);

  const left = games
    .filter((g) => (g.home_team === TEAM || g.away_team === TEAM) && !g.completed && Date.parse(g.kickoff_utc) > now.getTime())
    .sort((a, b) => a.kickoff_utc.localeCompare(b.kickoff_utc));
  if (left.length === 0) log.info(`${TEAM} has no games left in ${season}`);

  const lines = new Map<number, { spread: number | null; total: number | null; provider: string | null }>();
  for (const w of new Set(left.map((g) => g.week))) for (const l of await cfbd.lines(season, w)) lines.set(l.game_id, l);

  const logged = db.prepare(`
    SELECT f.my_prob, f.snapshot_kind, f.snapshot_utc, f.market_mid
      FROM forecasts f JOIN markets m ON m.ticker = f.ticker
     WHERE f.game_id = ? AND m.yes_team = ? AND f.model_version = ? AND f.snapshot_kind <> 'manual'
     ORDER BY f.snapshot_utc DESC LIMIT 1`);

  const out = [];
  for (const g of left) {
    const isHome = g.home_team === TEAM;
    const opponent = isHome ? g.away_team : g.home_team;
    const home = homeIndicator(TEAM, g.home_team, g.neutral_site === 1);
    const v1 = predictV1(model, { yes_team: TEAM, opponent, home, ratings });
    if (!v1) throw new Error(`fewer than ${model.constants.min_sources} rating sources cover ${TEAM} vs ${opponent}`);
    const row = logged.get(g.game_id, TEAM, v4.model_version) as { my_prob: number; snapshot_kind: string; snapshot_utc: string; market_mid: number | null } | undefined;
    const prob = row?.my_prob ?? v1.prob;
    const margin = probToMargin(prob, sd);

    const us = sp.teams.get(TEAM);
    const them = sp.teams.get(opponent);
    if (!us || !them) throw new Error(`SP+ has no offense/defense for ${!us ? TEAM : opponent}`);
    const spTotal = spPoints(us.off, them.def, sp.avg) + spPoints(them.off, us.def, sp.avg);
    const line = lines.get(g.game_id);
    const total = line?.total ?? spTotal;
    const score = splitScore(total, margin);

    out.push({
      gameId: g.game_id,
      week: g.week,
      kickoff: g.kickoff_utc,
      opponent,
      site: g.neutral_site ? 'neutral' : isHome ? 'home' : 'away',
      model: row ? v4.model_version : model.model_version,
      modelAt: row ? `${row.snapshot_kind} ${row.snapshot_utc}` : `ratings week ${ratingsWeek}`,
      winProb: round3(prob),
      v1Prob: round3(v1.prob),
      margin: round1(margin),
      total: round1(total),
      totalSource: line?.total != null ? `vegas (${line.provider})` : 'sp+',
      spTotal: round1(spTotal),
      score: { team: round1(score.team), opp: round1(score.opp) },
      vegas: line?.spread != null ? { margin: round1(isHome ? -line.spread : line.spread), total: line.total, winProb: round3(vegasProb(model, line.spread, isHome)), provider: line.provider } : null,
      kalshi: row?.market_mid ?? null,
    });
  }

  const doc = {
    generated: now.toISOString(),
    team: TEAM,
    season,
    ratingsWeek,
    sources: [...ratings.keys()].sort(),
    method:
      'Win probability from the cfb-forecast-log model (v4-avail when this week\'s snapshot is logged, else v1-blend on the latest ratings). ' +
      `Margin = that probability through a normal curve with sd ${sd}. Total = the Vegas over/under when posted, else SP+ offense plus the opponent's SP+ defense minus the national average, both sides.`,
    games: out,
  };

  for (const r of out) {
    log.info(
      `wk${r.week} ${r.site === 'away' ? 'at' : 'vs'} ${r.opponent}: ${(r.winProb * 100).toFixed(0)}% (${r.model}) ` +
        `${TEAM} ${Math.round(r.score.team)}-${Math.round(r.score.opp)} [margin ${r.margin > 0 ? '+' : ''}${r.margin}, total ${r.total} ${r.totalSource}, sp+ total ${r.spTotal}]` +
        (r.vegas ? ` vegas ${r.vegas.margin > 0 ? '+' : ''}${r.vegas.margin}/${r.vegas.total ?? '-'}` : ''),
    );
  }
  if (OUT) {
    fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
    fs.writeFileSync(path.resolve(OUT), JSON.stringify(doc, null, 2) + '\n');
    log.info(`wrote ${path.resolve(OUT)}; CFBD calls this run: ${cfbd.callCount}`);
  } else {
    log.info(`no --out given; nothing written. CFBD calls this run: ${cfbd.callCount}`);
  }
});
