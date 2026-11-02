/**
 * v2-qb helper CLI. Read-only: neither command writes forecasts.
 *   npm run v2:check     this week's starting QBs and which ones v2 would penalize right now
 *   npm run v2:backtest  re-score already-logged v1 rows as if v2 had been running
 *
 * The backtest is a rough preview, not a result: it uses today's season
 * pass-attempt leaders as "starters" (slight hindsight) and facts that were
 * extracted after the fact (though only ones published before each snapshot).
 * The real test is the v2-qb rows the snapshot jobs log from now on.
 */
import { openDb } from '../src/db';
import { log, runJob } from '../src/log';
import { adjustForQb, loadModelV2Config, starterStatus, startersFromAttempts } from '../src/model/v2';
import { accuracy } from '../src/score';
import { seasonContext } from '../src/jobs/context';

const cmd = process.argv[2];

if (cmd === 'check') {
  runJob('v2:check', async () => {
    const cfg = loadModelV2Config();
    const { cfbd, season, week, games } = await seasonContext();
    const db = openDb();
    const starters = startersFromAttempts(await cfbd.passAttempts(season), cfg.qb.min_starter_share);
    log.info(`starters found for ${starters.size} teams (season ${season})`);
    const now = new Date().toISOString();
    const thisWeek = games.filter((g) => g.week === week);
    let flagged = 0;
    for (const g of thisWeek) {
      for (const team of [g.home_team, g.away_team]) {
        const s = starterStatus(db, cfg, team, starters.get(team), now);
        if (s && s.weight > 0) {
          flagged += 1;
          console.log(`${team}: starter ${s.player} is ${s.status} (as of ${s.as_of.slice(0, 10)}) -> -${(cfg.qb.out_points * s.weight).toFixed(1)} pts. ${s.detail ?? ''}`);
        }
      }
    }
    // QB facts that did not attach to a starter: a backup, or a name the matcher missed.
    const since = new Date(Date.now() - cfg.qb.lookback_days * 86_400_000).toISOString();
    const loose = db
      .prepare(`SELECT DISTINCT team, player, status FROM news_facts WHERE position = 'QB' AND status IN ('out','doubtful') AND as_of >= ? AND team IS NOT NULL ORDER BY team`)
      .all(since) as { team: string; player: string | null; status: string }[];
    for (const f of loose) {
      const st = starters.get(f.team);
      const s = starterStatus(db, cfg, f.team, st, now);
      if (!s || s.player !== st?.player || s.weight === 0) {
        console.log(`  not applied: ${f.team} QB ${f.player ?? '?'} ${f.status} (starter on file: ${st?.player ?? 'none'}${s ? `, latest status ${s.status}` : ''})`);
      }
    }
    console.log(`\nweek ${week}: ${flagged} team(s) would get the QB penalty right now.`);
  });
} else if (cmd === 'backtest') {
  runJob('v2:backtest', async () => {
    const cfg = loadModelV2Config();
    const { cfbd, season } = await seasonContext();
    const db = openDb();
    const starters = startersFromAttempts(await cfbd.passAttempts(season), cfg.qb.min_starter_share);
    const rows = db
      .prepare(
        `SELECT f.snapshot_kind, f.snapshot_utc, f.my_prob, f.market_mid, f.vegas_prob, f.outcome, m.yes_team, g.home_team, g.away_team
           FROM forecasts f JOIN markets m ON m.ticker = f.ticker JOIN games g ON g.game_id = f.game_id
          WHERE f.model_version = ? AND f.snapshot_kind <> 'manual' AND f.outcome IS NOT NULL AND f.market_mid IS NOT NULL`,
      )
      .all(cfg.base_model_version) as { snapshot_kind: string; snapshot_utc: string; my_prob: number; market_mid: number; vegas_prob: number | null; outcome: 0 | 1; yes_team: string; home_team: string; away_team: string }[];
    for (const kind of ['tuesday', 'pregame']) {
      const ks = rows.filter((r) => r.snapshot_kind === kind);
      if (ks.length === 0) continue;
      const scored = ks.map((r) => {
        const opp = r.yes_team === r.home_team ? r.away_team : r.home_team;
        const q = adjustForQb(cfg, r.my_prob, starterStatus(db, cfg, r.yes_team, starters.get(r.yes_team), r.snapshot_utc), starterStatus(db, cfg, opp, starters.get(opp), r.snapshot_utc));
        return { ...r, v2: q.prob, changed: q.shift_logit !== 0 };
      });
      const b = (xs: typeof scored, f: (r: (typeof scored)[number]) => number) => accuracy(xs.map((r) => ({ p: f(r), y: r.outcome }))).brier ?? NaN;
      const changed = scored.filter((r) => r.changed);
      console.log(`\n${kind}: ${scored.length} rows, ${changed.length} changed by the QB penalty`);
      console.log(`  all rows      v1 ${b(scored, (r) => r.my_prob).toFixed(4)}  v2 ${b(scored, (r) => r.v2).toFixed(4)}  market ${b(scored, (r) => r.market_mid).toFixed(4)}`);
      if (changed.length > 0) {
        console.log(`  changed only  v1 ${b(changed, (r) => r.my_prob).toFixed(4)}  v2 ${b(changed, (r) => r.v2).toFixed(4)}  market ${b(changed, (r) => r.market_mid).toFixed(4)}`);
        for (const r of changed) console.log(`    ${r.yes_team} vs ${r.yes_team === r.home_team ? r.away_team : r.home_team}: v1 ${r.my_prob.toFixed(2)} -> v2 ${r.v2.toFixed(2)}, market ${r.market_mid.toFixed(2)}, ${r.outcome ? 'won' : 'lost'}`);
      }
    }
    console.log('\nRough preview only (see header). Lower Brier is better.');
  });
} else {
  console.error('usage: tsx scripts/v2.ts <check|backtest>');
  process.exit(2);
}
