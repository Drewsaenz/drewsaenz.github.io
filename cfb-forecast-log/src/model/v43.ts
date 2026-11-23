/**
 * Depth-chart layer ("v4.3-avail", the injury layer of v5.3-fused): v4.2's
 * availability adjustment, plus a starting quarterback who lost the job
 * without being hurt.
 *
 * Week 12, Oklahoma-Texas A&M: about ten outlets reported Brady Hart starting
 * over Marcel Reed. The SEC availability report kept Reed "Available" (he was
 * healthy), which under v4.1's layering is the whole truth, and benchings were
 * stored under whatever health status the extractor guessed. v5.1 and v5.2
 * saw nothing.
 *
 * Facts now carry `role` (starter | benched | competition | none), a coach's
 * lineup decision, separate from health. For the team's starting QB (the
 * season pass-attempt leader, as everywhere else):
 *   - each outlet's latest word since the team's previous game is one vote:
 *     "benched" (he is benched, or another QB is named the starter),
 *     "competition" (the coach has not decided), or "starter" (he starts);
 *   - a vote counts once `min_sources` outlets cast it; the most recently
 *     corroborated vote wins, so two outlets saying he starts after all clear
 *     an earlier benching. One "benched" and one "competition" outlet add up
 *     to "competition";
 *   - "another QB will start" corroborates a benching but cannot establish one:
 *     at least one outlet must say the starter himself was benched. Otherwise
 *     injury replacements and "if he can't go, the backup starts" would count;
 *   - an official availability report never enters: "Available" says he is
 *     healthy, not that he starts;
 *   - recaps (game_ref "previous": "was pulled in the fourth quarter") do not vote.
 * The QB item is the larger of the health penalty and
 * bench_points x role weight; they do not stack. bench_points is a prior.
 */
import type { Db } from '../db';
import { sameName, type Starter } from './v2';
import { siteOf, type ModelV4Config, type TeamAdjustment } from './v4';

export type DepthVote = 'benched' | 'competition' | 'starter';

export interface DepthChartStatus {
  player: string;
  status: 'benched' | 'competition';
  weight: number;
  outlets: number;
  as_of: string;
  detail: string | null;
}

interface RoleRow {
  player: string | null;
  role: string;
  as_of: string;
  detail: string | null;
  source_channel: string | null;
  source_url: string | null;
}

const SEVERITY: Record<DepthVote, number> = { benched: 2, competition: 1, starter: 0 };

/** What one fact says about the starter's job, or null when it says nothing. */
export function voteOf(r: Pick<RoleRow, 'player' | 'role'>, starter: string): DepthVote | null {
  if (r.role === 'competition') return 'competition'; // about him, another QB, or nobody by name
  if (!r.player) return null;
  const him = r.player === starter || sameName(r.player, starter);
  if (r.role === 'benched') return him ? 'benched' : null;
  if (r.role === 'starter') return him ? 'starter' : 'benched';
  return null;
}

/** The starting QB's depth-chart status for `team` as of `atIso`, or null when he is not reported benched or in a competition. */
export function depthChart(db: Db, cfg: ModelV4Config, team: string, starter: Starter | undefined, atIso: string): DepthChartStatus | null {
  const dc = cfg.depth_chart;
  if (!dc || !starter) return null;
  const since = new Date(Date.parse(atIso) - cfg.lookback_days * 86_400_000).toISOString();
  const prev = (db.prepare(`SELECT MAX(kickoff_utc) AS k FROM games WHERE (home_team = ? OR away_team = ?) AND kickoff_utc < ?`).get(team, team, atIso) as { k: string | null }).k;
  const rows = db
    .prepare(
      `SELECT player, role, as_of, detail, source_channel, source_url FROM news_facts
        WHERE team = ? AND position = 'QB' AND role IN ('starter', 'benched', 'competition')
          AND COALESCE(game_ref, '') <> 'previous' AND model <> ?
          AND as_of <= ? AND as_of > ? AND COALESCE(confidence, 0) >= ?
        ORDER BY as_of DESC`,
    )
    .all(team, cfg.sources?.official_model ?? 'availability-report', atIso, prev ?? since, cfg.min_confidence) as RoleRow[];

  // Each outlet's latest word (rows are newest first; at the same instant the more severe vote).
  const perOutlet = new Map<string, { vote: DepthVote; row: RoleRow }>();
  const explicit = new Set<string>(); // outlets that said the starter himself is benched
  for (const r of rows) {
    const vote = voteOf(r, starter.player);
    if (!vote) continue;
    const k = r.source_channel ?? siteOf(r.source_url);
    if (r.role === 'benched') explicit.add(k);
    const have = perOutlet.get(k);
    if (!have || (have.row.as_of === r.as_of && SEVERITY[vote] > SEVERITY[have.vote])) perOutlet.set(k, { vote, row: r });
  }
  const by = (v: DepthVote) => [...perOutlet.values()].filter((x) => x.vote === v).map((x) => x.row); // newest first
  const need = dc.min_sources;
  // "Another QB will start" alone is not a benching: it is also what an injury replacement and
  // "if he can't go, the backup starts" look like. At least one outlet must say he was benched.
  const benchedSaid = [...perOutlet.entries()].some(([k, x]) => x.vote === 'benched' && explicit.has(k));
  // When each vote became corroborated: the time its `need`-th newest outlet spoke.
  const corroborated = (['benched', 'competition', 'starter'] as DepthVote[])
    .map((v) => ({ v, rows: by(v) }))
    .filter((x) => x.rows.length >= need && (x.v !== 'benched' || benchedSaid))
    .map((x) => ({ ...x, at: x.rows[need - 1].as_of }))
    .sort((a, b) => (a.at === b.at ? SEVERITY[b.v] - SEVERITY[a.v] : a.at < b.at ? 1 : -1));
  let pick: { v: DepthVote; rows: RoleRow[] } | null = corroborated[0] ?? null;
  if (!pick) {
    const unsure = [...(benchedSaid ? by('benched') : []), ...by('competition')].sort((a, b) => (a.as_of < b.as_of ? 1 : -1));
    if (unsure.length >= need) pick = { v: 'competition', rows: unsure };
  }
  if (!pick || pick.v === 'starter') return null;
  const weight = dc.role_weights[pick.v] ?? 0;
  if (weight <= 0) return null;
  return { player: starter.player, status: pick.v, weight, outlets: pick.rows.length, as_of: pick.rows[0].as_of, detail: pick.rows[0].detail };
}

/** Fold the depth-chart status into a team's adjustment: the QB item becomes the larger of health and role. */
export function applyDepthChart(cfg: ModelV4Config, adj: TeamAdjustment, dc: DepthChartStatus | null): TeamAdjustment {
  if (!dc || !cfg.depth_chart) return adj;
  const pts = cfg.depth_chart.bench_points * dc.weight;
  const health = adj.items.find((i) => i.group === 'QB');
  if (pts <= (health?.points ?? 0)) return adj;
  const item = { player: dc.player, group: 'QB' as const, status: dc.status, points: pts, note: `starter; ${dc.status === 'benched' ? 'benched' : 'job undecided'} per ${dc.outlets} outlets (depth chart, not injury)` };
  const items = [...adj.items.filter((i) => i !== health), item].sort((a, b) => b.points - a.points);
  return { ...adj, items, points: adj.points - (health?.points ?? 0) + pts };
}
