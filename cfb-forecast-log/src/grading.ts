/**
 * Grading rules for one pending forecast, kept pure so they can be tested.
 * resolve.ts applies them; nothing else writes outcomes or voids.
 */
import type { GameRow } from './types';

/** A game still unplayed this long after kickoff is treated as cancelled. */
export const VOID_AFTER_DAYS = 4;
/** A forecast made more than this before kickoff was made for a different date (game postponed). */
export const MAX_LEAD_DAYS = 8;
/** A pregame row taken more than this before the final kickoff saw a kickoff that later moved. */
export const MAX_PREGAME_LEAD_HOURS = 3;

const DAY = 86_400_000;

export interface PendingForecast {
  id: number;
  game_id: number;
  yes_team: string;
  snapshot_kind: string;
  snapshot_utc: string;
  /** Kickoff as stored before this run (used when CFBD no longer lists the game). */
  stored_kickoff_utc: string;
}

export type Decision =
  | { kind: 'grade'; outcome: 0 | 1 }
  | { kind: 'void'; reason: string }
  | { kind: 'wait'; why: 'not_final' | 'missing' };

export function decide(p: PendingForecast, g: GameRow | undefined, now: Date): Decision {
  const nowMs = now.getTime();
  if (!g) {
    return nowMs - Date.parse(p.stored_kickoff_utc) > VOID_AFTER_DAYS * DAY
      ? { kind: 'void', reason: `game no longer listed by CFBD ${VOID_AFTER_DAYS}+ days after kickoff` }
      : { kind: 'wait', why: 'missing' };
  }
  const kick = Date.parse(g.kickoff_utc);
  const lead = kick - Date.parse(p.snapshot_utc);
  if (lead > MAX_LEAD_DAYS * DAY) return { kind: 'void', reason: 'game moved to a later date after this forecast' };
  if (p.snapshot_kind === 'pregame' && lead > MAX_PREGAME_LEAD_HOURS * 3_600_000) {
    return { kind: 'void', reason: 'kickoff moved after the pregame snapshot' };
  }
  if (!g.completed || g.home_points === null || g.away_points === null) {
    return nowMs - kick > VOID_AFTER_DAYS * DAY
      ? { kind: 'void', reason: `not played within ${VOID_AFTER_DAYS} days of kickoff (cancelled?)` }
      : { kind: 'wait', why: 'not_final' };
  }
  if (g.home_points === g.away_points) return { kind: 'void', reason: 'game ended in a tie' };
  const homeWon = g.home_points > g.away_points;
  return { kind: 'grade', outcome: homeWon === (p.yes_team === g.home_team) ? 1 : 0 };
}
