/**
 * Transcript -> structured availability facts.
 *
 * Pipeline: parse a scraped YouTube transcript (.md with YAML front matter and
 * [m:ss] timestamped lines) -> cut it into overlapping windows -> keep only the
 * windows that mention availability (injuries, depth chart, suspensions) ->
 * send those to Claude with a strict schema -> store facts in `news_facts`.
 *
 * Only facts are kept. Predictions, picks and opinions are discarded so the
 * forecast log never scores a human's or an AI's judgment.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import type { Db } from './db';
import { log } from './log';
import { resolveTeam } from './teams';

export const NEWS_MODEL = 'claude-opus-5-5';

// ------------------------------------------------------------ transcript parsing

export interface TranscriptMeta {
  title: string;
  channel: string | null;
  url: string;
  video_id: string | null;
  /** Best available "when was this said" timestamp (ISO). */
  as_of: string;
  as_of_source: 'published' | 'saved' | 'unknown';
  duration_sec: number | null;
}

export interface TranscriptLine {
  t: number; // seconds into the video
  text: string;
}

export interface Transcript {
  meta: TranscriptMeta;
  lines: TranscriptLine[];
}

function parseFrontMatter(md: string): { fm: Record<string, string>; body: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return { fm: {}, body: md };
  const fm: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    fm[key] = val;
  }
  return { fm, body: m[2] };
}

function toSeconds(stamp: string): number {
  const parts = stamp.split(':').map(Number);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

export function parseTranscript(md: string, file = ''): Transcript {
  const { fm, body } = parseFrontMatter(md);
  const lines: TranscriptLine[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const m = raw.match(/^\[(\d+(?::\d{2}){1,2})\]\s*(.*)$/);
    if (!m) continue;
    const text = m[2].replace(/^>>\s*/, '').replace(/\[(music|laughter|applause|snorts|clears throat)\]/gi, '').trim();
    if (text) lines.push({ t: toSeconds(m[1]), text });
  }
  // Prefer a real publish date if the scraper recorded one; fall back to the scrape time.
  const published = fm.published ?? fm.published_at ?? fm.upload_date ?? fm.date;
  let as_of = '';
  let as_of_source: TranscriptMeta['as_of_source'] = 'unknown';
  if (published && !Number.isNaN(Date.parse(normalizeDate(published)))) {
    as_of = new Date(normalizeDate(published)).toISOString();
    as_of_source = 'published';
  } else if (fm.saved && !Number.isNaN(Date.parse(fm.saved))) {
    as_of = new Date(fm.saved).toISOString();
    as_of_source = 'saved';
  }
  return {
    meta: {
      title: fm.title ?? path.basename(file, '.md'),
      channel: fm.channel ?? null,
      url: fm.url ?? (fm.video_id ? `https://www.youtube.com/watch?v=${fm.video_id}` : `file://${file}`),
      video_id: fm.video_id ?? null,
      as_of,
      as_of_source,
      duration_sec: fm.duration_sec ? Number(fm.duration_sec) : null,
    },
    lines,
  };
}

/** yt-dlp style 20261031 -> 2026-10-31 */
function normalizeDate(s: string): string {
  const m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : s;
}

// ------------------------------------------------------------ windowing + filter

export interface Window {
  start_sec: number;
  end_sec: number;
  text: string;
}

export const AVAILABILITY_RE =
  /\b(injur\w*|out for|ruled out|questionable|doubtful|probable|suspend\w*|sling|walking boot|surgery|concussion|won'?t play|will not play|not going to play|expected to (play|start)|good to go|game[- ]time decision|backup (quarterback|qb)|third[- ]string|starting (quarterback|qb|lineup)|depth chart|practiced|did not practice|limited|returning|back from|availability report|injury report|knocked out|left the game|did not return|season[- ]ending|out for the (season|year)|miss(ed|ing)? (the|this|a|another) game|banged up|hurt|trending (toward|towards|in the right)|pitch count|street clothes|not 100|cleared)\b/i;

export function windows(lines: TranscriptLine[], size = 40, stride = 30): Window[] {
  const out: Window[] = [];
  for (let i = 0; i < lines.length; i += stride) {
    const chunk = lines.slice(i, i + size);
    if (chunk.length === 0) break;
    out.push({ start_sec: chunk[0].t, end_sec: chunk[chunk.length - 1].t, text: chunk.map((l) => l.text).join(' ') });
    if (i + size >= lines.length) break;
  }
  return out;
}

/** Keep windows that mention availability, then merge ones that overlap or touch. */
export function relevantWindows(lines: TranscriptLine[]): Window[] {
  const hits = windows(lines).filter((w) => AVAILABILITY_RE.test(w.text));
  const merged: Window[] = [];
  for (const w of hits) {
    const last = merged[merged.length - 1];
    if (last && w.start_sec <= last.end_sec) {
      // Rebuild the merged text from the underlying lines to avoid duplicating the overlap.
      last.end_sec = Math.max(last.end_sec, w.end_sec);
      last.text = lines
        .filter((l) => l.t >= last.start_sec && l.t <= last.end_sec)
        .map((l) => l.text)
        .join(' ');
    } else {
      merged.push({ ...w });
    }
  }
  return merged;
}

// ------------------------------------------------------------ extraction

export const FactSchema = z.object({
  team: z.string().describe('Full team name as commonly written, e.g. "Mississippi State", "Texas", "Ohio State". Never an abbreviation.'),
  player: z.string().nullable().describe('Player or coach name as spoken; null if the fact is about a position group.'),
  position: z.enum(['QB', 'RB', 'WR', 'TE', 'OL', 'DL', 'EDGE', 'LB', 'DB', 'K', 'P', 'coach', 'unknown']),
  status: z.enum(['out', 'doubtful', 'questionable', 'probable', 'available', 'returning', 'limited', 'unknown']),
  scope: z.enum(['game', 'weeks', 'season', 'unknown']).describe('How long the status applies.'),
  detail: z.string().describe('One sentence paraphrase or short quote of what was said, including who said it if a coach was quoted.'),
  confidence: z.number().min(0).max(1).describe('1.0 = stated as fact by a coach or official report; 0.5 = beat reporter expectation; 0.2 = speculation.'),
  timestamp_sec: z.number().int().describe('Approximate second in the video where this was said.'),
});
export type Fact = z.infer<typeof FactSchema>;

const FactsSchema = z.object({ facts: z.array(FactSchema) });

const SYSTEM = `You extract player and coach AVAILABILITY FACTS from auto-generated transcripts of college football podcasts.

Return only statements about whether a specific player, coach, or position group will or will not be available for a game: injuries, suspensions, depth-chart changes, who is starting, who returned, who left a game and did not come back, official availability-report designations (out, doubtful, questionable, probable).

Rules:
- Facts only. Ignore predictions, picks, opinions about how good a player is, recruiting news, and anything about past seasons.
- Use the full team name. Resolve pronouns and nicknames from context ("the Horns" -> "Texas", "the Bulldogs" in a Texas vs Mississippi State preview -> "Mississippi State").
- Auto-captions misspell names. Correct obvious misspellings when the identity is clear from context; otherwise keep the spoken form.
- One fact per player per status. If the same fact is repeated, return it once.
- If a segment contains no availability facts, return an empty list.`;

export interface ExtractResult {
  facts: Fact[];
  input_tokens: number;
  output_tokens: number;
  refused: number;
}

/** Group windows into batches of roughly `maxChars` characters so one call covers several segments. */
export function batchWindows(ws: Window[], maxChars = 24_000): Window[][] {
  const batches: Window[][] = [];
  let cur: Window[] = [];
  let size = 0;
  for (const w of ws) {
    if (cur.length && size + w.text.length > maxChars) {
      batches.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(w);
    size += w.text.length;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

export async function extractFacts(client: Anthropic, meta: TranscriptMeta, ws: Window[], model = NEWS_MODEL): Promise<ExtractResult> {
  const result: ExtractResult = { facts: [], input_tokens: 0, output_tokens: 0, refused: 0 };
  for (const batch of batchWindows(ws)) {
    const segments = batch.map((w, i) => `### Segment ${i + 1} (starts at ${w.start_sec}s)\n${w.text}`).join('\n\n');
    const user = `Show: "${meta.title}" on ${meta.channel ?? 'unknown channel'}.\nRecorded on or before ${meta.as_of.slice(0, 10)}.\n\n${segments}`;
    const response = await client.messages.parse({
      model,
      max_tokens: 16000,
      system: SYSTEM,
      messages: [{ role: 'user', content: user }],
      output_config: { format: zodOutputFormat(FactsSchema), effort: 'low' },
    });
    result.input_tokens += response.usage.input_tokens;
    result.output_tokens += response.usage.output_tokens;
    if (response.stop_reason === 'refusal') {
      result.refused += 1;
      log.warn(`news: model declined a segment of "${meta.title}" (${response.stop_details?.category ?? 'no category'})`);
      continue;
    }
    if (!response.parsed_output) {
      log.warn(`news: unparseable output for a segment of "${meta.title}" (stop_reason=${response.stop_reason})`);
      continue;
    }
    result.facts.push(...response.parsed_output.facts);
  }
  return result;
}

// ------------------------------------------------------------ storage

export interface StoredFact extends Fact {
  team_resolved: string | null;
}

export function resolveFactTeams(facts: Fact[], aliases: Record<string, string>, canonical: Set<string>): StoredFact[] {
  return facts.map((f) => {
    const candidate = resolveTeam(f.team, aliases);
    return { ...f, team_resolved: canonical.has(candidate) ? candidate : null };
  });
}

export function sha1(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex');
}

export function alreadyProcessed(db: Db, url: string, hash: string): boolean {
  const row = db.prepare('SELECT sha1 FROM news_runs WHERE source_url = ?').get(url) as { sha1: string } | undefined;
  return row?.sha1 === hash;
}

export function storeFacts(db: Db, meta: TranscriptMeta, facts: StoredFact[], run: { file: string; sha1: string; windows: number; input_tokens: number; output_tokens: number; model: string }): number {
  const now = new Date().toISOString();
  const ins = db.prepare(`
    INSERT OR IGNORE INTO news_facts (source_url, source_channel, source_title, as_of, team_raw, team, player, position, status, scope, detail, confidence, timestamp_sec, extracted_at, model)
    VALUES (@source_url, @source_channel, @source_title, @as_of, @team_raw, @team, @player, @position, @status, @scope, @detail, @confidence, @timestamp_sec, @extracted_at, @model)`);
  const runStmt = db.prepare(`
    INSERT INTO news_runs (source_url, file, sha1, windows, facts, input_tokens, output_tokens, processed_at, model)
    VALUES (@source_url, @file, @sha1, @windows, @facts, @input_tokens, @output_tokens, @processed_at, @model)
    ON CONFLICT(source_url) DO UPDATE SET file = excluded.file, sha1 = excluded.sha1, windows = excluded.windows, facts = excluded.facts,
      input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, processed_at = excluded.processed_at, model = excluded.model`);
  let inserted = 0;
  db.transaction(() => {
    for (const f of facts) {
      inserted += ins.run({
        source_url: meta.url,
        source_channel: meta.channel,
        source_title: meta.title,
        as_of: meta.as_of,
        team_raw: f.team,
        team: f.team_resolved,
        player: f.player,
        position: f.position,
        status: f.status,
        scope: f.scope,
        detail: f.detail,
        confidence: f.confidence,
        timestamp_sec: f.timestamp_sec,
        extracted_at: now,
        model: run.model,
      }).changes;
    }
    runStmt.run({ source_url: meta.url, ...run, facts: inserted, processed_at: now });
  })();
  return inserted;
}

export interface RestampResult {
  transcripts: number;
  moved: number;
  unchanged: number;
  noDate: number;
}

/**
 * Re-read each transcript's front matter and, where it now carries a publish
 * date that differs from the stored as_of, move its facts to that date and
 * refresh the content hash so the file is not re-extracted.
 */
export function restampFacts(db: Db, files: string[]): RestampResult {
  const res: RestampResult = { transcripts: 0, moved: 0, unchanged: 0, noDate: 0 };
  const upd = db.prepare('UPDATE news_facts SET as_of = ? WHERE source_url = ? AND as_of <> ?');
  const run = db.prepare('UPDATE news_runs SET sha1 = ?, file = ? WHERE source_url = ?');
  db.transaction(() => {
    for (const file of files) {
      const md = fs.readFileSync(file, 'utf8');
      const t = parseTranscript(md, file);
      if (t.meta.as_of_source !== 'published') {
        res.noDate += 1;
        continue;
      }
      const moved = upd.run(t.meta.as_of, t.meta.url, t.meta.as_of).changes;
      run.run(sha1(md), file, t.meta.url);
      if (moved > 0) {
        res.transcripts += 1;
        res.moved += moved;
      } else {
        res.unchanged += 1;
      }
    }
  })();
  return res;
}

/** Recursively list transcript .md files under a directory. */
export function listTranscripts(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTranscripts(p));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(p);
  }
  return out.sort();
}

// ------------------------------------------------------------ reporting

export interface TeamNews {
  team: string;
  facts: { player: string | null; position: string; status: string; scope: string | null; detail: string | null; sources: number; confidence: number | null; as_of: string }[];
}

/** Facts per team in a window of time, with the number of distinct shows that stated each one. */
export function teamNews(db: Db, fromIso: string, toIso: string): TeamNews[] {
  const rows = db
    .prepare(
      `SELECT COALESCE(team, team_raw) AS team, player, position, status, scope, MIN(detail) AS detail, COUNT(DISTINCT source_url) AS sources,
              MAX(confidence) AS confidence, MAX(as_of) AS as_of
         FROM news_facts WHERE as_of >= ? AND as_of <= ?
        GROUP BY COALESCE(team, team_raw), player, position, status, scope
        ORDER BY team, sources DESC, position`,
    )
    .all(fromIso, toIso) as TeamNews['facts'][number][] & { team: string }[];
  const byTeam = new Map<string, TeamNews>();
  for (const r of rows as (TeamNews['facts'][number] & { team: string })[]) {
    if (!byTeam.has(r.team)) byTeam.set(r.team, { team: r.team, facts: [] });
    byTeam.get(r.team)!.facts.push(r);
  }
  return [...byTeam.values()];
}

/**
 * Pre-kickoff quarterback availability flags per game: a QB listed out or
 * doubtful for either team by a show recorded before kickoff.
 */
export function qbFlags(db: Db): Map<number, string[]> {
  const rows = db
    .prepare(
      `SELECT g.game_id, n.team, n.player, n.status
         FROM games g JOIN news_facts n ON n.team IN (g.home_team, g.away_team)
        WHERE n.position = 'QB' AND n.status IN ('out', 'doubtful')
          AND n.as_of < g.kickoff_utc AND n.as_of >= datetime(g.kickoff_utc, '-8 days')
        GROUP BY g.game_id, n.team, n.player, n.status`,
    )
    .all() as { game_id: number; team: string; player: string | null; status: string }[];
  const out = new Map<number, string[]>();
  for (const r of rows) {
    if (!out.has(r.game_id)) out.set(r.game_id, []);
    out.get(r.game_id)!.push(`${r.team} QB ${r.player ?? ''} ${r.status}`.replace(/\s+/g, ' ').trim());
  }
  return out;
}
