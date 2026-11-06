/**
 * v4-avail helper CLI. Read-only: writes no forecasts.
 *   npm run v4:check [-- --all] [--v41]   this week's games where v4 (or v4.1) moves v1, with the reasons
 *
 * Uses the v1 probabilities and Kalshi prices from the latest Tuesday, report or
 * manual snapshot, and today's facts, so it shows what v4 would say right now.
 */
import { openDb } from '../src/db';
import { log, runJob } from '../src/log';
import { seasonContext } from '../src/jobs/context';
import { startersFromAttempts } from '../src/model/v2';
import { loadModelV4Config, predictV4, type TeamAdjustment } from '../src/model/v4';
import { adjustmentFor, loadV4Inputs } from '../src/model/v4-inputs';

const all = process.argv.includes('--all');
const v41 = process.argv.includes('--v41');
const label = v41 ? 'v4.1' : 'v4';

runJob('v4:check', async () => {
  const cfg = loadModelV4Config(v41 ? 'model-v4.1.json' : undefined);
  const { cfbd, season, week } = await seasonContext();
  const db = openDb();
  const latest = db.prepare(`SELECT MAX(snapshot_utc) AS s FROM forecasts WHERE snapshot_kind IN ('tuesday','report','manual')`).get() as { s: string | null };
  if (!latest.s) throw new Error('no snapshot yet');
  const rows = db
    .prepare(
      `SELECT f.ticker, f.my_prob, f.market_mid, f.vegas_prob, m.yes_team, g.home_team, g.away_team, g.kickoff_utc, g.week
         FROM forecasts f JOIN markets m ON m.ticker = f.ticker JOIN games g ON g.game_id = f.game_id
        WHERE f.snapshot_utc = ? AND f.model_version = ? AND g.week = ? AND g.kickoff_utc > ?
        ORDER BY g.kickoff_utc`,
    )
    .all(latest.s, cfg.base_model_version, week, new Date().toISOString()) as {
    ticker: string; my_prob: number; market_mid: number | null; vegas_prob: number | null; yes_team: string; home_team: string; away_team: string; kickoff_utc: string;
  }[];
  const inputs = await loadV4Inputs(cfbd, cfg, season, week);
  const starters = startersFromAttempts(await cfbd.passAttempts(season), cfg.qb.min_starter_share);
  const now = new Date().toISOString();
  const cache = new Map<string, TeamAdjustment>();
  const adj = (t: string) => cache.get(t) ?? cache.set(t, adjustmentFor(db, cfg, inputs, starters, t, now)).get(t)!;
  const pct = (x: number | null) => (x === null ? '  n/a' : `${(x * 100).toFixed(0).padStart(3)}%`);

  // One line per game: the home side's market.
  const games = rows.filter((r) => r.yes_team === r.home_team);
  const out: { line: string; detail: string[]; move: number }[] = [];
  for (const r of games) {
    const yes = adj(r.yes_team);
    const opp = adj(r.away_team);
    const p4 = predictV4(cfg, r.my_prob, yes, opp);
    const move = p4 - r.my_prob;
    const detail: string[] = [];
    for (const a of [yes, opp]) {
      if (a.points < 0.05 && a.coach.length === 0) continue;
      detail.push(`    ${a.team}: -${a.points.toFixed(1)} pts`);
      for (const i of a.items.slice(0, 6)) detail.push(`      ${i.player} (${i.group}) ${i.status}: ${i.points.toFixed(1)}  [${i.note}]`);
      if (a.items.length > 6) detail.push(`      ...and ${a.items.length - 6} more, ${a.items.slice(6).reduce((n, i) => n + i.points, 0).toFixed(1)} pts`);
      for (const c of a.coach) detail.push(`      coaching change (${c.role}): ${c.detail.slice(0, 110)}`);
    }
    out.push({ line: `${r.away_team} at ${r.home_team}: home v1 ${pct(r.my_prob)} -> ${label} ${pct(p4)} (${move >= 0 ? '+' : ''}${(move * 100).toFixed(1)}), Kalshi ${pct(r.market_mid)}, Vegas ${pct(r.vegas_prob)}`, detail, move });
  }
  out.sort((a, b) => Math.abs(b.move) - Math.abs(a.move));
  const shown = all ? out : out.filter((o) => Math.abs(o.move) >= 0.005);
  console.log(`${label} vs v1 for week ${week} (v1 and prices from the ${latest.s} snapshot; facts as of now)\n`);
  for (const o of shown) {
    console.log(o.line);
    for (const d of o.detail) console.log(d);
  }
  log.info(`${out.length} game(s), ${out.filter((o) => Math.abs(o.move) >= 0.005).length} moved by ${label}`);
});
