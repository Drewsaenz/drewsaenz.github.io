/**
 * Model v5.1 ("v5.1-fused"): v5's formula and fitted weights, with an injury
 * term that counts only news the line is unlikely to have priced yet.
 *
 * Week 11 showed v5 moving away from Vegas on old news: a starting QB out for
 * three weeks, a two-week-old benching stored as "limited", a coordinator fired
 * two weeks earlier. The line knew all of it. v5.1 keeps v4.1's adjustment
 * (official report first, two outlets otherwise) and then drops:
 *   - a starting QB who already missed the team's previous game (CFBD weekly
 *     passing: no attempts while the team threw);
 *   - any other player who was already listed out or doubtful for the previous
 *     game (a fact before its kickoff within prev_window_days, or a season-long
 *     status stated before it);
 *   - coaching changes reported before the previous game kicked off.
 * Caps (OL, non-QB) are re-applied to what is left. With no previous game on
 * file, nothing is dropped.
 *
 * Same fitted coefficients as v5 (config/model-v5.1.json copies them): the
 * injury weight c was held at its prior in that fit, so nothing was learned
 * from the old-news term that this version removes.
 */
import type { Db } from '../db';
import { sameName } from './v2';
import type { LostItem, ModelV4Config, TeamAdjustment } from './v4';

export interface FreshOptions {
  /** How far before the previous kickoff an "out/doubtful" fact still describes that game. */
  prev_window_days: number;
}

export const DEFAULT_FRESH: FreshOptions = { prev_window_days: 10 };

/** Kickoff of the team's most recent game before `atIso`, or null. */
export function previousKickoff(db: Db, team: string, atIso: string): string | null {
  return (db.prepare(`SELECT MAX(kickoff_utc) AS k FROM games WHERE (home_team = ? OR away_team = ?) AND kickoff_utc < ?`).get(team, team, atIso) as { k: string | null }).k;
}

/** Was this player already listed out or doubtful for the game that kicked off at `prevKick`? */
export function alreadyOut(db: Db, team: string, player: string, prevKick: string, opts: FreshOptions = DEFAULT_FRESH): boolean {
  const from = new Date(Date.parse(prevKick) - opts.prev_window_days * 86_400_000).toISOString();
  const season = `${prevKick.slice(0, 4)}-07-01T00:00:00.000Z`;
  const rows = db
    .prepare(
      `SELECT player FROM news_facts
        WHERE team = ? AND player IS NOT NULL AND status IN ('out', 'doubtful') AND COALESCE(game_ref, '') <> 'previous'
          AND COALESCE(confidence, 0) >= 0.5 AND as_of <= ?
          AND (as_of >= ? OR (scope = 'season' AND as_of >= ?))`,
    )
    .all(team, prevKick, from, season) as { player: string }[];
  return rows.some((r) => r.player === player || sameName(r.player, player));
}

/**
 * v4.1 adjustment -> only what is new since the team's previous game.
 * `qbMissed` = straight weeks the starting QB has already missed (weeksMissed).
 */
export function freshAdjustment(db: Db, cfg: ModelV4Config, adj: TeamAdjustment, atIso: string, qbMissed: number, opts: FreshOptions = DEFAULT_FRESH): TeamAdjustment & { dropped: LostItem[] } {
  const prevKick = previousKickoff(db, adj.team, atIso);
  if (!prevKick) return { ...adj, dropped: [] };
  const kept: LostItem[] = [];
  const dropped: LostItem[] = [];
  for (const i of adj.items) {
    const stale = i.group === 'QB' ? qbMissed > 0 : alreadyOut(db, adj.team, i.player, prevKick, opts);
    (stale ? dropped : kept).push(i);
  }
  const coach = adj.coach.filter((c) => Date.parse(c.as_of) > Date.parse(prevKick));
  const qb = kept.filter((i) => i.group === 'QB').reduce((n, i) => n + i.points, 0);
  const ol = kept.filter((i) => i.group === 'OL').reduce((n, i) => n + i.points, 0);
  const other = kept.filter((i) => i.group !== 'QB' && i.group !== 'OL').reduce((n, i) => n + i.points, 0);
  const nonQb = Math.min(cfg.non_qb_cap, other + Math.min(cfg.ol_cap, ol));
  const head = coach.some((c) => c.role === 'head');
  const coord = coach.some((c) => c.role === 'coordinator');
  const coachPoints = (head ? cfg.coach.head_coach_change_points : 0) + (coord ? cfg.coach.coordinator_change_points : 0);
  return { team: adj.team, points: qb + nonQb + coachPoints, items: kept, coach, coachPoints, dropped };
}
