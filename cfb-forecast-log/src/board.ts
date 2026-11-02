/**
 * "This week's board" for the tracker page: every game in the latest Tuesday
 * (or newer manual) snapshot, the side the model likes, and whether that side
 * passes the same filters the report uses. Read-only.
 */
import type { ScoringConfig } from './config';
import type { Db } from './db';
import { qbFlags } from './news';

/** Bid/ask gap (cents) above which a maker fill at the bid is unlikely. */
export const WIDE_SPREAD_CENTS = 5;

export type BoardTag = 'edge' | 'wide' | 'news' | 'none';

export interface BoardRow {
  game_id: number;
  team: string;
  opponent: string;
  kickoff_utc: string;
  v1: number | null;
  v2: number | null;
  model: number;
  kalshi: number;
  vegas: number | null;
  edge: number;
  bid: number | null;
  ask: number | null;
  tag: BoardTag;
  qb: string[];
  outcome: 0 | 1 | null;
}

export interface BoardView {
  kind: string;
  snapshot_utc: string;
  rows: BoardRow[];
  edge_min: number;
  news_gap_min: number;
}

interface Raw {
  game_id: number;
  ticker: string;
  model_version: string;
  my_prob: number;
  market_mid: number | null;
  vegas_prob: number | null;
  yes_bid: number | null;
  yes_ask: number | null;
  outcome: 0 | 1 | null;
  yes_team: string;
  home_team: string;
  away_team: string;
  kickoff_utc: string;
}

export function tagFor(edge: number, model: number, vegas: number | null, bid: number | null, ask: number | null, cfg: ScoringConfig): BoardTag {
  if (edge < cfg.edge_min) return 'none';
  if (vegas !== null && Math.abs(model - vegas) >= cfg.news_gap_min) return 'news';
  if (bid === null || ask === null || ask - bid > WIDE_SPREAD_CENTS) return 'wide';
  return 'edge';
}

export function buildBoard(raw: Raw[], flags: Map<number, string[]>, cfg: ScoringConfig): BoardRow[] {
  // ticker -> { v1, v2, ... }
  const sides = new Map<string, { r: Raw; v1: number | null; v2: number | null }>();
  for (const r of raw) {
    const s = sides.get(r.ticker) ?? { r, v1: null, v2: null };
    if (r.model_version.startsWith('v2')) s.v2 = r.my_prob;
    else s.v1 = r.my_prob;
    sides.set(r.ticker, s);
  }
  // One row per game: the side with the larger model-minus-Kalshi gap.
  const best = new Map<number, BoardRow>();
  for (const { r, v1, v2 } of sides.values()) {
    if (r.market_mid === null) continue;
    const model = v2 ?? v1!;
    const edge = model - r.market_mid;
    const row: BoardRow = {
      game_id: r.game_id,
      team: r.yes_team,
      opponent: r.yes_team === r.home_team ? r.away_team : r.home_team,
      kickoff_utc: r.kickoff_utc,
      v1,
      v2,
      model,
      kalshi: r.market_mid,
      vegas: r.vegas_prob,
      edge,
      bid: r.yes_bid,
      ask: r.yes_ask,
      tag: tagFor(edge, model, r.vegas_prob, r.yes_bid, r.yes_ask, cfg),
      qb: flags.get(r.game_id) ?? [],
      outcome: r.outcome,
    };
    const prev = best.get(r.game_id);
    if (!prev || row.edge > prev.edge) best.set(r.game_id, row);
  }
  return [...best.values()].sort((a, b) => b.edge - a.edge);
}

export function collectBoard(db: Db, cfg: ScoringConfig): BoardView | null {
  const latest = db
    .prepare(`SELECT snapshot_kind AS kind, snapshot_utc FROM forecasts WHERE snapshot_kind IN ('tuesday','manual') ORDER BY snapshot_utc DESC LIMIT 1`)
    .get() as { kind: string; snapshot_utc: string } | undefined;
  if (!latest) return null;
  const raw = db
    .prepare(
      `SELECT f.game_id, f.ticker, f.model_version, f.my_prob, f.market_mid, f.vegas_prob, f.yes_bid, f.yes_ask, f.outcome,
              m.yes_team, g.home_team, g.away_team, g.kickoff_utc
         FROM forecasts f JOIN markets m ON m.ticker = f.ticker JOIN games g ON g.game_id = f.game_id
        WHERE f.snapshot_kind = ? AND f.snapshot_utc = ?`,
    )
    .all(latest.kind, latest.snapshot_utc) as Raw[];
  return { ...latest, rows: buildBoard(raw, qbFlags(db), cfg), edge_min: cfg.edge_min, news_gap_min: cfg.news_gap_min };
}

// ------------------------------------------------------------ render

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const p2 = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);

const TAG: Record<BoardTag, { label: string; title: string }> = {
  edge: { label: 'Edge', title: 'Model beats Kalshi by the edge threshold, agrees with Vegas, and the bid/ask is tight' },
  wide: { label: 'Wide spread', title: `Edge is there, but the bid/ask gap is over ${WIDE_SPREAD_CENTS}¢, so a fill at the bid is unlikely` },
  news: { label: 'Check news', title: 'Model is far from Vegas too. Usually the model is missing news, not finding value' },
  none: { label: '', title: '' },
};

export function renderBoard(b: BoardView, fmtTime: (iso: string) => string): string {
  const counts = { edge: 0, wide: 0, news: 0, none: 0 };
  for (const r of b.rows) counts[r.tag] += 1;
  const source = b.kind === 'tuesday' ? `Tuesday snapshot, ${fmtTime(b.snapshot_utc)}` : `Preview from a manual run, ${fmtTime(b.snapshot_utc)}. Not scored.`;
  const body = b.rows
    .map((r) => {
      const v1note = r.v2 !== null && r.v1 !== null && Math.abs(r.v2 - r.v1) >= 0.005 ? `<div class="sub" title="v1 before the QB adjustment">v1 ${p2(r.v1)}</div>` : '';
      const qb = r.qb.length ? `<div class="sub qb">${esc(r.qb.join('; '))}</div>` : '';
      const result = r.outcome === null ? '' : `<span class="res ${r.outcome ? 'won' : 'lost'}">${r.outcome ? 'Won' : 'Lost'}</span>`;
      const tag = r.tag === 'none' ? '' : `<span class="tag ${r.tag}" title="${esc(TAG[r.tag].title)}">${TAG[r.tag].label}</span>`;
      const gap = r.vegas === null ? '' : r.kalshi - r.vegas;
      return `<tr data-tag="${r.tag}">
  <td><div class="team">${esc(r.team)} ${result}</div><div class="sub">vs ${esc(r.opponent)} · ${esc(fmtTime(r.kickoff_utc))}</div>${qb}</td>
  <td class="num edge ${r.edge >= b.edge_min ? 'pos' : ''}">${r.edge >= 0 ? '+' : '−'}${Math.round(Math.abs(r.edge) * 100)}</td>
  <td class="num">${p2(r.model)}${v1note}</td>
  <td class="num">${p2(r.kalshi)}<div class="sub">${r.bid ?? '—'}¢ / ${r.ask ?? '—'}¢</div></td>
  <td class="num">${p2(r.vegas)}${gap === '' ? '' : `<div class="sub">${Math.round(Math.abs(gap) * 100) === 0 ? 'same as Kalshi' : `Kalshi ${Math.round(Math.abs(gap) * 100)} ${gap > 0 ? 'higher' : 'lower'}`}</div>`}</td>
  <td>${tag}</td>
</tr>`;
    })
    .join('');
  return `
<h2 class="sec">This week's board <span class="small">${esc(source)}</span></h2>
<section class="card board">
  <div class="small">For each game, the side the model likes more than Kalshi does. <b>Edge</b> = model at least ${Math.round(b.edge_min * 100)} points above Kalshi, within ${Math.round(b.news_gap_min * 100)} of Vegas, bid/ask gap ${WIDE_SPREAD_CENTS}¢ or less. Hypothetical only.</div>
  <div class="chips" role="group" aria-label="Filter games">
    <button type="button" class="chip on" data-f="edge">Edge (${counts.edge})</button>
    <button type="button" class="chip" data-f="flagged">Edge + flagged (${counts.edge + counts.wide + counts.news})</button>
    <button type="button" class="chip" data-f="all">All games (${b.rows.length})</button>
  </div>
  <div class="scroll"><table class="bt">
    <thead><tr><th>Back</th><th class="num">Edge</th><th class="num">Model</th><th class="num">Kalshi</th><th class="num">Vegas</th><th></th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>
  <p class="small empty" hidden>No games pass the filter.</p>
</section>`;
}

export const BOARD_CSS = `
.board .chips{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0 8px}
.chip{font:inherit;font-size:13px;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:999px;padding:4px 12px;cursor:pointer}
.chip.on{background:var(--accent);border-color:var(--accent);color:#fff}
.board .scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
table.bt{min-width:520px}table.bt td{vertical-align:top}
.bt .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.bt .team{font-weight:600}.bt .sub{font-size:12px;color:var(--muted);font-weight:400}.bt .sub.qb{color:var(--warn-ink)}
.bt .edge.pos{color:var(--ok);font-weight:650}
.tag{display:inline-block;font-size:11px;font-weight:600;border-radius:999px;padding:2px 8px;white-space:nowrap}
.tag.edge{background:var(--ok);color:#fff}.tag.wide{background:var(--line);color:var(--ink)}.tag.news{background:var(--warn-bg);color:var(--warn-ink)}
.res{font-size:11px;font-weight:600;margin-left:4px}.res.won{color:var(--ok)}.res.lost{color:var(--bad)}
`;

export const BOARD_JS = `
(function(){var card=document.querySelector('.board');if(!card)return;
var rows=card.querySelectorAll('tbody tr'),empty=card.querySelector('.empty'),key='board-filter';
function apply(f){var shown=0;rows.forEach(function(r){var t=r.dataset.tag;
var ok=f==='all'||(f==='edge'&&t==='edge')||(f==='flagged'&&t!=='none');r.hidden=!ok;if(ok)shown++;});
empty.hidden=shown>0;card.querySelectorAll('.chip').forEach(function(c){c.classList.toggle('on',c.dataset.f===f)});
try{localStorage.setItem(key,f)}catch(e){}}
card.querySelectorAll('.chip').forEach(function(c){c.addEventListener('click',function(){apply(c.dataset.f)})});
var saved='edge';try{saved=localStorage.getItem(key)||'edge'}catch(e){}apply(saved);})();
`;
