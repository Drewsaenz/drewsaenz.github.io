import type { GameRow } from './types';

/**
 * Season year for a date. The regular season runs late Aug -> early Dec, so any
 * date from June onward belongs to that calendar year's season and Jan-May to
 * the previous one (bowls are out of scope: seasonType=regular only).
 */
export function seasonFor(now: Date): number {
  const y = now.getUTCFullYear();
  return now.getUTCMonth() >= 5 ? y : y - 1;
}

/** Games with at least one FBS team. The CFBD feed carries every division; only FBS games have ratings and markets. */
export function fbsGames(games: GameRow[]): GameRow[] {
  const fbs = games.filter((g) => g.fbs !== false);
  return fbs.length > 0 ? fbs : games;
}

/**
 * "Current week" = the week of the next FBS game to kick off at or after `now`.
 * After the last game, returns the final week (jobs will then find nothing
 * upcoming and write nothing). Returns null when the schedule is empty.
 *
 * Lower-division games are ignored: their week numbers and late kickoffs used
 * to move the pointer before the FBS week was over. A game replayed long after
 * its original week keeps its old week number, so an upcoming game more than
 * one week behind the games already played is ignored too.
 */
export function currentWeek(games: GameRow[], now: Date): number | null {
  if (games.length === 0) return null;
  const pool = fbsGames(games);
  const t = now.getTime();
  const started = pool.filter((g) => Date.parse(g.kickoff_utc) < t);
  const floor = started.length > 0 ? Math.max(...started.map((g) => g.week)) - 1 : -Infinity;
  const upcoming = pool.filter((g) => Date.parse(g.kickoff_utc) >= t && g.week >= floor);
  if (upcoming.length === 0) return Math.max(...pool.map((g) => g.week));
  const next = Math.min(...upcoming.map((g) => Date.parse(g.kickoff_utc)));
  return Math.min(...upcoming.filter((g) => Date.parse(g.kickoff_utc) === next).map((g) => g.week));
}

/** ISO-8601 week label used for report file names: YYYY-WW. */
export function isoWeekLabel(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7; // Mon=1..Sun=7
  date.setUTCDate(date.getUTCDate() + 4 - day); // Thursday of this week
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-${String(week).padStart(2, '0')}`;
}
