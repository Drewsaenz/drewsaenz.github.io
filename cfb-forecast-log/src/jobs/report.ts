/**
 * Job: report (Mon 06:30)
 * Score all resolved, non-manual rows per (model_version, snapshot_kind),
 * print to stdout, and write reports/YYYY-WW.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_FOCUS_MODELS, loadScoringConfig } from '../config';
import { openDb } from '../db';
import { loadEnv } from '../env';
import { log, runJob } from '../log';
import { REPORTS_DIR } from '../paths';
import { isoWeekLabel } from '../season';
import { qbFlags } from '../news';
import { calibration, compareAccuracy, edgeDecay, groupBy, hypotheticalPnl, newsCheck, type ScoreRow } from '../score';

/** Short role label for a focus model's heading. */
function focusRole(model: string): string {
  if (model.startsWith('v5')) return 'main model';
  if (model.startsWith('v3')) return 'market baseline';
  if (model.startsWith('v1')) return 'raw ratings';
  return 'focus';
}

export function buildReport(rows: ScoreRow[], cfg = loadScoringConfig(), now = new Date(), flags: Map<number, string[]> = new Map()): string {
  const out: string[] = [];
  out.push(`# cfb-forecast-log report ${isoWeekLabel(now)}`, '', `Generated ${now.toISOString()}. Resolved non-manual rows: ${rows.length}.`, '');
  if (rows.length === 0) {
    out.push('_No resolved forecasts yet._', '');
    return out.join('\n');
  }

  const f = (x: number | null, d = 4) => (x === null ? 'n/a' : x.toFixed(d));
  const money = (x: number) => `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`;
  const summaries: string[] = [];

  // Focus models first, in the configured order; every other model after a divider, still scored in full.
  const focus = cfg.focus_models ?? DEFAULT_FOCUS_MODELS;
  const rank = (m: string) => (focus.includes(m) ? focus.indexOf(m) : focus.length);
  const groups = [...groupBy(rows, (r) => r.model_version)].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
  const others = groups.map(([m]) => m).filter((m) => !focus.includes(m));
  let dividerDone = false;
  for (const [model, modelRows] of groups) {
    const isFocus = focus.includes(model);
    if (!isFocus && !dividerDone && groups.some(([m]) => focus.includes(m))) {
      out.push('---', '', `## Also logged, not read: ${others.join(', ')}`, '', '_Still scored for the record. The summary covers the focus models only._', '');
      dividerDone = true;
    }
    out.push(`## Model ${model}${isFocus ? ` (${focusRole(model)})` : ''}`, '');
    const byKind = groupBy(modelRows, (r) => r.snapshot_kind);

    // 1. Accuracy
    out.push('### Brier / log loss', '', '| snapshot | N | my Brier | market Brier | vegas Brier | my logloss | market logloss | vegas logloss |', '|---|---:|---:|---:|---:|---:|---:|---:|');
    for (const [kind, kr] of byKind) {
      const a = compareAccuracy(kr);
      out.push(`| ${kind} | ${a.mine.n} | ${f(a.mine.brier)} | ${f(a.market.brier)} | ${f(a.vegas.brier)} | ${f(a.mine.logLoss)} | ${f(a.market.logLoss)} | ${f(a.vegas.logLoss)} |`);
    }
    out.push('');

    // 2. Calibration
    for (const [kind, kr] of byKind) {
      out.push(`### Calibration (${kind})`, '', '| bin | N | predicted | observed |', '|---|---:|---:|---:|');
      for (const b of calibration(kr.map((r) => ({ p: r.my_prob, y: r.outcome })), cfg.calibration_bins)) {
        out.push(`| ${(b.lo * 100).toFixed(0)}-${(b.hi * 100).toFixed(0)}% | ${b.n} | ${f(b.predicted, 3)} | ${f(b.observed, 3)} |`);
      }
      out.push('');
    }

    // 3. Hypothetical P&L
    out.push(`### Hypothetical P&L (1 contract, |edge| >= ${cfg.edge_min})`, '', '| snapshot | style | qualifying | wins | P&L | risked | ROI |', '|---|---|---:|---:|---:|---:|---:|');
    const pnlByKind = new Map<string, ReturnType<typeof hypotheticalPnl>>();
    for (const [kind, kr] of byKind) {
      const p = hypotheticalPnl(kr, cfg);
      pnlByKind.set(kind, p);
      out.push(`| ${kind} | taker | ${p.taker.n} | ${p.taker.wins} | ${money(p.taker.pnl)} | ${money(p.taker.risked)} | ${p.taker.roi === null ? 'n/a' : (p.taker.roi * 100).toFixed(1) + '%'} |`);
      out.push(`| ${kind} | maker | ${p.maker.n} | ${p.maker.wins} | ${money(p.maker.pnl)} | ${money(p.maker.risked)} | ${p.maker.roi === null ? 'n/a' : (p.maker.roi * 100).toFixed(1) + '%'} |`);
    }
    out.push('', `_${hypotheticalPnl([], cfg).maker_caveat}_`, '');

    // 4. Edge decay
    const d = edgeDecay(modelRows);
    out.push('### Edge decay (games with both tuesday and pregame rows)', '', '| snapshot | N | my Brier | market Brier | vegas Brier |', '|---|---:|---:|---:|---:|');
    out.push(`| tuesday | ${d.games} | ${f(d.tuesday.mine.brier)} | ${f(d.tuesday.market.brier)} | ${f(d.tuesday.vegas.brier)} |`);
    out.push(`| pregame | ${d.games} | ${f(d.pregame.mine.brier)} | ${f(d.pregame.market.brier)} | ${f(d.pregame.vegas.brier)} |`);
    out.push('');

    // 5. News check: which Tuesday gaps the market could explain, and what survives without them.
    const tuesRows = byKind.get('tuesday') ?? [];
    const nc = newsCheck(tuesRows, flags, cfg);
    out.push(`### News check (Tuesday rows: QB out/doubtful before kickoff, or model vs Vegas gap >= ${cfg.news_gap_min})`, '');
    out.push('| rows | N | my Brier | market Brier | maker P&L | taker P&L |', '|---|---:|---:|---:|---:|---:|');
    out.push(`| all | ${tuesRows.length} | ${f(compareAccuracy(tuesRows).mine.brier)} | ${f(compareAccuracy(tuesRows).market.brier)} | ${money(nc.allPnl.maker.pnl)} | ${money(nc.allPnl.taker.pnl)} |`);
    out.push(`| news-flagged | ${nc.flagged.length} | ${f(nc.flaggedAcc.mine.brier)} | ${f(nc.flaggedAcc.market.brier)} | ${money(nc.allPnl.maker.pnl - nc.cleanPnl.maker.pnl)} | ${money(nc.allPnl.taker.pnl - nc.cleanPnl.taker.pnl)} |`);
    out.push(`| clean | ${nc.clean.length} | ${f(nc.cleanAcc.mine.brier)} | ${f(nc.cleanAcc.market.brier)} | ${money(nc.cleanPnl.maker.pnl)} | ${money(nc.cleanPnl.taker.pnl)} |`, '');
    if (nc.flagged.length) {
      out.push('| flagged game | pick | model | Vegas | reason | result |', '|---|---|---:|---:|---|---|');
      const seen = new Set<string>();
      for (const r of nc.flagged) {
        const key = `${r.game_id}:${nc.reasons.get(r)}`;
        const label = r.home_team && r.away_team ? `${r.away_team} at ${r.home_team}` : `game ${r.game_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(`| ${label} | ${r.ticker ?? ''} | ${f(r.my_prob, 3)} | ${f(r.vegas_prob, 3)} | ${nc.reasons.get(r)} | ${r.outcome === 1 ? 'yes won' : 'yes lost'} |`);
      }
      out.push('');
    }

    // Summary lines: focus models only (all models when none of the focus models has graded rows yet).
    if (!isFocus && groups.some(([m]) => focus.includes(m))) continue;
    // Headline rows: Tuesday when the model has them; otherwise (a model added mid-week) its pregame rows.
    const kindUsed = byKind.has('tuesday') ? 'tuesday' : byKind.has('pregame') ? 'pregame' : null;
    const kindLabel = kindUsed === 'pregame' ? 'pregame (kickoff)' : 'Tuesday';
    const tues = (kindUsed && byKind.get(kindUsed)) || modelRows;
    const acc = compareAccuracy(tues);
    const beats = acc.mine.brier !== null && acc.market.brier !== null ? (acc.mine.brier < acc.market.brier ? 'beats' : 'does not beat') : 'cannot yet be compared to';
    summaries.push(`${model}: my Brier ${f(acc.mine.brier)} ${beats} the market's ${f(acc.market.brier)} on ${acc.mine.n} resolved ${kindLabel} rows.`);
    if (d.games > 0 && d.tuesday.mine.brier !== null && d.tuesday.market.brier !== null && d.pregame.mine.brier !== null && d.pregame.market.brier !== null) {
      const gapT = d.tuesday.mine.brier - d.tuesday.market.brier;
      const gapP = d.pregame.mine.brier - d.pregame.market.brier;
      const side = (g: number) => (g < 0 ? `the model beat the market by ${Math.abs(g).toFixed(4)}` : `the market beat the model by ${g.toFixed(4)}`);
      summaries.push(`${model}: on the ${d.games} games with both snapshots, ${side(gapT)} on Tuesday and ${side(gapP)} at kickoff (lower Brier wins).`);
    } else {
      summaries.push(`${model}: not enough games with both Tuesday and pregame rows to measure edge decay.`);
    }
    const mk = pnlByKind.get(kindUsed ?? 'tuesday')?.maker;
    summaries.push(
      mk && mk.n > 0
        ? `${model}: maker-only trading on the ${cfg.edge_min} edge filter would have made ${money(mk.pnl)} on ${mk.n} ${kindLabel} rows (ROI ${((mk.roi ?? 0) * 100).toFixed(1)}%, fills not guaranteed).`
        : `${model}: no ${kindLabel} rows cleared the ${cfg.edge_min} edge filter, so no hypothetical maker P&L.`,
    );
    if (nc.flagged.length > 0) {
      summaries.push(
        `${model}: ${nc.flagged.length} of ${tuesRows.length} Tuesday rows look news-driven; without them maker P&L is ${money(nc.cleanPnl.maker.pnl)} on ${nc.cleanPnl.maker.n} trades and my Brier is ${f(nc.cleanAcc.mine.brier)} vs market ${f(nc.cleanAcc.market.brier)}.`,
      );
    }
  }

  if (others.length && groups.some(([m]) => focus.includes(m))) summaries.push(`Also logged, not read: ${others.join(', ')} (full tables above the summary).`);
  out.push('## Summary', '', ...summaries.map((s) => `- ${s}`), '');
  return out.join('\n');
}

if (require.main === module) {
  runJob('report', async () => {
    loadEnv();
    const db = openDb();
    const rows = db
      .prepare(
        `SELECT f.game_id, f.ticker, f.snapshot_kind, f.model_version, f.my_prob, f.market_mid, f.vegas_prob, f.yes_bid, f.yes_ask, f.outcome,
                g.home_team, g.away_team, g.kickoff_utc
           FROM forecasts f JOIN games g ON g.game_id = f.game_id
          WHERE f.outcome IS NOT NULL AND f.snapshot_kind <> 'manual'`,
      )
      .all() as ScoreRow[];
    const now = new Date();
    const md = buildReport(rows, loadScoringConfig(), now, qbFlags(db));
    process.stdout.write(md);
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const file = path.join(REPORTS_DIR, `${isoWeekLabel(now)}.md`);
    fs.writeFileSync(file, md);
    log.info(`wrote ${file}`);
  });
}
