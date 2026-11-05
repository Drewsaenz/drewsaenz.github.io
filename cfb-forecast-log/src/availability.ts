/**
 * Official conference availability reports -> news_facts.
 *
 * TranscriptGPT's availability.js saves each report as slim JSON under
 * data/availability/<source>/. This module turns one team's rows into Facts
 * with confidence 1.0, no model involved. The report's posting time (local
 * conference time) becomes as_of, so v2 and the News check see the official
 * status as of when it was published.
 */
import { z } from 'zod';
import type { Fact } from './news';

const Row = z.object({ pos: z.string().nullable(), jersey: z.string().nullable(), name: z.string(), status: z.string(), exempt: z.string().nullable() });
const Team = z.object({ team: z.string(), opponent: z.string().nullable(), rows: z.array(Row) });
const Game = z.object({
  game_key: z.string(),
  report_type: z.string().nullable(),
  publish_date: z.string().nullable(),
  posted_time: z.string().nullable(),
  time_zone: z.string().nullable(),
  kickoff_date: z.string().nullable(),
  kickoff_time: z.string().nullable(),
  location: z.string().nullable(),
  neutral: z.boolean(),
  teams: z.array(Team),
});
export const AvailabilityFileSchema = z.object({ source: z.string(), page: z.string().nullable(), fetched_at: z.string(), games: z.array(Game) });
export type AvailabilityFile = z.infer<typeof AvailabilityFileSchema>;
export type AvailabilityGame = z.infer<typeof Game>;
export type AvailabilityTeam = z.infer<typeof Team>;

/** Report position codes -> the fact position enum. */
const POSITION: Record<string, Fact['position']> = {
  QB: 'QB', RB: 'RB', FB: 'RB', WR: 'WR', TE: 'TE',
  OL: 'OL', OT: 'OL', OG: 'OL', G: 'OL', C: 'OL', IOL: 'OL',
  DL: 'DL', DT: 'DL', DE: 'DL', NT: 'DL',
  EDG: 'EDGE', EDGE: 'EDGE',
  LB: 'LB', ILB: 'LB', OLB: 'LB', MLB: 'LB',
  DB: 'DB', CB: 'DB', S: 'DB', FS: 'DB', SS: 'DB', NCK: 'DB', JCK: 'DB', STR: 'DB', DS: 'DB',
  K: 'K', PK: 'K', P: 'P',
};
export function factPosition(code: string | null): Fact['position'] {
  return (code && POSITION[code.toUpperCase()]) || 'unknown';
}

/** Report status -> fact status; null for anything this pipeline should not store. */
export function factStatus(status: string): Fact['status'] | null {
  const s = status.trim().toLowerCase();
  if (s === 'out') return 'out';
  if (s.startsWith('out - (1st half)') || s.startsWith('out (1st half)')) return 'limited';
  if (s === 'doubtful') return 'doubtful';
  if (s === 'questionable' || s === 'game time decision') return 'questionable';
  if (s === 'probable') return 'probable';
  if (s === 'available') return 'available';
  return null;
}

const ZONES: Record<string, string> = { CT: 'America/Chicago', ET: 'America/New_York', MT: 'America/Denver', PT: 'America/Los_Angeles' };

/** Local wall time in a conference time zone ("2026-11-04", "19:10:00", "CT") -> ISO UTC. */
export function localToUtc(date: string, time: string, zone: string | null): string {
  const tz = ZONES[(zone ?? 'CT').toUpperCase()] ?? 'America/Chicago';
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi, s] = time.split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi, s || 0);
  // Offset of the zone at (about) that instant, computed twice to settle DST edges.
  const offsetAt = (t: number) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
        .formatToParts(new Date(t))
        .map((x) => [x.type, x.value]),
    );
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - t;
  };
  let t = wall - offsetAt(wall);
  t = wall - offsetAt(t);
  return new Date(t).toISOString();
}

/** Drop nicknames in quotes: 'Karle "KJ" Lacey Jr.' -> 'Karle Lacey Jr.' */
export function cleanName(name: string): string {
  return name.replace(/\s*["“][^"”]*["”]\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

export interface TeamReport {
  url: string;
  title: string;
  channel: string;
  as_of: string;
  facts: Fact[];
}

/**
 * One team's rows from one report -> facts. `keepAvailable(name)` decides
 * whether an "Available" row is worth storing (normally: only when the player
 * had a non-available fact recently, so the report clears it).
 */
export function teamReportFacts(source: string, page: string | null, g: AvailabilityGame, t: AvailabilityTeam, keepAvailable: (name: string) => boolean): TeamReport | null {
  if (!g.publish_date || !g.posted_time) return null;
  const as_of = localToUtc(g.publish_date, g.posted_time, g.time_zone);
  const type = g.report_type ?? 'Report';
  const vs = t.opponent ? ` vs ${t.opponent}` : '';
  const when = `${g.publish_date} ${g.posted_time.slice(0, 5)} ${g.time_zone ?? 'CT'}`;
  const facts: Fact[] = [];
  for (const r of t.rows) {
    const status = factStatus(r.status);
    if (!status) continue;
    const name = cleanName(r.name);
    if (status === 'available' && !keepAvailable(name)) continue;
    facts.push({
      team: t.team,
      player: name,
      position: factPosition(r.pos),
      status,
      // exempt "Out" = listed out long-term rather than week to week.
      scope: r.exempt === 'Out' ? 'season' : 'game',
      detail: `${r.status} on the ${source} ${type.toLowerCase()} availability report (${when}) for ${g.kickoff_date ?? 'the game'}${vs}.`,
      confidence: 1,
      timestamp_sec: 0,
    });
  }
  return {
    url: `${page ?? `availability:${source}`}#${g.game_key}-${t.team.replace(/\W+/g, '-')}-${type}-${g.publish_date}T${g.posted_time}`,
    title: `${source} ${type} availability report: ${t.team}${vs} (${g.kickoff_date ?? ''})`.trim(),
    channel: `${source} availability report`,
    as_of,
    facts,
  };
}
