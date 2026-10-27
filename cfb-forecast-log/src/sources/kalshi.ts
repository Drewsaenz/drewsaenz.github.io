import { z } from 'zod';
import { loadKalshiConfig, writeConfig, type KalshiConfig } from '../config';
import { log } from '../log';
import { suggestTeams } from '../teams';
import type { GameRow } from '../types';
import { getJson } from '../util/http';

// READ-ONLY. v1 holds no Kalshi credentials and sends no auth headers.
// Do not add POST/PUT/DELETE, order placement, portfolio or auth code here.

const KalshiMarket = z
  .object({
    ticker: z.string(),
    event_ticker: z.string(),
    title: z.string(),
    subtitle: z.string().optional(),
    yes_sub_title: z.string().optional(),
    no_sub_title: z.string().optional(),
    status: z.string(),
    yes_bid: z.number().nullable().optional(),
    yes_ask: z.number().nullable().optional(),
    volume: z.number().nullable().optional(),
    open_interest: z.number().nullable().optional(),
    close_time: z.string().optional(),
    expected_expiration_time: z.string().optional(),
  })
  .passthrough();
export type KalshiMarket = z.infer<typeof KalshiMarket>;

const MarketsPage = z.object({ markets: z.array(KalshiMarket), cursor: z.string().nullable().optional() }).passthrough();
const SeriesResponse = z.object({ series: z.object({ ticker: z.string(), title: z.string() }).passthrough() }).passthrough();
const MarketResponse = z.object({ market: KalshiMarket }).passthrough();

export class KalshiClient {
  readonly cfg: KalshiConfig;

  constructor(cfg?: KalshiConfig) {
    this.cfg = cfg ?? loadKalshiConfig();
  }

  private async get(pathname: string, params: Record<string, string | number> = {}): Promise<unknown> {
    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    const url = `${this.cfg.base_url}${pathname}${qs ? `?${qs}` : ''}`;
    log.info(`Kalshi GET ${pathname}${qs ? '?' + qs : ''}`);
    return getJson(url);
  }

  /**
   * First-run check from CLAUDE.md: confirm the configured series ticker
   * really is the NCAAF game-winner series, then persist the confirmation.
   */
  async confirmSeries(): Promise<string> {
    if (this.cfg.series_confirmed) return this.cfg.series_ticker;
    const res = SeriesResponse.parse(await this.get(`/series/${this.cfg.series_ticker}`));
    const re = new RegExp(this.cfg.series_title_pattern, 'i');
    if (!re.test(res.series.title)) {
      throw new Error(`Kalshi series ${res.series.ticker} title "${res.series.title}" does not look like NCAAF; fix config/kalshi.json`);
    }
    writeConfig('kalshi.json', { ...this.cfg, series_confirmed: true });
    log.info(`Kalshi series confirmed: ${res.series.ticker} "${res.series.title}"`);
    return res.series.ticker;
  }

  async listMarkets(status = 'open'): Promise<KalshiMarket[]> {
    const all: KalshiMarket[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const params: Record<string, string | number> = { series_ticker: this.cfg.series_ticker, status, limit: this.cfg.page_size };
      if (cursor) params.cursor = cursor;
      const res = MarketsPage.parse(await this.get('/markets', params));
      all.push(...res.markets);
      if (!res.cursor) break;
      cursor = res.cursor;
    }
    return all;
  }

  async getMarket(ticker: string): Promise<KalshiMarket> {
    return MarketResponse.parse(await this.get(`/markets/${ticker}`)).market;
  }
}

const MONTHS: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

/**
 * Kalshi game tickers encode the date after the series: KXNCAAFGAME-25OCT25TEXOU-TEX
 * -> 2025-10-25 (US Eastern calendar date). Returns null when absent.
 */
export function tickerDate(ticker: string): Date | null {
  const seg = ticker.split('-')[1] ?? '';
  const m = seg.match(/^(\d{2})([A-Z]{3})(\d{2})/);
  if (!m) return null;
  const month = MONTHS[m[2]];
  if (month === undefined) return null;
  // Noon ET ≈ 16:00-17:00 UTC; good enough as the centre of a ±36h window.
  return new Date(Date.UTC(2000 + Number(m[1]), month, Number(m[3]), 17, 0, 0));
}

export interface MappedMarket {
  ticker: string;
  game: GameRow;
  yes_team: string;
  yes_bid: number | null;
  yes_ask: number | null;
  volume: number | null;
  open_interest: number | null;
  close_utc: string | null;
}

/**
 * Map Kalshi markets to CFBD games by (yes team, kickoff date). Throws on any
 * market that cannot be mapped to exactly one game — never guess.
 */
export function mapMarketsToGames(markets: KalshiMarket[], games: GameRow[], aliases: Record<string, string>): MappedMarket[] {
  const out: MappedMarket[] = [];
  const problems: string[] = [];
  const WINDOW_MS = 36 * 3_600_000;

  for (const m of markets) {
    const rawTeam = (m.yes_sub_title ?? '').trim();
    if (!rawTeam) {
      problems.push(`${m.ticker}: no yes_sub_title`);
      continue;
    }
    const team = aliases[rawTeam] ?? rawTeam;
    const anchor = tickerDate(m.ticker) ?? (m.close_time ? new Date(m.close_time) : null);
    if (!anchor) {
      problems.push(`${m.ticker}: no date in ticker or close_time`);
      continue;
    }
    const candidates = games.filter(
      (g) => (g.home_team === team || g.away_team === team) && Math.abs(Date.parse(g.kickoff_utc) - anchor.getTime()) <= WINDOW_MS,
    );
    if (candidates.length !== 1) {
      let hint = '';
      if (candidates.length === 0) {
        const names = new Set<string>();
        for (const g of games) {
          names.add(g.home_team);
          names.add(g.away_team);
        }
        const close = names.has(team) ? [] : suggestTeams(rawTeam, names);
        hint = names.has(team)
          ? ' (team name is fine; no CFBD game for it within 36h of that date)'
          : ` (not a CFBD team name; add a "kalshi" alias in config/team-aliases.json${close.length ? `, closest: ${close.map((c) => `"${c}"`).join(', ')}` : ''})`;
      }
      problems.push(`${m.ticker}: yes team "${rawTeam}"${team !== rawTeam ? ` -> "${team}"` : ''} matched ${candidates.length} CFBD games near ${anchor.toISOString().slice(0, 10)}${hint}`);
      continue;
    }
    out.push({
      ticker: m.ticker,
      game: candidates[0],
      yes_team: team,
      yes_bid: m.yes_bid ?? null,
      yes_ask: m.yes_ask ?? null,
      volume: m.volume ?? null,
      open_interest: m.open_interest ?? null,
      close_utc: m.close_time ? new Date(m.close_time).toISOString() : null,
    });
  }
  if (problems.length > 0) {
    throw new Error(`Kalshi: ${problems.length} unmapped market(s):\n  ${problems.join('\n  ')}`);
  }
  return out;
}
