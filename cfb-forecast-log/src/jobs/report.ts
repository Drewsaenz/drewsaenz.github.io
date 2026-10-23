/**
 * Job: report (Mon 06:30)
 * Score all resolved, non-manual rows per (model_version, snapshot_kind),
 * print to stdout, and write reports/YYYY-WW.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadScoringConfig } from '../config';
import { openDb } from '../db';
import { loadEnv } from '../env';
import { log, runJob } from '../log';
import { REPORTS_DIR } from '../paths';
import { isoWeekLabel } from '../season';
import { calibration, compareAccuracy, edgeDecay, groupBy, hypotheticalPnl, type ScoreRow } from '../score';

export function buildReport(rows: ScoreRow[], cfg = loadScoringConfig(), now = new Date()): string {
  const out: string[] = [];
  out.push(`# cfb-forecast-log report ${isoWeekLabel(now)}`, '', `Generated ${now.toISOString()}. Resolved non-manual rows: ${rows.length}.`, '');
  if (rows.length === 0) {
    out.push('_No resolved forecasts yet._', '');
    return out.join('\n');
  }

  const f = (x: number | null, d = 4) => (x === null ? 'n/a' : x.toFixed(d));
  const money = (x: number) => `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`;
  const summaries: string[] = [];

  for (const [model, modelRows] of groupBy(rows, (r) => r.model_version)) {
    out.push(`## Model ${model}`, '');
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

    // Summary lines
    const tues = byKind.get('tuesday') ?? modelRows;
    const acc = compareAccuracy(tues);
    const beats = acc.mine.brier !== null && acc.market.brier !== null ? (acc.mine.brier < acc.market.brier ? 'beats' : 'does not beat') : 'cannot yet be compared to';
    summaries.push(`${model}: my Brier ${f(acc.mine.brier)} ${beats} the market's ${f(acc.market.brier)} on ${acc.mine.n} resolved Tuesday rows.`);
    if (d.games > 0 && d.tuesday.mine.brier !== null && d.tuesday.market.brier !== null && d.pregame.mine.brier !== null && d.pregame.market.brier !== null) {
      const gapT = d.tuesday.mine.brier - d.tuesday.market.brier;
      const gapP = d.pregame.mine.brier - d.pregame.market.brier;
      summaries.push(`${model}: the Brier gap vs market goes from ${gapT.toFixed(4)} on Tuesday to ${gapP.toFixed(4)} pregame (${Math.abs(gapP) < Math.abs(gapT) ? 'shrinking' : 'not shrinking'}) over ${d.games} games.`);
    } else {
      summaries.push(`${model}: not enough games with both Tuesday and pregame rows to measure edge decay.`);
    }
    const mk = pnlByKind.get('tuesday')?.maker;
    summaries.push(
      mk && mk.n > 0
        ? `${model}: maker-only trading on the ${cfg.edge_min} edge filter would have made ${money(mk.pnl)} on ${mk.n} Tuesday rows (ROI ${((mk.roi ?? 0) * 100).toFixed(1)}%, fills not guaranteed).`
        : `${model}: no Tuesday rows cleared the ${cfg.edge_min} edge filter, so no hypothetical maker P&L.`,
    );
  }

  out.push('## Summary', '', ...summaries.map((s) => `- ${s}`), '');
  return out.join('\n');
}

if (require.main === module) {
  runJob('report', async () => {
    loadEnv();
    const db = openDb();
    const rows = db
      .prepare(
        `SELECT game_id, ticker, snapshot_kind, model_version, my_prob, market_mid, vegas_prob, yes_bid, yes_ask, outcome
           FROM forecasts WHERE outcome IS NOT NULL AND snapshot_kind <> 'manual'`,
      )
      .all() as ScoreRow[];
    const now = new Date();
    const md = buildReport(rows, loadScoringConfig(), now);
    process.stdout.write(md);
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const file = path.join(REPORTS_DIR, `${isoWeekLabel(now)}.md`);
    fs.writeFileSync(file, md);
    log.info(`wrote ${file}`);
  });
}
