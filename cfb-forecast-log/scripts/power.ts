/**
 * npm run power -- [--week N] [--out <file.json>]
 *
 * Power ratings from the model: every rated team's expected margin against an
 * average FBS team on a neutral field, ranked. Pure ratings: no Vegas line (there
 * is none for a team against "average") and no availability layer.
 *
 *   opponent  the FBS-average rating in each source that week
 *   p         v1-blend against that opponent: the mean of the per-source
 *             logistics (src/model/v1.ts) with home = 0, NOT clamped, so the
 *             best teams don't all pile up at the clamp
 *   tempered  sigmoid(logit(p) / temper), v3's divisor for v1's fit leak
 *   rating    vegas_std_dev * normalQuantile(tempered), in points, the same
 *             probability-to-margin step the export uses
 *
 * The order is the model's order; temper only changes the point scale.
 * Movement compares with the previous stored ratings week.
 *
 * Reads the database only. Writes no rows (hard rule 1 untouched), adds no
 * model_version (nothing is logged or scored), and exports only the blended
 * rating, never any source's own numbers (FEI stays local, hard rule 4).
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadModelConfig } from '../src/config';
import { openDb, loadRatings } from '../src/db';
import { loadEnv, optionalInt } from '../src/env';
import { log, runJob } from '../src/log';
import { assertFitted, sourceProb } from '../src/model/v1';
import { loadModelV3Config, logit } from '../src/model/v3';
import { normalQuantile } from '../src/projection';
import { seasonFor } from '../src/season';
import { SOURCES, type Source } from '../src/types';
import { mean, sigmoid } from '../src/util/math';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--') && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) args.set(a.slice(2), process.argv[++i]);
}
const OUT = args.get('out');
const round1 = (x: number) => Math.round(x * 10) / 10;

runJob('power', async () => {
  loadEnv();
  const model = loadModelConfig();
  assertFitted(model);
  const v3 = loadModelV3Config();
  const sd = model.constants.vegas_std_dev;
  const season = optionalInt('SEASON') ?? seasonFor(new Date());
  const db = openDb();

  const weeks = (db.prepare('SELECT DISTINCT week FROM ratings WHERE season = ? ORDER BY week').all(season) as { week: number }[]).map((r) => r.week);
  if (!weeks.length) throw new Error(`no ratings stored for ${season}; run \`npm run ratings\` first`);
  const week = args.has('week') ? Number(args.get('week')) : weeks[weeks.length - 1];
  if (!weeks.includes(week)) throw new Error(`no ratings stored for ${season} week ${week}`);
  const prevWeek = [...weeks].reverse().find((w) => w < week) ?? null;

  function rate(w: number) {
    const ratings = loadRatings(db, season, w);
    const used = SOURCES.filter((s) => ratings.get(s)?.size);
    if (used.length < model.constants.min_sources) throw new Error(`week ${w}: only ${used.length} rating sources stored`);
    const avg = new Map<Source, number>(used.map((s) => [s, mean([...ratings.get(s)!.values()])]));
    const teams = new Set(used.flatMap((s) => [...ratings.get(s)!.keys()]));
    const out: { team: string; rating: number; sources: number }[] = [];
    for (const team of teams) {
      const probs = used.flatMap((s) => {
        const r = ratings.get(s)!.get(team);
        return r === undefined ? [] : [sourceProb(model, s, r - avg.get(s)!, 0)];
      });
      if (probs.length < model.constants.min_sources) continue;
      const p = mean(probs);
      const tempered = sigmoid(logit(p) / v3.temper);
      out.push({ team, rating: sd * normalQuantile(tempered), sources: probs.length });
    }
    out.sort((a, b) => b.rating - a.rating);
    return { rows: out, sources: used, teams: teams.size };
  }

  const now = rate(week);
  const prev = prevWeek === null ? null : rate(prevWeek);
  const prevRank = new Map(prev?.rows.map((r, i) => [r.team, { rank: i + 1, rating: r.rating }]) ?? []);

  const games = db
    .prepare('SELECT home_team, away_team, home_points, away_points FROM games WHERE season = ? AND completed = 1 AND home_points IS NOT NULL')
    .all(season) as { home_team: string; away_team: string; home_points: number; away_points: number }[];
  const record = new Map<string, [number, number]>();
  for (const g of games) {
    for (const [t, us, them] of [
      [g.home_team, g.home_points, g.away_points],
      [g.away_team, g.away_points, g.home_points],
    ] as const) {
      const r = record.get(t) ?? [0, 0];
      if (us > them) r[0]++;
      else if (us < them) r[1]++;
      record.set(t, r);
    }
  }

  const rows = now.rows.map((r, i) => {
    const p = prevRank.get(r.team);
    const rec = record.get(r.team);
    return {
      rank: i + 1,
      team: r.team,
      rating: round1(r.rating),
      record: rec ? `${rec[0]}-${rec[1]}` : null,
      prevRank: p?.rank ?? null,
      prevRating: p ? round1(p.rating) : null,
      sources: r.sources,
    };
  });

  const doc = {
    generated: new Date().toISOString(),
    season,
    ratingsWeek: week,
    prevRatingsWeek: prevWeek,
    model: model.model_version,
    temper: v3.temper,
    sources: now.sources,
    method:
      `Each team's expected margin, in points, against an average rated team on a neutral field: ${model.model_version}'s per-source win probabilities ` +
      `(${now.sources.join(', ')}) averaged, unclamped, tempered by v3's ${v3.temper}, then through a normal curve with sd ${sd}. No Vegas line, no injuries.`,
    rows,
  };

  for (const r of rows.slice(0, 30)) {
    const move = r.prevRank === null ? 'new' : r.prevRank === r.rank ? '=' : r.prevRank > r.rank ? `+${r.prevRank - r.rank}` : `-${r.rank - r.prevRank}`;
    log.info(`${String(r.rank).padStart(3)} ${r.team.padEnd(20)} ${r.rating > 0 ? '+' : ''}${r.rating.toFixed(1).padStart(5)}  ${(r.record ?? '').padEnd(5)} ${move}`);
  }
  log.info(`${rows.length} teams, ratings week ${week} (previous ${prevWeek ?? 'none'}), sources ${now.sources.join(', ')}`);
  if (OUT) {
    fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
    fs.writeFileSync(path.resolve(OUT), JSON.stringify(doc, null, 2) + '\n');
    log.info(`wrote ${path.resolve(OUT)}`);
  } else {
    log.info('no --out given; nothing written');
  }
});
