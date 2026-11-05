/**
 * Network side of v4: fetch the season stats it weighs players by (cached CFBD
 * calls), then build each team's adjustment from the DB as of a timestamp.
 * Kept apart from src/model/v4.ts so the model math stays pure and testable.
 */
import type { Db } from '../db';
import type { CfbdClient } from '../sources/cfbd';
import type { Starter } from './v2';
import { buildImportance, coachChanges, latestStatuses, teamAdjustment, weeksMissed, type ImportanceIndex, type ModelV4Config, type StatRow, type TeamAdjustment } from './v4';

export interface V4Inputs {
  importance: ImportanceIndex;
  /** Passing rows per completed week, newest first (for QB weeks missed). */
  weekly: StatRow[][];
}

export async function loadV4Inputs(cfbd: CfbdClient, cfg: ModelV4Config, season: number, week: number): Promise<V4Inputs> {
  const [rush, rec, def] = [await cfbd.playerStats(season, 'rushing'), await cfbd.playerStats(season, 'receiving'), await cfbd.playerStats(season, 'defensive')];
  const weekly: StatRow[][] = [];
  for (let w = week - 1; w >= 1 && w >= week - cfg.qb.weeks_checked; w--) weekly.push(await cfbd.playerStats(season, 'passing', { start: w, end: w }));
  return { importance: buildImportance(rush, rec, def), weekly };
}

/** One team's v4 adjustment as of `atIso`, memoized per run by the caller. */
export function adjustmentFor(db: Db, cfg: ModelV4Config, inputs: V4Inputs, starters: Map<string, Starter>, team: string, atIso: string): TeamAdjustment {
  const starter = starters.get(team);
  const missed = starter ? weeksMissed(inputs.weekly, team, starter.player) : 0;
  return teamAdjustment(cfg, team, latestStatuses(db, cfg, team, atIso), inputs.importance, starter, missed, coachChanges(db, cfg, team, atIso));
}

/** "Texas -3.4 (Smothers RB out 1.4, Simmons EDGE questionable 0.4, ...)" for logs. */
export function describe(a: TeamAdjustment, max = 4): string {
  if (a.points < 0.05 && a.coach.length === 0) return `${a.team} 0`;
  const parts = a.items.slice(0, max).map((i) => `${i.player.split(' ').slice(-1)[0]} ${i.group} ${i.status} ${i.points.toFixed(1)}`);
  if (a.items.length > max) parts.push(`+${a.items.length - max} more`);
  for (const c of a.coach) parts.push(`${c.role === 'head' ? 'HC' : c.role === 'coordinator' ? 'coord' : 'staff'} change${c.name ? ` (${c.name})` : ''}`);
  return `${a.team} -${a.points.toFixed(1)} (${parts.join(', ')})`;
}
