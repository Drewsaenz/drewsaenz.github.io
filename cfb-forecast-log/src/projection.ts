/**
 * Projected scores for games the log has no market for yet (later weeks), and a
 * score view of the logged ones. The models only give P(win), so a score is
 * built from two pieces:
 *
 *   margin = the win probability read back through the same normal curve the
 *            Vegas comparison uses (sd = vegas_std_dev), so 50% is 0 and 64.6%
 *            is about +5 with sd 13.5.
 *   total  = the Vegas over/under when a book has posted one, else SP+: each
 *            side scores its offense rating plus the opponent's defense rating
 *            minus the national average (SP+ units are points a game against an
 *            average opponent).
 *
 * team = (total + margin) / 2, opponent = (total - margin) / 2. Nothing here is
 * fitted or logged: it reads the forecasts and ratings and writes no rows.
 */
import { clamp, normalCdf } from './util/math';

/** Inverse of the standard normal CDF by bisection; p is clamped to [0.001, 0.999]. */
export function normalQuantile(p: number): number {
  const q = clamp(p, 0.001, 0.999);
  let lo = -6;
  let hi = 6;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (normalCdf(mid) < q) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** P(team wins) -> expected margin in points for that team. */
export function probToMargin(p: number, sd: number): number {
  return sd * normalQuantile(p);
}

/** SP+ points for an offense against a defense. */
export function spPoints(off: number, oppDef: number, avg: number): number {
  return off + oppDef - avg;
}

export function splitScore(total: number, margin: number): { team: number; opp: number } {
  return { team: (total + margin) / 2, opp: (total - margin) / 2 };
}
