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

export interface GameLines {
  game_id: number;
  /** Home-perspective spread from the preferred provider, or null if no book posted one. */
  spread: number | null;
  provider: string | null;
}

export type TeamRatings = Map<string, number>;

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

  private async get<T>(endpoint: string, params: Record<string, string | number>, schema: z.ZodType<T>, ttlHours: number): Promise<T> {
    const qs = Object.entries(params)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    const url = `${this.cfg.base_url}${endpoint}${qs ? `?${qs}` : ''}`;
    const key = crypto.createHash('sha1').update(url).digest('hex');
    const file = path.join(this.cacheDir, `${key}.json`);

    if (fs.existsSync(file)) {
      const cached = JSON.parse(fs.readFileSync(file, 'utf8')) as { fetched_at: string; url: string; body: unknown };
      if (Date.now() - Date.parse(cached.fetched_at) < ttlHours * 3_600_000) {
        return schema.parse(camelKeys(cached.body));
      }
    }

    this.calls += 1;
    log.info(`CFBD GET ${endpoint} ${qs} (call #${this.calls})`);
    const body = await getJson(url, { headers: { Authorization: `Bearer ${this.apiKey}` } });
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

  async lines(season: number, week: number): Promise<GameLines[]> {
    const raw = await this.get('/lines', { year: season, week, seasonType: this.cfg.season_type }, CfbdLines, this.cfg.cache_ttl_hours.lines);
    return raw.map((g) => {
      const pick = pickLine(g.lines, this.cfg.line_provider_priority);
      return { game_id: g.id, spread: pick?.spread ?? null, provider: pick?.provider ?? null };
    });
  }

  async sp(season: number, historical = false): Promise<TeamRatings> {
    const ttl = historical ? this.cfg.cache_ttl_hours.historical : this.cfg.cache_ttl_hours.ratings;
    const raw = await this.get('/ratings/sp', { year: season }, CfbdSp, ttl);
    return toMap(raw.filter((r) => r.team !== 'nationalAverages').map((r) => [r.team, r.rating]));
  }

  async fpi(season: number, historical = false): Promise<TeamRatings> {
    const ttl = historical ? this.cfg.cache_ttl_hours.historical : this.cfg.cache_ttl_hours.ratings;
    const raw = await this.get('/ratings/fpi', { year: season }, CfbdFpi, ttl);
    return toMap(raw.map((r) => [r.team, r.fpi]));
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
