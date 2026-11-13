/**
 * Season results for the tracker page: stat tiles plus three charts (Brier by
 * week, cumulative hypothetical P&L, calibration), all from resolved Tuesday
 * rows. Charts are inline SVG so the page stays one self-contained file.
 * Colors follow the dataviz reference palette (slots 1-3), validated against
 * the tracker's card surfaces; every chart has a legend or title naming its
 * series and a table view.
 */
import { DEFAULT_FOCUS_MODELS, type ScoringConfig } from './config';
import type { Db } from './db';
import { calibration, compareAccuracy, groupBy, hypotheticalPnl, onePerGame, rowTrade, type AccuracyComparison, type CalibrationBin, type PnlReport, type ScoreRow } from './score';

export interface ResultRow extends ScoreRow {
  season: number;
  week: number;
  kickoff_utc: string;
  yes_team: string;
}

export interface WeekPoint {
  label: string;
  acc: AccuracyComparison;
}

export interface TradePoint {
  n: number;
  label: string;
  taker: number; // cumulative dollars
  maker: number;
}

export interface ResultsView {
  modelVersion: string;
  rows: number;
  overall: AccuracyComparison;
  pnl: PnlReport;
  weeks: WeekPoint[];
  trades: TradePoint[];
  calibration: CalibrationBin[];
}

export function collectResults(db: Db, cfg: ScoringConfig): ResultsView | null {
  // The first focus model with graded Tuesday rows; a model added mid-season has none yet, so fall
  // through the list, and to the model with the most graded rows when no focus model has any.
  const graded = db
    .prepare(`SELECT model_version, COUNT(*) AS n FROM forecasts WHERE snapshot_kind = 'tuesday' AND outcome IS NOT NULL GROUP BY 1 ORDER BY n DESC`)
    .all() as { model_version: string; n: number }[];
  const focus = cfg.focus_models ?? DEFAULT_FOCUS_MODELS;
  const top = focus.map((m) => graded.find((g) => g.model_version === m)).find(Boolean) ?? graded[0];
  if (!top) return null;
  const rows = db
    .prepare(
      `SELECT f.game_id, f.ticker, f.snapshot_kind, f.model_version, f.my_prob, f.market_mid, f.vegas_prob, f.yes_bid, f.yes_ask, f.outcome,
              g.season, g.week, g.kickoff_utc, m.yes_team
         FROM forecasts f JOIN games g ON g.game_id = f.game_id JOIN markets m ON m.ticker = f.ticker
        WHERE f.snapshot_kind = 'tuesday' AND f.outcome IS NOT NULL AND f.model_version = ?
        ORDER BY g.kickoff_utc, f.ticker`,
    )
    .all(top.model_version) as ResultRow[];
  return buildResults(top.model_version, onePerGame(rows), cfg);
}

export function buildResults(modelVersion: string, rows: ResultRow[], cfg: ScoringConfig): ResultsView {
  const weeks = [...groupBy(rows, (r) => `${r.season}-${String(r.week).padStart(2, '0')}`).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, wr]) => ({ label: `Wk ${wr[0].week}`, acc: compareAccuracy(wr) }));
  const trades: TradePoint[] = [];
  let taker = 0;
  let maker = 0;
  for (const r of rows) {
    const t = rowTrade(r, cfg);
    if (typeof t === 'string') continue;
    taker += t.takerPnl;
    maker += t.makerPnl;
    const team = t.side === 'yes' ? r.yes_team : `not ${r.yes_team}`;
    trades.push({ n: trades.length + 1, label: `Wk ${r.week} · ${team} · ${t.won ? 'won' : 'lost'}`, taker, maker });
  }
  return {
    modelVersion,
    rows: rows.length,
    overall: compareAccuracy(rows),
    pnl: hypotheticalPnl(rows, cfg),
    weeks,
    trades,
    calibration: calibration(rows.map((r) => ({ p: r.my_prob, y: r.outcome })), cfg.calibration_bins),
  };
}

// ---------------------------------------------------------------- rendering

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const money = (x: number) => `${x < 0 ? '−' : '+'}$${Math.abs(x).toFixed(2)}`;
const f3 = (x: number | null) => (x === null ? 'n/a' : x.toFixed(3));
const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);

interface Series {
  name: string;
  color: string; // CSS var
  values: (number | null)[];
  tips: string[];
}

/** Nice round tick values covering [lo, hi]. */
export function niceTicks(lo: number, hi: number, target = 4): number[] {
  if (lo === hi) {
    const pad = Math.abs(lo) * 0.1 || 1;
    lo -= pad;
    hi += pad;
  }
  const raw = (hi - lo) / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const out: number[] = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toFixed(10)));
  if (out[out.length - 1] < hi) out.push(Number((out[out.length - 1] + step).toFixed(10)));
  return out;
}

const W = 640;
const H = 230;
const M = { l: 52, r: 16, t: 12, b: 30 };

function lineChart(opts: { series: Series[]; xLabels: string[]; xTickEvery?: number; yFmt: (v: number) => string; zero?: boolean; dots: 'all' | 'end'; label: string }): string {
  const all = opts.series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (opts.zero) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  const ticks = niceTicks(lo, hi);
  const y0 = ticks[0];
  const y1 = ticks[ticks.length - 1];
  const n = opts.xLabels.length;
  const pw = W - M.l - M.r;
  const ph = H - M.t - M.b;
  const x = (i: number) => (n === 1 ? M.l + pw / 2 : M.l + (pw * i) / (n - 1));
  const y = (v: number) => M.t + ph - ((v - y0) / (y1 - y0)) * ph;

  const grid = ticks
    .map((t) => `<line x1="${M.l}" x2="${W - M.r}" y1="${y(t)}" y2="${y(t)}" class="${opts.zero && t === 0 ? 'base' : 'grid'}"/><text x="${M.l - 8}" y="${y(t) + 4}" class="tick" text-anchor="end">${esc(opts.yFmt(t))}</text>`)
    .join('');
  const every = opts.xTickEvery ?? 1;
  const xt = opts.xLabels
    .map((l, i) => (i % every === 0 || i === n - 1 ? `<text x="${x(i)}" y="${H - 8}" class="tick" text-anchor="middle">${esc(l)}</text>` : ''))
    .join('');
  const marks = opts.series
    .map((s) => {
      const pts = s.values.map((v, i) => (v === null ? null : [x(i), y(v)] as const));
      const segs: string[] = [];
      let cur: string[] = [];
      for (const p of pts) {
        if (p) cur.push(`${p[0].toFixed(1)},${p[1].toFixed(1)}`);
        else if (cur.length) (segs.push(cur.join(' ')), (cur = []));
      }
      if (cur.length) segs.push(cur.join(' '));
      const lines = segs.filter((sg) => sg.includes(' ')).map((sg) => `<polyline points="${sg}" fill="none" stroke="var(${s.color})" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`).join('');
      const lastIdx = pts.map((p, i) => (p ? i : -1)).filter((i) => i >= 0).pop();
      const dots = pts
        .map((p, i) => (p && (opts.dots === 'all' || i === lastIdx) ? `<circle cx="${p[0]}" cy="${p[1]}" r="4" fill="var(${s.color})" class="ring"/>` : ''))
        .join('');
      return lines + dots;
    })
    .join('');
  // Hit targets: one invisible column per x position carrying every series' value.
  const colW = n === 1 ? pw : pw / (n - 1);
  const hits = opts.xLabels
    .map((l, i) => {
      const tip = [l, ...opts.series.map((s) => s.tips[i]).filter(Boolean)].join('\n');
      return `<rect x="${x(i) - colW / 2}" y="${M.t}" width="${colW}" height="${ph}" class="hit" data-tip="${esc(tip)}" data-x="${x(i)}"/>`;
    })
    .join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label)}" class="chart">${grid}${xt}<line class="xhair" x1="0" x2="0" y1="${M.t}" y2="${M.t + ph}"/>${marks}${hits}</svg>`;
}

function calibrationChart(bins: CalibrationBin[]): string {
  const S = 260;
  const m = { l: 44, r: 12, t: 10, b: 34 };
  const pw = S - m.l - m.r;
  const ph = S - m.t - m.b;
  const x = (v: number) => m.l + v * pw;
  const y = (v: number) => m.t + ph - v * ph;
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const grid = ticks
    .map(
      (t) =>
        `<line x1="${x(0)}" x2="${x(1)}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${m.l - 6}" y="${y(t) + 4}" class="tick" text-anchor="end">${t * 100}%</text>` +
        `<text x="${x(t)}" y="${S - 18}" class="tick" text-anchor="middle">${t * 100}%</text>`,
    )
    .join('');
  const diag = `<line x1="${x(0)}" y1="${y(0)}" x2="${x(1)}" y2="${y(1)}" class="ref"/>`;
  const dots = bins
    .filter((b) => b.n > 0)
    .map((b) => {
      const tip = `Model said ${(b.lo * 100).toFixed(0)}–${(b.hi * 100).toFixed(0)}%\nAverage forecast ${pct(b.predicted)}\nActually won ${pct(b.observed)}\n${b.n} picks`;
      return `<circle cx="${x(b.predicted!)}" cy="${y(b.observed!)}" r="5" fill="var(--s1)" class="ring"/><circle cx="${x(b.predicted!)}" cy="${y(b.observed!)}" r="12" class="hitc" data-tip="${esc(tip)}"/>`;
    })
    .join('');
  return `<svg viewBox="0 0 ${S} ${S}" role="img" aria-label="Calibration: forecast vs actual win rate" class="chart calib">${grid}${diag}${dots}<text x="${x(0.5)}" y="${S - 2}" class="tick" text-anchor="middle">Model's forecast</text><text transform="translate(10 ${y(0.5)}) rotate(-90)" class="tick" text-anchor="middle">Actually won</text></svg>`;
}

const legend = (items: { name: string; color: string }[]) =>
  `<div class="legend">${items.map((i) => `<span><i style="background:var(${i.color})"></i>${esc(i.name)}</span>`).join('')}</div>`;

const table = (head: string[], body: string[][]) =>
  `<details><summary>Show table</summary><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${body
    .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></details>`;

export function renderResults(r: ResultsView): string {
  const o = r.overall;
  const best = [
    ['Model', o.mine.brier],
    ['Kalshi', o.market.brier],
    ['Vegas', o.vegas.brier],
  ].filter((b): b is [string, number] => b[1] !== null).sort((a, b) => a[1] - b[1])[0]?.[0];
  const tile = (label: string, value: string, sub: string, lead = false) =>
    `<div class="tile${lead ? ' lead' : ''}"><div class="tl">${esc(label)}</div><div class="tv">${esc(value)}</div><div class="ts">${esc(sub)}</div></div>`;
  const tiles = `<div class="tiles">
    ${tile('Model Brier', f3(o.mine.brier), best === 'Model' ? 'Most accurate so far' : `Behind ${best}`, best === 'Model')}
    ${tile('Kalshi Brier', f3(o.market.brier), `${o.market.n} picks`)}
    ${tile('Vegas Brier', f3(o.vegas.brier), `${o.vegas.n} picks`)}
    ${tile('Hypothetical P&L', money(r.pnl.taker.pnl), `${r.pnl.taker.n} taker trades · ROI ${pct(r.pnl.taker.roi)}`)}
  </div>`;

  const S3 = [
    { name: 'Model', color: '--s1' },
    { name: 'Kalshi', color: '--s2' },
    { name: 'Vegas', color: '--s3' },
  ];
  const weekChart = lineChart({
    label: 'Brier score by week, lower is better',
    xLabels: r.weeks.map((w) => w.label),
    yFmt: (v) => v.toFixed(3),
    dots: 'all',
    series: [
      { ...S3[0], values: r.weeks.map((w) => w.acc.mine.brier), tips: r.weeks.map((w) => `Model ${f3(w.acc.mine.brier)}`) },
      { ...S3[1], values: r.weeks.map((w) => w.acc.market.brier), tips: r.weeks.map((w) => `Kalshi ${f3(w.acc.market.brier)}`) },
      { ...S3[2], values: r.weeks.map((w) => w.acc.vegas.brier), tips: r.weeks.map((w) => `Vegas ${f3(w.acc.vegas.brier)}`) },
    ],
  });
  const weekTable = table(
    ['Week', 'Picks', 'Model', 'Kalshi', 'Vegas'],
    r.weeks.map((w) => [w.label, String(w.acc.mine.n), f3(w.acc.mine.brier), f3(w.acc.market.brier), f3(w.acc.vegas.brier)]),
  );

  const P2 = [
    { name: 'Taker (pay the ask + fee)', color: '--s1' },
    { name: 'Maker (fill at the bid, not guaranteed)', color: '--s2' },
  ];
  const pnlChart = r.trades.length
    ? lineChart({
        label: 'Cumulative hypothetical profit, one contract per trade',
        xLabels: r.trades.map((t) => `#${t.n}`),
        xTickEvery: Math.max(1, Math.ceil(r.trades.length / 6)),
        yFmt: (v) => `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(v !== 0 && Math.abs(v) < 1 ? 2 : 0)}`,
        zero: true,
        dots: 'end',
        series: [
          { ...P2[0], values: r.trades.map((t) => t.taker), tips: r.trades.map((t) => `${t.label}\nTaker total ${money(t.taker)}`) },
          { ...P2[1], values: r.trades.map((t) => t.maker), tips: r.trades.map((t) => `Maker total ${money(t.maker)}`) },
        ],
      })
    : '<p class="small">No trades cleared the edge filter yet.</p>';
  const pnlTable = table(
    ['Trade', 'Pick', 'Taker total', 'Maker total'],
    r.trades.map((t) => [`#${t.n}`, t.label, money(t.taker), money(t.maker)]),
  );

  const calTable = table(
    ['Forecast range', 'Picks', 'Avg forecast', 'Actually won'],
    r.calibration.map((b) => [`${(b.lo * 100).toFixed(0)}–${(b.hi * 100).toFixed(0)}%`, String(b.n), pct(b.predicted), pct(b.observed)]),
  );

  return `
<h2 class="sec">Results so far <span class="small">${esc(r.modelVersion)} · ${r.rows} graded Tuesday picks</span></h2>
${tiles}
<section class="card">
  <div class="label">Accuracy by week</div>
  <div class="small">Brier score, lower is better. The model is ahead when its line sits below the other two.</div>
  ${legend(S3)}
  ${weekChart}
  ${weekTable}
</section>
<section class="card">
  <div class="label">Hypothetical profit</div>
  <div class="small">Running total if you had bought one contract whenever the model and Kalshi disagreed by ${(r.pnl.edge_min * 100).toFixed(0)} points or more.</div>
  ${legend(P2)}
  ${pnlChart}
  ${pnlTable}
</section>
<section class="card">
  <div class="label">Calibration</div>
  <div class="small">Each dot is a forecast range. On the diagonal means the model's percentages came true as often as it said. Below the line means overconfident. Bins with few picks bounce around a lot.</div>
  ${calibrationChart(r.calibration)}
  ${calTable}
</section>`;
}

export const RESULTS_CSS = `
:root{--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--grid:#e1e0d9;--axis:#c3c2b7;--tick:#898781}
@media (prefers-color-scheme:dark){:root{--s1:#3987e5;--s2:#d95926;--s3:#199e70;--grid:#2c2c2a;--axis:#383835}}
h2.sec{font-size:17px;margin:28px 0 10px}h2.sec .small{font-weight:400;margin-left:6px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:16px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.tl{font-size:12px;color:var(--muted)}.tv{font-size:24px;font-weight:650;margin:2px 0}.ts{font-size:12px;color:var(--muted)}
.tile.lead{border-color:var(--s1)}
.legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin:10px 0 4px;font-size:13px;color:var(--muted)}
.legend i{display:inline-block;width:14px;height:3px;border-radius:2px;margin-right:6px;vertical-align:middle}
svg.chart{width:100%;height:auto;display:block;margin-top:4px;overflow:visible}svg.calib{max-width:340px}
.chart .grid{stroke:var(--grid);stroke-width:1}.chart .base{stroke:var(--axis);stroke-width:1}
.chart .ref{stroke:var(--axis);stroke-width:1.5}
.chart .tick{fill:var(--tick);font-size:11px;font-variant-numeric:tabular-nums}
.chart .ring{stroke:var(--card);stroke-width:2}
.chart .hit,.chart .hitc{fill:transparent;cursor:crosshair}
.chart .xhair{stroke:var(--axis);stroke-width:1;visibility:hidden}
details{margin-top:8px;font-size:13px}summary{cursor:pointer;color:var(--muted)}
details table{margin-top:6px}
#tip{position:fixed;pointer-events:none;background:var(--ink);color:var(--card);font-size:12px;line-height:1.4;padding:6px 8px;border-radius:6px;white-space:pre;z-index:10;display:none;max-width:280px}
`;

export const RESULTS_JS = `
(function(){var tip=document.getElementById('tip');if(!tip)return;
function hide(){tip.style.display='none';document.querySelectorAll('.xhair').forEach(function(l){l.style.visibility='hidden'});}
document.addEventListener('pointermove',function(e){var t=e.target.closest&&e.target.closest('[data-tip]');
if(!t){hide();return;}tip.textContent=t.getAttribute('data-tip');tip.style.display='block';
var x=e.clientX+14,y=e.clientY+14;if(x+tip.offsetWidth>innerWidth-8)x=e.clientX-tip.offsetWidth-14;if(y+tip.offsetHeight>innerHeight-8)y=e.clientY-tip.offsetHeight-14;
tip.style.left=x+'px';tip.style.top=y+'px';
var svg=t.ownerSVGElement,xh=svg&&svg.querySelector('.xhair'),dx=t.getAttribute('data-x');
if(xh&&dx){xh.setAttribute('x1',dx);xh.setAttribute('x2',dx);xh.style.visibility='visible';}});
document.addEventListener('pointerleave',hide);})();
`;
