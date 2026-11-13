/**
 * Model v4 ("v4-avail"): v1-blend ratings, adjusted for who is actually
 * available on both teams and for recent coaching changes.
 *
 *   logit(p4) = logit(v1) + k * (lost(opponent) - lost(yes team))
 *   k = points_to_logit (logit per point of spread)
 *
 * lost(team), in points of spread, from the latest qualifying fact per player
 * (official availability reports, articles, shows), weighted by status:
 *   QB      the season pass-attempt leader only; qb.points, faded when he has
 *           already missed recent weeks (the ratings have partly absorbed it)
 *   RB      rb_points       x his share of team rushing yards
 *   WR/TE   receiver_points x his share of team receiving yards
 *   defense defense_points  x his share of team defensive impact
 *           (tackles + 2 TFL + 3 sacks + 2 passes defended)
 *   OL      ol_points_each per lineman, capped (no line stats exist)
 *   non-QB total capped at non_qb_cap
 * plus coach.head_coach_change_points when the head coach was fired or
 * replaced within coach.window_days (coordinator changes are listed, and
 * weighted by coordinator_change_points).
 *
 * Every number in config/model-v4.json is a prior, not a fit: there is no
 * history of availability reports to fit on yet. Changing one after v4 rows
 * exist means a new model_version.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Db } from '../db';
import { CONFIG_DIR } from '../paths';
import { clamp, sigmoid } from '../util/math';
import { nameTokens, sameName, type Starter } from './v2';
import { logit } from './v3';

export const ModelV4ConfigSchema = z.object({
  model_version: z.string().min(1),
  base_model_version: z.string().min(1),
  created_at: z.string(),
  points_to_logit: z.number().positive(),
  status_weights: z.record(z.string(), z.number().min(0).max(1)),
  lookback_days: z.number().positive(),
  min_confidence: z.number().min(0).max(1),
  qb: z.object({
    points: z.number().nonnegative(),
    min_starter_share: z.number().min(0).max(1),
    weeks_checked: z.number().int().min(0),
    fade_per_missed_week: z.number().min(0).max(1),
    min_fade: z.number().min(0).max(1),
  }),
  rb_points: z.number().nonnegative(),
  receiver_points: z.number().nonnegative(),
  defense_points: z.number().nonnegative(),
  ol_points_each: z.number().nonnegative(),
  ol_cap: z.number().nonnegative(),
  non_qb_cap: z.number().nonnegative(),
  coach: z.object({
    window_days: z.number().positive(),
    head_coach_change_points: z.number(),
    coordinator_change_points: z.number(),
  }),
  /**
   * v4.1+: how sources are layered. Absent (v4-avail) = the latest fact from
   * any source wins. Present: an official availability report posted since the
   * team's last game is the whole truth up to its posting time (players it
   * does not list are available); other facts count only if newer than that
   * report (or when there is no report) and only when at least
   * min_unofficial_sources different outlets agree.
   */
  sources: z
    .object({
      official_model: z.string().min(1),
      min_unofficial_sources: z.number().int().min(1),
    })
    .optional(),
  clamp: z.tuple([z.number(), z.number()]),
  _note: z.string().optional(),
});
export type ModelV4Config = z.infer<typeof ModelV4ConfigSchema>;

/** config/model-v4.json (v4-avail) by default; pass 'model-v4.1.json' for v4.1-avail. */
export function loadModelV4Config(file = 'model-v4.json'): ModelV4Config {
  return ModelV4ConfigSchema.parse(JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, file), 'utf8')));
}

// ------------------------------------------------------------ player importance

export interface StatRow {
  player: string;
  team: string;
  position: string | null;
  statType: string;
  stat: number;
}

export interface Importance {
  name: string;
  position: string | null;
  rush: number; // share of team rushing yards
  rec: number; // share of team receiving yards
  def: number; // share of team defensive impact
}

export type ImportanceIndex = Map<string, Importance[]>;

const key = (name: string) => nameTokens(name).join(' ');

/** Season stat rows (rushing, receiving, defensive) -> each player's share of his team's production. */
export function buildImportance(rush: StatRow[], rec: StatRow[], def: StatRow[]): ImportanceIndex {
  const players = new Map<string, Importance & { team: string }>();
  const get = (r: StatRow) => {
    const k = `${r.team}|${key(r.player)}`;
    let p = players.get(k);
    if (!p) {
      p = { team: r.team, name: r.player, position: r.position, rush: 0, rec: 0, def: 0 };
      players.set(k, p);
    }
    if (!p.position && r.position) p.position = r.position;
    return p;
  };
  const DEF_W: Record<string, number> = { TOT: 1, TFL: 2, SACKS: 3, PD: 2 };
  for (const r of rush) if (r.statType === 'YDS') get(r).rush += Math.max(0, r.stat);
  for (const r of rec) if (r.statType === 'YDS') get(r).rec += Math.max(0, r.stat);
  for (const r of def) if (DEF_W[r.statType]) get(r).def += Math.max(0, r.stat) * DEF_W[r.statType];
  const totals = new Map<string, { rush: number; rec: number; def: number }>();
  for (const p of players.values()) {
    const t = totals.get(p.team) ?? { rush: 0, rec: 0, def: 0 };
    t.rush += p.rush;
    t.rec += p.rec;
    t.def += p.def;
    totals.set(p.team, t);
  }
  const out: ImportanceIndex = new Map();
  for (const p of players.values()) {
    const t = totals.get(p.team)!;
    const row: Importance = { name: p.name, position: p.position, rush: t.rush ? p.rush / t.rush : 0, rec: t.rec ? p.rec / t.rec : 0, def: t.def ? p.def / t.def : 0 };
    if (!out.has(p.team)) out.set(p.team, []);
    out.get(p.team)!.push(row);
  }
  return out;
}

export function lookupImportance(index: ImportanceIndex, team: string, player: string): Importance | null {
  const list = index.get(team);
  if (!list) return null;
  const k = key(player);
  const exact = list.find((p) => key(p.name) === k);
  if (exact) return exact;
  const loose = list.filter((p) => sameName(player, p.name));
  return loose.length === 1 ? loose[0] : null;
}

export type Group = 'QB' | 'RB' | 'REC' | 'OL' | 'DEF' | 'OTHER';
export function positionGroup(pos: string | null | undefined): Group {
  const p = (pos ?? '').toUpperCase();
  if (p === 'QB') return 'QB';
  if (p === 'RB' || p === 'FB') return 'RB';
  if (p === 'WR' || p === 'TE') return 'REC';
  if (['OL', 'OT', 'OG', 'G', 'C', 'IOL'].includes(p)) return 'OL';
  if (['DL', 'DT', 'DE', 'NT', 'EDGE', 'EDG', 'LB', 'ILB', 'OLB', 'MLB', 'DB', 'CB', 'S', 'FS', 'SS', 'NCK', 'JCK', 'STR', 'DS'].includes(p)) return 'DEF';
  return 'OTHER';
}

// ------------------------------------------------------------ QB games missed

/**
 * Consecutive recent weeks (newest first) in which the team threw passes but
 * the starter had no attempts. `weeks` is newest-first passing ATT rows per week.
 */
export function weeksMissed(weeks: StatRow[][], team: string, starter: string): number {
  let missed = 0;
  for (const rows of weeks) {
    const mine = rows.filter((r) => r.team === team && r.statType === 'ATT');
    const teamAtt = mine.reduce((n, r) => n + r.stat, 0);
    if (teamAtt === 0) continue; // bye or no data
    const his = mine.filter((r) => key(r.player) === key(starter) || sameName(r.player, starter)).reduce((n, r) => n + r.stat, 0);
    if (his > 0) break;
    missed += 1;
  }
  return missed;
}

// ------------------------------------------------------------ facts

export interface PlayerStatus {
  player: string;
  position: string | null;
  status: string;
  weight: number;
  as_of: string;
  source: string | null;
  detail: string | null;
}

interface FactRow {
  player: string;
  position: string | null;
  status: string;
  scope: string | null;
  as_of: string;
  detail: string | null;
  confidence: number | null;
  source_channel: string | null;
}

/**
 * Each player's availability for a team as of `atIso`. v4-avail: the latest
 * qualifying fact from any source (ties take the more severe). With
 * cfg.sources (v4.1+): see layeredStatuses.
 */
export function latestStatuses(db: Db, cfg: ModelV4Config, team: string, atIso: string): PlayerStatus[] {
  if (cfg.sources) return layeredStatuses(db, cfg, cfg.sources, team, atIso);
  const since = new Date(Date.parse(atIso) - cfg.lookback_days * 86_400_000).toISOString();
  const seasonStart = `${new Date(atIso).getUTCFullYear()}-07-01T00:00:00.000Z`;
  const rows = db
    .prepare(
      `SELECT player, position, status, scope, as_of, detail, confidence, source_channel FROM news_facts
        WHERE team = ? AND player IS NOT NULL AND COALESCE(position, '') <> 'coach' AND status <> 'unknown' AND COALESCE(game_ref, '') <> 'previous'
          AND as_of <= ? AND (as_of >= ? OR (scope = 'season' AND as_of >= ?))
          AND COALESCE(confidence, 0) >= ?
        ORDER BY as_of DESC`,
    )
    .all(team, atIso, since, seasonStart, cfg.min_confidence) as FactRow[];
  const w = (s: string) => cfg.status_weights[s] ?? 0;
  const groups: FactRow[][] = [];
  for (const r of rows) {
    const g = groups.find((x) => x[0].player === r.player || sameName(x[0].player, r.player));
    if (g) g.push(r);
    else groups.push([r]);
  }
  return groups.map((g) => {
    const latest = g.filter((r) => r.as_of === g[0].as_of);
    const pick = latest.reduce((a, b) => (w(b.status) > w(a.status) ? b : a));
    const position = g.find((r) => r.position && r.position !== 'unknown')?.position ?? pick.position;
    return { player: pick.player, position, status: pick.status, weight: w(pick.status), as_of: pick.as_of, source: pick.source_channel, detail: pick.detail };
  });
}

const groupByPlayer = <T extends { player: string }>(rows: T[]): T[][] => {
  const groups: T[][] = [];
  for (const r of rows) {
    const g = groups.find((x) => x[0].player === r.player || sameName(x[0].player, r.player));
    if (g) g.push(r);
    else groups.push([r]);
  }
  return groups;
};

/**
 * v4.1 source layering. Official report first, then corroborated news.
 *   1. The latest official report for this team posted after its previous game
 *      and at or before `atIso` sets every listed player's status; anyone it
 *      does not list counts as available, whatever a show said earlier.
 *   2. Shows and articles count only when newer than that report (or for any
 *      team with no report), and only for a player at least
 *      `min_unofficial_sources` different outlets mention: the status used is
 *      the one that many outlets support (each outlet's latest word counts once).
 *      A corroborated post-report status overrides the report for that player.
 */
export function layeredStatuses(db: Db, cfg: ModelV4Config, src: NonNullable<ModelV4Config['sources']>, team: string, atIso: string): PlayerStatus[] {
  const since = new Date(Date.parse(atIso) - cfg.lookback_days * 86_400_000).toISOString();
  const seasonStart = `${new Date(atIso).getUTCFullYear()}-07-01T00:00:00.000Z`;
  const prev = (db.prepare(`SELECT MAX(kickoff_utc) AS k FROM games WHERE (home_team = ? OR away_team = ?) AND kickoff_utc < ?`).get(team, team, atIso) as { k: string | null }).k;
  const w = (s: string) => cfg.status_weights[s] ?? 0;
  const cols = `player, position, status, scope, as_of, detail, confidence, source_channel`;
  const base = `team = ? AND player IS NOT NULL AND COALESCE(position, '') <> 'coach' AND status <> 'unknown' AND COALESCE(game_ref, '') <> 'previous' AND as_of <= ?`;

  // 1. Official report.
  const official = db
    .prepare(`SELECT ${cols} FROM news_facts WHERE ${base} AND model = ? AND as_of > ? ORDER BY as_of DESC`)
    .all(team, atIso, src.official_model, prev ?? since) as FactRow[];
  const reportAt = official[0]?.as_of ?? null;
  const out = new Map<string, PlayerStatus>();
  for (const r of official.filter((x) => x.as_of === reportAt)) {
    const prior = [...out.values()].find((x) => sameName(x.player, r.player));
    if (prior && prior.weight >= w(r.status)) continue;
    if (prior) out.delete(prior.player);
    out.set(r.player, { player: r.player, position: r.position, status: r.status, weight: w(r.status), as_of: r.as_of, source: r.source_channel, detail: r.detail });
  }

  // 2. Corroborated shows and articles, newer than the report.
  const after = reportAt ?? since;
  const rows = db
    .prepare(
      `SELECT ${cols} FROM news_facts WHERE ${base} AND model <> ?
          AND (as_of > ? OR (? IS NULL AND scope = 'season' AND as_of >= ?))
          AND COALESCE(confidence, 0) >= ?
        ORDER BY as_of DESC`,
    )
    .all(team, atIso, src.official_model, after, reportAt, seasonStart, cfg.min_confidence) as FactRow[];
  for (const g of groupByPlayer(rows)) {
    const perSource = new Map<string, FactRow>();
    for (const r of g) {
      const k = r.source_channel ?? '?';
      if (!perSource.has(k)) perSource.set(k, r); // rows are newest first: keep each outlet's latest word
    }
    const voices = [...perSource.values()].sort((a, b) => w(b.status) - w(a.status));
    if (voices.length < src.min_unofficial_sources) continue;
    const pick = voices[src.min_unofficial_sources - 1]; // the strongest status that many outlets support
    const position = g.find((r) => r.position && r.position !== 'unknown')?.position ?? pick.position;
    const prior = [...out.values()].find((x) => sameName(x.player, pick.player));
    if (prior) out.delete(prior.player);
    out.set(pick.player, {
      player: prior?.player ?? pick.player,
      position: prior?.position && prior.position !== 'unknown' ? prior.position : position,
      status: pick.status,
      weight: w(pick.status),
      as_of: g[0].as_of,
      source: `${voices.length} outlets`,
      detail: pick.detail,
    });
  }
  return [...out.values()];
}

export interface CoachEvent {
  name: string | null;
  role: 'head' | 'coordinator' | 'other';
  detail: string;
  as_of: string;
}

const CHANGE_OUT = /\b(fired|dismiss|let go|part(ed|s)? ways|resign|reliev|step(ped|s)? down|depart|demot|no longer|out as|ousted|terminat)/i;
const CHANGE_IN = /\b(interim|promot|named|hired|take over|takes over|taking over|new (head coach|oc|dc|offensive coordinator|defensive coordinator|play-?caller)|play-?call)/i;

// The head coach is the one changing: "interim head coach", "named head coach", "fired head coach X", "head coach X was fired".
const HEAD_CHANGE = /\b(interim head coach|(named|hired|hires|as|new) (the |its |their )?head coach|(fired|fires|dismissed|let go|parted ways with|relieved|ousted|terminated) (its |their |the )?head coach|head coach \S+( \S+)? (was|has been|is|got) (fired|dismissed|let go|relieved|ousted|terminated))/i;
const COORD = /coordinator|\bOC\b|\bDC\b|play-?call/i;

/**
 * Which coach a change fact is about. A sentence that names the head coach as
 * the one making the move ("Head coach Dan Lanning fired offensive coordinator
 * Drew Mehringer") is a coordinator change, not a head-coach change.
 */
export function coachRole(detail: string): CoachEvent['role'] {
  if (HEAD_CHANGE.test(detail)) return 'head';
  if (COORD.test(detail)) return 'coordinator';
  if (/head coach/i.test(detail)) return 'head';
  return 'other';
}

/** Coaching changes for a team reported within coach.window_days before `atIso`. */
export function coachChanges(db: Db, cfg: ModelV4Config, team: string, atIso: string): CoachEvent[] {
  const since = new Date(Date.parse(atIso) - cfg.coach.window_days * 86_400_000).toISOString();
  const rows = db
    .prepare(`SELECT player, status, detail, as_of FROM news_facts WHERE team = ? AND position = 'coach' AND as_of <= ? AND as_of >= ? AND COALESCE(confidence, 0) >= ? ORDER BY as_of DESC`)
    .all(team, atIso, since, cfg.min_confidence) as { player: string | null; status: string; detail: string | null; as_of: string }[];
  const out: CoachEvent[] = [];
  for (const r of rows) {
    const d = r.detail ?? '';
    const isChange = (r.status === 'out' && CHANGE_OUT.test(d)) || CHANGE_IN.test(d);
    if (!isChange) continue;
    if (out.some((e) => e.name && r.player && sameName(e.name, r.player))) continue;
    out.push({ name: r.player, role: coachRole(d), detail: d, as_of: r.as_of });
  }
  return out;
}

// ------------------------------------------------------------ adjustment

export interface LostItem {
  player: string;
  group: Group;
  status: string;
  points: number;
  note: string;
}

export interface TeamAdjustment {
  team: string;
  points: number; // points of spread lost
  items: LostItem[];
  coach: CoachEvent[];
  coachPoints: number;
}

export function teamAdjustment(
  cfg: ModelV4Config,
  team: string,
  statuses: PlayerStatus[],
  importance: ImportanceIndex,
  starter: Starter | undefined,
  missed: number,
  coach: CoachEvent[],
): TeamAdjustment {
  const items: LostItem[] = [];
  let qb = 0;
  let ol = 0;
  let other = 0;
  for (const s of statuses) {
    if (s.weight <= 0) continue;
    const imp = lookupImportance(importance, team, s.player);
    const group = positionGroup(imp?.position ?? s.position);
    let pts = 0;
    let note = '';
    if (group === 'QB') {
      if (!starter || !(starter.player === s.player || sameName(s.player, starter.player))) continue; // backups don't count
      const fade = Math.max(cfg.qb.min_fade, 1 - cfg.qb.fade_per_missed_week * missed);
      pts = cfg.qb.points * s.weight * fade;
      note = missed > 0 ? `starter; missed ${missed} straight week(s), so ${Math.round(fade * 100)}% of the penalty` : 'starter';
      qb += pts;
    } else if (group === 'RB') {
      pts = cfg.rb_points * (imp?.rush ?? 0) * s.weight;
      note = `${Math.round((imp?.rush ?? 0) * 100)}% of team rushing yards`;
    } else if (group === 'REC') {
      pts = cfg.receiver_points * (imp?.rec ?? 0) * s.weight;
      note = `${Math.round((imp?.rec ?? 0) * 100)}% of team receiving yards`;
    } else if (group === 'DEF') {
      pts = cfg.defense_points * (imp?.def ?? 0) * s.weight;
      note = `${Math.round((imp?.def ?? 0) * 100)}% of team defensive impact`;
    } else if (group === 'OL') {
      pts = cfg.ol_points_each * s.weight;
      note = 'offensive line (flat value)';
      ol += pts;
    } else continue;
    if (group !== 'QB' && group !== 'OL') other += pts;
    if (pts > 0.005) items.push({ player: s.player, group, status: s.status, points: pts, note });
  }
  const nonQb = Math.min(cfg.non_qb_cap, other + Math.min(cfg.ol_cap, ol));
  const head = coach.some((c) => c.role === 'head');
  const coord = coach.some((c) => c.role === 'coordinator');
  const coachPoints = (head ? cfg.coach.head_coach_change_points : 0) + (coord ? cfg.coach.coordinator_change_points : 0);
  items.sort((a, b) => b.points - a.points);
  return { team, points: qb + nonQb + coachPoints, items, coach, coachPoints };
}

/** v4 probability for the yes team from its v1 probability and both teams' adjustments. */
export function predictV4(cfg: ModelV4Config, p1: number, yes: TeamAdjustment, opp: TeamAdjustment): number {
  const z = logit(p1) + cfg.points_to_logit * (opp.points - yes.points);
  const [lo, hi] = cfg.clamp;
  return clamp(sigmoid(z), lo, hi);
}
