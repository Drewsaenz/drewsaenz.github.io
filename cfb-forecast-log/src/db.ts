import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DATA_DIR, SCHEMA_PATH } from './paths';
import type { GameRow, MarketRow } from './types';

export type Db = Database.Database;

export function openDb(file?: string): Db {
  const dbPath = file ?? process.env.DB_PATH ?? path.join(DATA_DIR, 'forecasts.db');
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}

export function upsertGames(db: Db, games: GameRow[]): void {
  const stmt = db.prepare(`
    INSERT INTO games (game_id, season, week, kickoff_utc, home_team, away_team, neutral_site, home_points, away_points, completed)
    VALUES (@game_id, @season, @week, @kickoff_utc, @home_team, @away_team, @neutral_site, @home_points, @away_points, @completed)
    ON CONFLICT(game_id) DO UPDATE SET
      season = excluded.season, week = excluded.week, kickoff_utc = excluded.kickoff_utc,
      home_team = excluded.home_team, away_team = excluded.away_team, neutral_site = excluded.neutral_site,
      home_points = excluded.home_points, away_points = excluded.away_points, completed = excluded.completed`);
  for (const g of games) stmt.run(g);
}

export function upsertMarkets(db: Db, markets: MarketRow[]): void {
  const stmt = db.prepare(`
    INSERT INTO markets (ticker, game_id, yes_team, close_utc) VALUES (@ticker, @game_id, @yes_team, @close_utc)
    ON CONFLICT(ticker) DO UPDATE SET game_id = excluded.game_id, yes_team = excluded.yes_team, close_utc = excluded.close_utc`);
  for (const m of markets) stmt.run(m);
}

export interface RatingRow {
  season: number;
  week: number;
  source: string;
  team: string;
  rating: number;
  extra: string | null;
  fetched_at: string;
}

export function upsertRatings(db: Db, rows: RatingRow[]): void {
  const stmt = db.prepare(`
    INSERT INTO ratings (season, week, source, team, rating, extra, fetched_at)
    VALUES (@season, @week, @source, @team, @rating, @extra, @fetched_at)
    ON CONFLICT(season, week, source, team) DO UPDATE SET
      rating = excluded.rating, extra = excluded.extra, fetched_at = excluded.fetched_at`);
  for (const r of rows) stmt.run(r);
}

/** Ratings for a (season, week) grouped by source -> team -> rating. */
export function loadRatings(db: Db, season: number, week: number): Map<string, Map<string, number>> {
  const rows = db
    .prepare('SELECT source, team, rating FROM ratings WHERE season = ? AND week = ?')
    .all(season, week) as { source: string; team: string; rating: number }[];
  const out = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!out.has(r.source)) out.set(r.source, new Map());
    out.get(r.source)!.set(r.team, r.rating);
  }
  return out;
}

export function gamesForSeason(db: Db, season: number): GameRow[] {
  return db.prepare('SELECT * FROM games WHERE season = ? ORDER BY kickoff_utc').all(season) as GameRow[];
}

/** Set of CFBD canonical team names that appear in a season's schedule. */
export function teamsInSeason(db: Db, season: number): Set<string> {
  const rows = db
    .prepare('SELECT home_team AS t FROM games WHERE season = ? UNION SELECT away_team FROM games WHERE season = ?')
    .all(season, season) as { t: string }[];
  return new Set(rows.map((r) => r.t));
}
