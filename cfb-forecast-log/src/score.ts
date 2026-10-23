/**
 * Pure scoring functions over resolved, non-manual forecast rows.
 * No DB access here so everything is unit-testable.
 */
import type { ScoringConfig } from './config';

export interface ScoreRow {
  game_id: number;
  ticker: string | null;
  snapshot_kind: string;
  model_version: string;
  my_prob: number;
  market_mid: number | null;
  vegas_prob: number | null;
  yes_bid: number | null;
  yes_ask: number | null;
  outcome: 0 | 1;
}

export interface Accuracy {
  n: number;
  brier: number | null;
  logLoss: number | null;
}

const EPS = 1e-6;

export function accuracy(pairs: { p: number; y: 0 | 1 }[]): Accuracy {
  if (pairs.length === 0) return { n: 0, brier: null, logLoss: null };
  let b = 0;
  let ll = 0;
  for (const { p, y } of pairs) {
    const pc = Math.min(1 - EPS, Math.max(EPS, p));
    b += (pc - y) ** 2;
    ll -= y === 1 ? Math.log(pc) : Math.log(1 - pc);
  }
  return { n: pairs.length, brier: b / pairs.length, logLoss: ll / pairs.length };
}

export interface AccuracyComparison {
  mine: Accuracy;
  market: Accuracy;
  vegas: Accuracy;
}

/** Brier/log loss for my_prob, market_mid and vegas_prob side by side (each over the rows where it exists). */
export function compareAccuracy(rows: ScoreRow[]): AccuracyComparison {
  return {
    mine: accuracy(rows.map((r) => ({ p: r.my_prob, y: r.outcome }))),
    market: accuracy(rows.filter((r) => r.market_mid !== null).map((r) => ({ p: r.market_mid!, y: r.outcome }))),
    vegas: accuracy(rows.filter((r) => r.vegas_prob !== null).map((r) => ({ p: r.vegas_prob!, y: r.outcome }))),
  };
}

export interface CalibrationBin {
  lo: number;
  hi: number;
  n: number;
  predicted: number | null; // mean forecast in bin
  observed: number | null; // observed win frequency in bin
}

export function calibration(pairs: { p: number; y: 0 | 1 }[], bins = 10): CalibrationBin[] {
  const out: CalibrationBin[] = Array.from({ length: bins }, (_, i) => ({ lo: i / bins, hi: (i + 1) / bins, n: 0, predicted: null, observed: null }));
  const sumP = new Array<number>(bins).fill(0);
  const sumY = new Array<number>(bins).fill(0);
  for (const { p, y } of pairs) {
    const i = Math.min(bins - 1, Math.max(0, Math.floor(p * bins)));
    out[i].n += 1;
    sumP[i] += p;
    sumY[i] += y;
  }
  for (let i = 0; i < bins; i++) {
    if (out[i].n > 0) {
      out[i].predicted = sumP[i] / out[i].n;
      out[i].observed = sumY[i] / out[i].n;
    }
  }
  return out;
}

/** Kalshi taker fee for one contract at price P (dollars): ceil(rate * P * (1-P) * 100) / 100. */
export function takerFee(priceDollars: number, rate: number): number {
  return Math.max(0, Math.ceil(rate * priceDollars * (1 - priceDollars) * 100 - 1e-9)) / 100;
}

export interface PnlSummary {
  n: number; // qualifying rows
  pnl: number; // dollars
  risked: number; // dollars put at risk (price + fees)
  roi: number | null; // pnl / risked
  wins: number;
}

export interface PnlReport {
  edge_min: number;
  taker: PnlSummary;
  maker: PnlSummary;
  skipped_no_quote: number;
  maker_caveat: string;
}

/**
 * Hypothetical 1-contract P&L per row when |my_prob - market_mid| >= edge_min.
 * Side = YES if my_prob > market_mid else NO.
 *   Taker: pay the ask (YES at yes_ask, NO at 100 - yes_bid), pay the fee.
 *   Maker: assume a fill at the bid (YES at yes_bid, NO at 100 - yes_ask), no fee.
 * Maker fills are not guaranteed, so maker P&L is an upper bound.
 */
export function hypotheticalPnl(rows: ScoreRow[], cfg: ScoringConfig): PnlReport {
  const taker: PnlSummary = { n: 0, pnl: 0, risked: 0, roi: null, wins: 0 };
  const maker: PnlSummary = { n: 0, pnl: 0, risked: 0, roi: null, wins: 0 };
  let skipped = 0;
  for (const r of rows) {
    if (r.market_mid === null || r.yes_bid === null || r.yes_ask === null) {
      skipped += 1;
      continue;
    }
    const edge = r.my_prob - r.market_mid;
    if (Math.abs(edge) < cfg.edge_min) continue;
    const buyYes = edge > 0;
    const won = buyYes ? r.outcome === 1 : r.outcome === 0;

    const takerPrice = (buyYes ? r.yes_ask : 100 - r.yes_bid) / 100;
    const makerPrice = (buyYes ? r.yes_bid : 100 - r.yes_ask) / 100;
    if (takerPrice <= 0 || takerPrice >= 1 || makerPrice <= 0 || makerPrice >= 1) {
      skipped += 1;
      continue;
    }

    const fee = takerFee(takerPrice, cfg.taker_fee_rate);
    taker.n += 1;
    taker.risked += takerPrice + fee;
    taker.pnl += (won ? 1 - takerPrice : -takerPrice) - fee;
    if (won) taker.wins += 1;

    maker.n += 1;
    maker.risked += makerPrice;
    maker.pnl += won ? 1 - makerPrice : -makerPrice;
    if (won) maker.wins += 1;
  }
  taker.roi = taker.risked > 0 ? taker.pnl / taker.risked : null;
  maker.roi = maker.risked > 0 ? maker.pnl / maker.risked : null;
  return {
    edge_min: cfg.edge_min,
    taker,
    maker,
    skipped_no_quote: skipped,
    maker_caveat: 'Maker fills are assumed at the bid and are NOT guaranteed; treat maker P&L as an upper bound.',
  };
}

export interface EdgeDecay {
  games: number;
  tuesday: AccuracyComparison;
  pregame: AccuracyComparison;
}

/** Brier for tuesday vs pregame rows restricted to (game, ticker, model) pairs that have both. */
export function edgeDecay(rows: ScoreRow[]): EdgeDecay {
  const key = (r: ScoreRow) => `${r.game_id}|${r.ticker}|${r.model_version}`;
  const tues = new Map(rows.filter((r) => r.snapshot_kind === 'tuesday').map((r) => [key(r), r]));
  const pre = new Map(rows.filter((r) => r.snapshot_kind === 'pregame').map((r) => [key(r), r]));
  const both = [...tues.keys()].filter((k) => pre.has(k));
  return {
    games: both.length,
    tuesday: compareAccuracy(both.map((k) => tues.get(k)!)),
    pregame: compareAccuracy(both.map((k) => pre.get(k)!)),
  };
}

export function groupBy<T>(rows: T[], keyFn: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(r);
  }
  return m;
}
