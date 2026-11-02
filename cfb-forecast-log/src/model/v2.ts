/**
 * Model v2 ("v2-qb"): v1-blend, then a fixed penalty for a team whose
 * starting quarterback is reported out or doubtful as of the snapshot.
 *
 *   logit(p2) = logit(p1) - k * w(yes team) + k * w(opponent)
 *   k = qb.out_points * points_to_logit
 *   w = status weight of the starter's latest qualifying fact (0 if none)
 *
 * "Starter" = the team's season leader in pass attempts, if he has at least
 * min_starter_share of the team's attempts. A backup being out does nothing.
 * Only facts with as_of <= snapshot time are used, so a logged v2 row never
 * sees news published after it was written.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Db } from '../db';
import { CONFIG_DIR } from '../paths';
import { clamp, sigmoid } from '../util/math';

export const ModelV2ConfigSchema = z.object({
  model_version: z.string().min(1),
  base_model_version: z.string().min(1),
  created_at: z.string(),
  points_to_logit: z.number().positive(),
  qb: z.object({
    out_points: z.number().nonnegative(),
    status_weights: z.record(z.string(), z.number().min(0).max(1)),
    lookback_days: z.number().positive(),
    min_confidence: z.number().min(0).max(1),
    min_starter_share: z.number().min(0).max(1),
  }),
  clamp: z.tuple([z.number(), z.number()]),
  _note: z.string().optional(),
});
export type ModelV2Config = z.infer<typeof ModelV2ConfigSchema>;

export function loadModelV2Config(): ModelV2Config {
  return ModelV2ConfigSchema.parse(JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'model-v2.json'), 'utf8')));
}

// ------------------------------------------------------------ names

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

/** Lowercase, strip accents, punctuation and Jr./III, split into words. */
export function nameTokens(name: string): string[] {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s-]/g, '')
    .split(/[\s-]+/)
    .filter((t) => t && !SUFFIXES.has(t));
}

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

/**
 * Does a name heard on a podcast refer to this rostered player? Transcripts
 * misspell names (Kamario/Kamarion, Graceson/Grayson, Kade/Cade), so: last
 * names must match within one edit (exact if short), and first names, when
 * both are present, must match within two edits or share an initial sound.
 */
export function sameName(spoken: string, rostered: string): boolean {
  const s = nameTokens(spoken);
  const r = nameTokens(rostered);
  if (s.length === 0 || r.length === 0) return false;
  const sLast = s[s.length - 1];
  const rLast = r[r.length - 1];
  const lastOk = sLast === rLast || (Math.min(sLast.length, rLast.length) >= 5 && editDistance(sLast, rLast) <= 1);
  if (!lastOk) return false;
  if (s.length === 1 || r.length === 1) return true; // "Manning" alone
  const sFirst = s[0];
  const rFirst = r[0];
  const soundsAlike = (x: string) => x.replace(/^c/, 'k');
  return editDistance(sFirst, rFirst) <= 2 || soundsAlike(sFirst)[0] === soundsAlike(rFirst)[0];
}

// ------------------------------------------------------------ starters

export interface Starter {
  team: string;
  player: string;
  attempts: number;
  share: number;
}

/** Season pass-attempt leader per team, when he has at least `minShare` of the team's attempts. */
export function startersFromAttempts(rows: { team: string; player: string; attempts: number }[], minShare: number): Map<string, Starter> {
  const byTeam = new Map<string, { team: string; player: string; attempts: number }[]>();
  for (const r of rows) {
    if (!byTeam.has(r.team)) byTeam.set(r.team, []);
    byTeam.get(r.team)!.push(r);
  }
  const out = new Map<string, Starter>();
  for (const [team, list] of byTeam) {
    const total = list.reduce((a, b) => a + b.attempts, 0);
    if (total <= 0) continue;
    const top = list.reduce((a, b) => (b.attempts > a.attempts ? b : a));
    const share = top.attempts / total;
    if (share >= minShare) out.set(team, { team, player: top.player, attempts: top.attempts, share });
  }
  return out;
}

// ------------------------------------------------------------ facts

export interface QbStatus {
  team: string;
  player: string;
  status: string;
  weight: number;
  as_of: string;
  detail: string | null;
}

interface FactRow {
  team: string;
  player: string;
  status: string;
  scope: string;
  as_of: string;
  detail: string | null;
  confidence: number | null;
}

/**
 * The starter's availability for a team as of `atIso`: the most recent QB
 * fact about him (published at or before `atIso`, within lookback_days, or
 * any time this season if it was stated as season-ending). The latest fact
 * wins, so "out" followed by "full go" clears the penalty. Returns null when
 * no fact names the starter.
 */
export function starterStatus(db: Db, cfg: ModelV2Config, team: string, starter: Starter | undefined, atIso: string): QbStatus | null {
  if (!starter) return null;
  const since = new Date(Date.parse(atIso) - cfg.qb.lookback_days * 86_400_000).toISOString();
  const seasonStart = `${new Date(atIso).getUTCFullYear()}-07-01T00:00:00.000Z`;
  const rows = db
    .prepare(
      `SELECT team, player, status, scope, as_of, detail, confidence FROM news_facts
        WHERE team = ? AND position = 'QB' AND player IS NOT NULL AND status <> 'unknown'
          AND as_of <= ? AND (as_of >= ? OR (scope = 'season' AND as_of >= ?))
          AND COALESCE(confidence, 0) >= ?
        ORDER BY as_of DESC`,
    )
    .all(team, atIso, since, seasonStart, cfg.qb.min_confidence) as FactRow[];
  const mine = rows.filter((r) => sameName(r.player, starter.player));
  if (mine.length === 0) return null;
  // Same publish time, conflicting statuses: take the more severe one.
  const latest = mine.filter((r) => r.as_of === mine[0].as_of);
  const weightOf = (s: string) => cfg.qb.status_weights[s] ?? 0;
  const pick = latest.reduce((a, b) => (weightOf(b.status) > weightOf(a.status) ? b : a));
  return { team, player: starter.player, status: pick.status, weight: weightOf(pick.status), as_of: pick.as_of, detail: pick.detail };
}

function logit(p: number): number {
  return Math.log(p / (1 - p));
}

export interface V2Prediction {
  prob: number;
  shift_logit: number;
  yes_qb: QbStatus | null;
  opp_qb: QbStatus | null;
}

/** Apply the QB adjustment to a v1 probability. */
export function adjustForQb(cfg: ModelV2Config, p1: number, yesQb: QbStatus | null, oppQb: QbStatus | null): V2Prediction {
  const k = cfg.qb.out_points * cfg.points_to_logit;
  const shift = -k * (yesQb?.weight ?? 0) + k * (oppQb?.weight ?? 0);
  const [lo, hi] = cfg.clamp;
  return { prob: clamp(sigmoid(logit(p1) + shift), lo, hi), shift_logit: shift, yes_qb: yesQb, opp_qb: oppQb };
}
