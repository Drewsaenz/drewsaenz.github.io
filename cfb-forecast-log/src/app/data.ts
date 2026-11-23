/**
 * Read-only queries behind the local app (src/app/server.ts). Nothing here
 * writes to the database; actions that change things go through the same
 * npm scripts cron runs (see ACTIONS in server.ts).
 */
import type { Db } from '../db';
import { SEC_TEAMS } from '../board';
import { parseJobLog, type JobRun } from '../tracker';

export interface GameSummary {
  game_id: number;
  week: number;
  away: string;
  home: string;
  kickoff_utc: string;
  sec: boolean;
  home_points: number | null;
  away_points: number | null;
  completed: boolean;
}

/** The week the latest non-pregame snapshot was for (falls back to the latest graded week). */
export function currentBoardWeek(db: Db): { season: number; week: number } | null {
  return (
    (db
      .prepare(
        `SELECT g.season, g.week FROM forecasts f JOIN games g ON g.game_id = f.game_id
          WHERE f.snapshot_kind IN ('tuesday','report','friday','manual') AND g.kickoff_utc >= datetime(f.snapshot_utc, '-1 day')
          ORDER BY f.snapshot_utc DESC, g.kickoff_utc ASC LIMIT 1`,
      )
      .get() as { season: number; week: number } | undefined) ?? null
  );
}

/** Games in a week that have at least one logged forecast, in kickoff order. */
export function gamesForWeek(db: Db, season: number, week: number): GameSummary[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT g.game_id, g.week, g.away_team AS away, g.home_team AS home, g.kickoff_utc, g.home_points, g.away_points, g.completed
         FROM games g JOIN forecasts f ON f.game_id = g.game_id
        WHERE g.season = ? AND g.week = ? ORDER BY g.kickoff_utc, g.home_team`,
    )
    .all(season, week) as (Omit<GameSummary, 'sec' | 'completed'> & { completed: number })[];
  return rows.map((r) => ({ ...r, completed: r.completed === 1, sec: SEC_TEAMS.has(r.home) || SEC_TEAMS.has(r.away) }));
}

export interface SnapshotRow {
  snapshot_kind: string;
  snapshot_utc: string;
  model_version: string;
  home_prob: number;
  kalshi: number | null;
  vegas: number | null;
  /** Home-perspective Vegas spread (negative = home favored). */
  vegas_spread: number | null;
  outcome: 0 | 1 | null;
}

export interface FactRow {
  team: string;
  player: string | null;
  position: string | null;
  status: string;
  game_ref: string | null;
  source: string | null;
  as_of: string;
  detail: string | null;
  official: boolean;
}

export interface GameDetail {
  game: GameSummary;
  snapshots: SnapshotRow[];
  /** Spread model rows (home margin), one per snapshot. */
  spreads: { snapshot_kind: string; snapshot_utc: string; model_version: string; home_margin: number }[];
  facts: FactRow[];
}

/**
 * Every logged forecast for a game, from the home team's market (the two
 * Kalshi markets are mirror images), plus the availability facts for both
 * teams from the 10 days before kickoff, recaps of earlier games excluded.
 */
export function gameDetail(db: Db, gameId: number): GameDetail | null {
  const g = db
    .prepare(`SELECT game_id, week, away_team AS away, home_team AS home, kickoff_utc, home_points, away_points, completed FROM games WHERE game_id = ?`)
    .get(gameId) as (Omit<GameSummary, 'sec' | 'completed'> & { completed: number }) | undefined;
  if (!g) return null;
  const game: GameSummary = { ...g, completed: g.completed === 1, sec: SEC_TEAMS.has(g.home) || SEC_TEAMS.has(g.away) };
  const snapshots = db
    .prepare(
      `SELECT f.snapshot_kind, f.snapshot_utc, f.model_version, f.my_prob AS home_prob, f.market_mid AS kalshi, f.vegas_prob AS vegas, f.vegas_spread, f.outcome
         FROM forecasts f JOIN markets m ON m.ticker = f.ticker
        WHERE f.game_id = ? AND m.yes_team = ?
        ORDER BY f.snapshot_utc, f.model_version`,
    )
    .all(gameId, game.home) as SnapshotRow[];
  const facts = db
    .prepare(
      `SELECT COALESCE(team, team_raw) AS team, player, position, status, game_ref, source_channel AS source, as_of, detail, model = 'availability-report' AS official
         FROM news_facts
        WHERE COALESCE(team, team_raw) IN (?, ?) AND as_of <= ? AND as_of >= datetime(?, '-10 days')
          AND COALESCE(game_ref, '') <> 'previous' AND status <> 'unknown'
        ORDER BY team, as_of DESC`,
    )
    .all(game.home, game.away, game.kickoff_utc, game.kickoff_utc) as (Omit<FactRow, 'official'> & { official: number })[];
  const spreads = db
    .prepare(`SELECT snapshot_kind, snapshot_utc, model_version, home_margin FROM spread_forecasts WHERE game_id = ? ORDER BY snapshot_utc`)
    .all(gameId) as GameDetail['spreads'];
  return { game, snapshots, spreads, facts: facts.map((f) => ({ ...f, official: f.official === 1 })) };
}

/** Availability facts for the last `days` days, newest first, optionally one team or SEC only; recaps excluded. */
export function recentNews(db: Db, opts: { days: number; team?: string; secOnly?: boolean; now?: Date }): FactRow[] {
  const since = new Date((opts.now ?? new Date()).getTime() - opts.days * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT COALESCE(team, team_raw) AS team, player, position, status, game_ref, source_channel AS source, as_of, detail, model = 'availability-report' AS official
         FROM news_facts
        WHERE as_of >= ? AND COALESCE(game_ref, '') <> 'previous' AND status <> 'unknown'
          AND (? IS NULL OR COALESCE(team, team_raw) = ?)
        ORDER BY as_of DESC LIMIT 1500`,
    )
    .all(since, opts.team ?? null, opts.team ?? null) as (Omit<FactRow, 'official'> & { official: number })[];
  return rows.map((f) => ({ ...f, official: f.official === 1 })).filter((f) => !opts.secOnly || SEC_TEAMS.has(f.team));
}

export interface Health {
  jobs: JobRun[];
  caffeinate: boolean | null;
  cronLines: number | null;
  rows: { forecasts: number; graded: number; facts: number };
  lastSnapshot: string | null;
}

/** Job runs from the job log, plus counts from the database. The process checks come from the server. */
export function health(db: Db, logText: string, caffeinate: boolean | null, cronLines: number | null): Health {
  const rows = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM forecasts) AS forecasts, (SELECT COUNT(*) FROM forecasts WHERE outcome IS NOT NULL) AS graded, (SELECT COUNT(*) FROM news_facts) AS facts`,
    )
    .get() as Health['rows'];
  const last = db.prepare(`SELECT MAX(snapshot_utc) AS t FROM forecasts WHERE snapshot_kind <> 'manual'`).get() as { t: string | null };
  return { jobs: parseJobLog(logText), caffeinate, cronLines, rows, lastSnapshot: last.t };
}
