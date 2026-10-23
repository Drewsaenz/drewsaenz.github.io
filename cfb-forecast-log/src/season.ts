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

/**
 * "Current week" = the earliest week that still has a game kicking off at or
 * after `now`. After the last game, returns the final week (jobs will then find
 * nothing upcoming and write nothing). Returns null when the schedule is empty.
 */
export function currentWeek(games: GameRow[], now: Date): number | null {
  if (games.length === 0) return null;
  const upcoming = games.filter((g) => Date.parse(g.kickoff_utc) >= now.getTime());
  if (upcoming.length > 0) return Math.min(...upcoming.map((g) => g.week));
  return Math.max(...games.map((g) => g.week));
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
