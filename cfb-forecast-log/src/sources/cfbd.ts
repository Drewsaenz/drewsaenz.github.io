import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { loadCfbdConfig, type CfbdConfig } from '../config';
import { log } from '../log';
import { CACHE_DIR } from '../paths';
import type { GameRow } from '../types';
import { getJson } from '../util/http';

/** CFBD returned snake_case before mid-2024 and camelCase after; accept both. */
function camelKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(camelKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = camelKeys(val);
    }
    return out;
  }
  return v;
}

const CfbdGame = z.object({
  id: z.number().int(),
  season: z.number().int(),
  week: z.number().int(),
  seasonType: z.string(),
  startDate: z.string(),
  neutralSite: z.boolean().nullable().optional(),
  homeTeam: z.string(),
  awayTeam: z.string(),
  homePoints: z.number().nullable().optional(),
  awayPoints: z.number().nullable().optional(),
  completed: z.boolean().nullable().optional(),
});
const CfbdGames = z.array(CfbdGame);

const CfbdLine = z.object({
  provider: z.string(),
  spread: z.coerce.number().nullable().optional(),
  overUnder: z.coerce.number().nullable().optional(),
});
const CfbdGameLines = z.object({
  id: z.number().int(),
  homeTeam: z.string(),
  awayTeam: z.string(),
  lines: z.array(CfbdLine),
});
const CfbdLines = z.array(CfbdGameLines);

const CfbdSp = z.array(z.object({ year: z.number().int(), team: z.string(), rating: z.number() }));
const CfbdElo = z.array(z.object({ year: z.number().int(), team: z.string(), elo: z.number() }));
const CfbdFpi = z.array(z.object({ year: z.number().int(), team: z.string(), fpi: z.number() }));
const CfbdRoster = z.array(
  z.object({ team: z.string(), firstName: z.string().nullable().optional(), lastName: z.string().nullable().optional(), position: z.string().nullable().optional() }),
);
const CfbdPlayerStats = z.array(z.object({ player: z.string(), team: z.string(), position: z.string().nullable().optional(), statType: z.string(), stat: z.coerce.number() }));

export interface GameLines {
  game_id: number;
  /** Home-perspective spread from the preferred provider, or null if no book posted one. */
  spread: number | null;
  /** That book's over/under, or null. */
  total: number | null;
  provider: string | null;
}

/** SP+ offense and defense, in points a game against an average opponent. */
export interface SpUnits {
  /** team -> { off: points scored, def: points allowed } */
  teams: Map<string, { off: number; def: number }>;
  /** The national average offense rating: points an average offense scores on an average defense. */
  avg: number;
}

const CfbdSpUnits = z.array(
  z.object({
    team: z.string(),
    offense: z.object({ rating: z.number().nullable().optional() }).nullable().optional(),
    defense: z.object({ rating: z.number().nullable().optional() }).nullable().optional(),
  }),
);

export type TeamRatings = Map<string, number>;

/** Season player stats are multi-megabyte responses; give them longer than the default 30s. */
const BIG_TIMEOUT_MS = 120_000;
/** Oldest cached copy of a big response used when CFBD cannot be reached. */
const STALE_MAX_HOURS = 7 * 24;

export class CfbdClient {
  private calls = 0;
  private readonly cfg: CfbdConfig;
  private readonly cacheDir: string;

  constructor(private readonly apiKey: string, cfg?: CfbdConfig, cacheDir = path.join(CACHE_DIR, 'cfbd')) {
    this.cfg = cfg ?? loadCfbdConfig();
    this.cacheDir = cacheDir;
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  get callCount(): number {
    return this.calls;
  }

  /**
   * Cached GET. With `big`, the request gets a longer timeout and, if CFBD cannot
   * be reached at all, falls back to the last cached copy (up to STALE_MAX_HOURS
   * old) with a warning. Used only for season player stats and rosters, where a
   * day-old copy is fine; schedules, lines and ratings never fall back. A
   * response that arrives but fails validation still throws (hard rule 5).
   */
  private async get<T>(endpoint: string, params: Record<string, string | number>, schema: z.ZodType<T>, ttlHours: number, big = false): Promise<T> {
    const qs = Object.entries(params)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    const url = `${this.cfg.base_url}${endpoint}${qs ? `?${qs}` : ''}`;
    const key = crypto.createHash('sha1').update(url).digest('hex');
    const file = path.join(this.cacheDir, `${key}.json`);

    let cached: { fetched_at: string; url: string; body: unknown } | null = null;
    if (fs.existsSync(file)) {
      cached = JSON.parse(fs.readFileSync(file, 'utf8')) as { fetched_at: string; url: string; body: unknown };
      if (Date.now() - Date.parse(cached.fetched_at) < ttlHours * 3_600_000) {
        return schema.parse(camelKeys(cached.body));
      }
    }

    this.calls += 1;
    log.info(`CFBD GET ${endpoint} ${qs} (call #${this.calls})`);
    let body: unknown;
    try {
      body = await getJson(url, { headers: { Authorization: `Bearer ${this.apiKey}` }, ...(big ? { timeoutMs: BIG_TIMEOUT_MS } : {}) });
    } catch (err) {
      const ageH = cached ? (Date.now() - Date.parse(cached.fetched_at)) / 3_600_000 : Infinity;
      if (!big || !cached || ageH > STALE_MAX_HOURS) throw err;
      log.warn(`CFBD ${endpoint} ${qs} unreachable (${(err as Error).message}); using the cached copy from ${ageH.toFixed(0)}h ago`);
      return schema.parse(camelKeys(cached.body));
    }
    const parsed = schema.parse(camelKeys(body)); // validate before caching
    fs.writeFileSync(file, JSON.stringify({ fetched_at: new Date().toISOString(), url, body }));
    return parsed;
  }

  /** Whole-season regular-season schedule (one call; cached). */
  async games(season: number, opts: { historical?: boolean } = {}): Promise<GameRow[]> {
    const ttl = opts.historical ? this.cfg.cache_ttl_hours.historical : this.cfg.cache_ttl_hours.games;
    const raw = await this.get('/games', { year: season, seasonType: this.cfg.season_type }, CfbdGames, ttl);
    return raw.map((g) => ({
      game_id: g.id,
      season: g.season,
      week: g.week,
      kickoff_utc: new Date(g.startDate).toISOString(),
      home_team: g.homeTeam,
      away_team: g.awayTeam,
      neutral_site: g.neutralSite ? 1 : 0,
      home_points: g.homePoints ?? null,
      away_points: g.awayPoints ?? null,
      completed: g.completed ? 1 : 0,
    }));
  }

  /** Lines for one week, or the whole season when `week` is omitted (one call; used by the v3 backtest). */
  async lines(season: number, week?: number, historical = false): Promise<GameLines[]> {
    const params: Record<string, string | number> = { year: season, seasonType: this.cfg.season_type };
    if (week !== undefined) params.week = week;
    const ttl = historical ? this.cfg.cache_ttl_hours.historical : this.cfg.cache_ttl_hours.lines;
    const raw = await this.get('/lines', params, CfbdLines, ttl);
    return raw.map((g) => {
      const pick = pickLine(g.lines, this.cfg.line_provider_priority);
      return { game_id: g.id, spread: pick?.spread ?? null, total: pick?.overUnder ?? null, provider: pick?.provider ?? null };
    });
  }

  async sp(season: number, historical = false): Promise<TeamRatings> {
    const ttl = historical ? this.cfg.cache_ttl_hours.historical : this.cfg.cache_ttl_hours.ratings;
    const raw = await this.get('/ratings/sp', { year: season }, CfbdSp, ttl);
    return toMap(raw.filter((r) => r.team !== 'nationalAverages').map((r) => [r.team, r.rating]));
  }

  /** SP+ offense and defense ratings (the same /ratings/sp call as sp(), so no extra budget when cached). */
  async spUnits(season: number, historical = false): Promise<SpUnits> {
    const ttl = historical ? this.cfg.cache_ttl_hours.historical : this.cfg.cache_ttl_hours.ratings;
    const raw = await this.get('/ratings/sp', { year: season }, CfbdSpUnits, ttl);
    const avgRow = raw.find((r) => r.team === 'nationalAverages');
    const avg = avgRow?.offense?.rating;
    if (typeof avg !== 'number') throw new Error(`CFBD /ratings/sp ${season} has no nationalAverages offense rating`);
    const teams = new Map<string, { off: number; def: number }>();
    for (const r of raw) {
      const off = r.offense?.rating;
      const def = r.defense?.rating;
      if (r.team !== 'nationalAverages' && typeof off === 'number' && typeof def === 'number') teams.set(r.team, { off, def });
    }
    return { teams, avg };
  }

  async fpi(season: number, historical = false): Promise<TeamRatings> {
    const ttl = historical ? this.cfg.cache_ttl_hours.historical : this.cfg.cache_ttl_hours.ratings;
    const raw = await this.get('/ratings/fpi', { year: season }, CfbdFpi, ttl);
    return toMap(raw.map((r) => [r.team, r.fpi]));
  }

  /** Season-to-date pass attempts per player (one call for every team; cached like ratings). */
  async passAttempts(season: number): Promise<{ team: string; player: string; attempts: number }[]> {
    const raw = await this.get('/stats/player/season', { year: season, category: 'passing', seasonType: this.cfg.season_type }, CfbdPlayerStats, this.cfg.cache_ttl_hours.ratings, true);
    const rows = raw.filter((r) => r.statType.toUpperCase() === 'ATT');
    if (raw.length > 0 && rows.length === 0) {
      throw new Error(`CFBD /stats/player/season returned ${raw.length} passing rows but none with statType ATT; the response shape has changed`);
    }
    return rows.map((r) => ({ team: r.team, player: r.player, attempts: r.stat }));
  }

  /**
   * Season player stats for one category (rushing, receiving, defensive, passing),
   * optionally limited to a week range. One call for every team; cached like ratings.
   */
  async playerStats(season: number, category: string, weeks?: { start: number; end: number }): Promise<{ player: string; team: string; position: string | null; statType: string; stat: number }[]> {
    const params: Record<string, string | number> = { year: season, category, seasonType: this.cfg.season_type };
    if (weeks) {
      params.startWeek = weeks.start;
      params.endWeek = weeks.end;
    }
    const raw = await this.get('/stats/player/season', params, CfbdPlayerStats, this.cfg.cache_ttl_hours.ratings, true);
    return raw.map((r) => ({ player: r.player, team: r.team, position: r.position ?? null, statType: r.statType.toUpperCase(), stat: r.stat }));
  }

  /** Every team's roster for a season (one call, ~30k players; cached like ratings). */
  async roster(season: number): Promise<{ team: string; first: string; last: string; position: string | null }[]> {
    const raw = await this.get('/roster', { year: season }, CfbdRoster, this.cfg.cache_ttl_hours.ratings, true);
    return raw.map((r) => ({ team: r.team, first: (r.firstName ?? '').trim(), last: (r.lastName ?? '').trim(), position: r.position ?? null }));
  }

  /** Elo as of the end of `week` (omit week for the latest available). */
  async elo(season: number, week?: number, historical = false): Promise<TeamRatings> {
    const ttl = historical ? this.cfg.cache_ttl_hours.historical : this.cfg.cache_ttl_hours.ratings;
    const params: Record<string, string | number> = { year: season };
    if (week !== undefined) params.week = week;
    const raw = await this.get('/ratings/elo', params, CfbdElo, ttl);
    return toMap(raw.map((r) => [r.team, r.elo]));
  }
}

function toMap(pairs: [string, number][]): TeamRatings {
  const m = new Map<string, number>();
  for (const [team, rating] of pairs) m.set(team, rating);
  return m;
}

/**
 * Choose one book's line per game: first provider in the priority list with a
 * posted spread, else the first line with a spread. CFBD does not expose a
 * per-line "updated" timestamp, so priority order stands in for recency.
 */
export function pickLine<T extends { provider: string; spread?: number | null }>(lines: T[], priority: string[]): T | null {
  const withSpread = lines.filter((l) => typeof l.spread === 'number' && Number.isFinite(l.spread));
  for (const p of priority) {
    const hit = withSpread.find((l) => l.provider.toLowerCase() === p.toLowerCase());
    if (hit) return hit;
  }
  return withSpread[0] ?? null;
}
