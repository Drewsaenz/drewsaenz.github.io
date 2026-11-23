/**
 * Picks scorecard (claims layer, phase 1): what shows and articles pick for
 * upcoming games, graded after the games resolve.
 *
 * transcript/article -> windows that sound like a pick -> one extraction call
 * -> `picks` rows (append-only) -> grading and a per-channel leaderboard, both
 * computed at read time from `games` and the logged Vegas line. Nothing here
 * feeds a model: this measures which sources, if any, beat the line.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import type { Db } from './db';
import { log } from './log';
import { batchWindows, windows, type TranscriptLine, type TranscriptMeta, type Window } from './news';
import { resolveTeam } from './teams';

export const PICKS_MODEL = 'claude-haiku-5-5';

// ------------------------------------------------------------ windows

const PICK_TERMS = [
  'picks?', 'picked', 'covers?', 'covered', 'covering', 'spread', 'favou?rites?', 'favou?red', 'underdog', 'moneyline', 'money line',
  'over.under', 'the over', 'the under', 'take the', 'taking the', 'laying the', 'giving the points', 'going with', 'rolling with',
  'i like', 'i love', 'give me', 'lean', 'leaning', 'lock of the', 'best bet', 'upset', 'trap game', 'outright', 'prediction', 'predict',
  'final score', 'by a touchdown', 'by a field goal', 'by double digits', 'by two scores', 'and a half', 'minus \\d', 'plus \\d',
];
export const PICK_RE = new RegExp(PICK_TERMS.map((s) => `\\b${s}\\b`).join('|'), 'i');

/** Windows that sound like a pick, merged where they overlap (same shape as news.relevantWindows). */
export function pickWindows(lines: TranscriptLine[]): Window[] {
  const hits = windows(lines).filter((w) => PICK_RE.test(w.text));
  const merged: Window[] = [];
  for (const w of hits) {
    const last = merged[merged.length - 1];
    if (last && w.start_sec <= last.end_sec) {
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

export const PICK_KINDS = ['spread', 'moneyline', 'total_over', 'total_under', 'team_total_over', 'team_total_under', 'lean'] as const;
export type PickKind = (typeof PICK_KINDS)[number];

export const PickSchema = z.object({
  team_picked: z.string().describe('Full team name of the side picked, e.g. "Texas A&M", with no mascot. For a game total, either team. For a team total, the team whose points are being bet.'),
  opponent: z.string().describe('Full team name of the other team in the game, with no mascot.'),
  kind: z
    .enum(PICK_KINDS)
    .describe('spread = picked against the spread or to cover; moneyline = picked to win the game; total_over / total_under = the combined points of both teams; team_total_over / team_total_under = one team\'s points only; lean = a hedged preference for a side with no clear commitment.'),
  line: z.number().nullable().describe('The number stated by the speaker: for a spread, the picked side\'s spread (negative = favored, positive = getting points); for a total or team total, the points number. Null if not stated or if kind is moneyline or lean.'),
  host: z.string().nullable().describe('Name of the person making the pick if it is clear from the text, else null.'),
  strength: z.enum(['best_bet', 'pick', 'lean']),
  predicted_score: z.string().nullable().describe('Predicted final score if one was given, picked team first, e.g. "31-24", else null.'),
  quote: z.string().describe('Short paraphrase of the pick, under 25 words.'),
  timestamp_sec: z.number().int(),
});
export type Pick = z.infer<typeof PickSchema>;
const PicksSchema = z.object({ picks: z.array(PickSchema) });

const SYSTEM = `You extract PICKS AND PREDICTIONS about specific upcoming college football games from podcast transcripts and articles.

Return a pick only when a speaker or writer commits to a side of a specific game that has not been played yet: a team to cover the spread, a team to win, an over or under, or a predicted final score (record the predicted winner as a moneyline pick and keep the score).

Rules:
- One pick per speaker per game per kind. If it is repeated, return it once. "Notre Dame wins but Miami covers" is two picks: Notre Dame moneyline and Miami spread.
- Ignore recaps of games already played, season-long predictions (playoff, awards, win totals), recruiting, the NFL and other sports.
- Ignore analysis with no commitment ("this could be close", "if they stop the run they probably win"). A hedged preference for a side is kind "lean".
- Use full team names without mascots ("Ole Miss", not "Mississippi Rebels"). Auto-captions misspell names; correct them when the identity is clear.
- "Texas minus 7" is a spread pick on Texas with line -7. "Taking BYU getting 5 and a half" is line 5.5. Leave line null for moneyline picks.
- "Arizona under 27 and a half points" is a team total (team_total_under), not a game total.
- If a segment contains no picks, return an empty list.`;

export interface PickExtract {
  picks: Pick[];
  input_tokens: number;
  output_tokens: number;
  refused: number;
}

export async function extractPicks(client: Anthropic, meta: TranscriptMeta, ws: Window[], model = PICKS_MODEL): Promise<PickExtract> {
  const result: PickExtract = { picks: [], input_tokens: 0, output_tokens: 0, refused: 0 };
  for (const batch of batchWindows(ws)) {
    const segments = batch.map((w, i) => `### Segment ${i + 1} (starts at ${w.start_sec}s)\n${w.text}`).join('\n\n');
    const user = `Show: "${meta.title}" on ${meta.channel ?? 'unknown channel'}.\nPublished ${meta.as_of.slice(0, 10)}.\n\n${segments}`;
    const response = await client.messages.parse({
      model,
      max_tokens: 16000,
      system: SYSTEM,
      messages: [{ role: 'user', content: user }],
      output_config: { format: zodOutputFormat(PicksSchema), effort: 'low' },
    });
    result.input_tokens += response.usage.input_tokens;
    result.output_tokens += response.usage.output_tokens;
    if (response.stop_reason === 'refusal') {
      result.refused += 1;
      log.warn(`picks: model declined a segment of "${meta.title}"`);
      continue;
    }
    if (!response.parsed_output) {
      log.warn(`picks: unparseable output for a segment of "${meta.title}" (stop_reason=${response.stop_reason})`);
      continue;
    }
    result.picks.push(...response.parsed_output.picks);
  }
  return result;
}

// ------------------------------------------------------------ team and game mapping

const NAME_NOISE = /^(the |university of )|( university| football)$/gi;

/**
 * A spoken or written team name -> CFBD name, or null. Tries the alias table,
 * then drops trailing words one at a time ("Notre Dame Fighting Irish" ->
 * "Notre Dame"), so mascots do not need an alias each.
 */
export function resolvePickTeam(raw: string, aliases: Record<string, string>, canonical: Set<string>): string | null {
  const clean = raw.trim().replace(NAME_NOISE, '').trim();
  for (const name of [raw.trim(), clean]) {
    const words = name.split(/\s+/);
    for (let n = words.length; n >= 1; n--) {
      const candidate = resolveTeam(words.slice(0, n).join(' '), aliases);
      if (canonical.has(candidate)) return candidate;
    }
  }
  return null;
}

export interface GameRef {
  game_id: number;
  kickoff_utc: string;
  home_team: string;
  away_team: string;
}

/** How long before kickoff a pick can be made and still be about that game. */
export const PICK_LEAD_DAYS = 9;

/** The first game between the two teams that kicks off after the pick was published, within PICK_LEAD_DAYS. */
export function mapPickToGame(games: GameRef[], team: string | null, opponent: string | null, asOf: string): GameRef | null {
  if (!team || !opponent || team === opponent) return null;
  const from = Date.parse(asOf);
  const until = from + PICK_LEAD_DAYS * 86_400_000;
  const hits = games
    .filter((g) => (g.home_team === team && g.away_team === opponent) || (g.home_team === opponent && g.away_team === team))
    .filter((g) => Date.parse(g.kickoff_utc) > from && Date.parse(g.kickoff_utc) <= until)
    .sort((a, b) => (a.kickoff_utc < b.kickoff_utc ? -1 : 1));
  return hits[0] ?? null;
}

// ------------------------------------------------------------ storage

export interface StoredPick extends Pick {
  team: string | null;
  opponent_team: string | null;
  game_id: number | null;
}

export function resolvePicks(picks: Pick[], aliases: Record<string, string>, canonical: Set<string>, games: GameRef[], asOf: string): StoredPick[] {
  return picks.map((p) => {
    const team = resolvePickTeam(p.team_picked, aliases, canonical);
    const opponent_team = resolvePickTeam(p.opponent, aliases, canonical);
    return { ...p, team, opponent_team, game_id: mapPickToGame(games, team, opponent_team, asOf)?.game_id ?? null };
  });
}

/** A transcript is done for picks when its stored hash matches. Unlike news, a run with no windows is also final for that hash. */
export function picksAlreadyProcessed(db: Db, url: string, hash: string): boolean {
  const row = db.prepare('SELECT sha1 FROM pick_runs WHERE source_url = ?').get(url) as { sha1: string } | undefined;
  return row?.sha1 === hash;
}

export function storePicks(
  db: Db,
  meta: TranscriptMeta,
  collection: string,
  picks: StoredPick[],
  run: { file: string; sha1: string; windows: number; input_tokens: number; output_tokens: number; model: string },
): number {
  const now = new Date().toISOString();
  const ins = db.prepare(`
    INSERT OR IGNORE INTO picks (source_url, source_channel, source_title, collection, as_of, host, team_raw, opponent_raw, team, opponent, game_id, kind, line, strength, predicted_score, quote, timestamp_sec, extracted_at, model)
    VALUES (@source_url, @source_channel, @source_title, @collection, @as_of, @host, @team_raw, @opponent_raw, @team, @opponent, @game_id, @kind, @line, @strength, @predicted_score, @quote, @timestamp_sec, @extracted_at, @model)`);
  const runStmt = db.prepare(`
    INSERT INTO pick_runs (source_url, file, sha1, windows, picks, input_tokens, output_tokens, processed_at, model)
    VALUES (@source_url, @file, @sha1, @windows, @picks, @input_tokens, @output_tokens, @processed_at, @model)
    ON CONFLICT(source_url) DO UPDATE SET file = excluded.file, sha1 = excluded.sha1, windows = excluded.windows, picks = excluded.picks,
      input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, processed_at = excluded.processed_at, model = excluded.model`);
  let inserted = 0;
  db.transaction(() => {
    for (const p of picks) {
      inserted += ins.run({
        source_url: meta.url,
        source_channel: meta.channel,
        source_title: meta.title,
        collection,
        as_of: meta.as_of,
        host: p.host,
        team_raw: p.team_picked,
        opponent_raw: p.opponent,
        team: p.team,
        opponent: p.opponent_team,
        game_id: p.game_id,
        kind: p.kind,
        line: p.line,
        strength: p.strength,
        predicted_score: p.predicted_score,
        quote: p.quote,
        timestamp_sec: p.timestamp_sec,
        extracted_at: now,
        model: run.model,
      }).changes;
    }
    runStmt.run({ source_url: meta.url, ...run, picks: inserted, processed_at: now });
  })();
  return inserted;
}

// ------------------------------------------------------------ grading

export type Grade = 'win' | 'loss' | 'push';
export type Board = 'ats' | 'su' | 'total' | 'lean';

export interface PickRow {
  id: number;
  source_url: string;
  source_channel: string | null;
  collection: string | null;
  as_of: string;
  host: string | null;
  team: string | null;
  opponent: string | null;
  game_id: number | null;
  kind: string;
  line: number | null;
  strength: string | null;
  quote: string | null;
  // from games / forecasts, null when unmapped or not played yet
  home_team: string | null;
  away_team: string | null;
  home_points: number | null;
  away_points: number | null;
  completed: number | null;
  kickoff_utc: string | null;
  /** Home-perspective Vegas spread from the last non-manual snapshot before kickoff, if this project logged one. */
  vegas_spread: number | null;
}

export interface GradedPick extends PickRow {
  board: Board;
  grade: Grade | null;
  /** Why there is no grade, when there is none. */
  ungraded: string | null;
  /** The line the pick was graded against (spread for the picked team, or the total). */
  line_used: number | null;
  line_source: 'stated' | 'vegas' | null;
  /** Vegas spread for the picked team (negative = favored), when logged. */
  team_vegas: number | null;
}

/** How far a stated spread may sit from the logged Vegas number before it is treated as a caption or extraction error. */
export const STATED_LINE_TOLERANCE = 6;

const boardOf = (kind: string): Board => (kind === 'spread' ? 'ats' : kind === 'moneyline' ? 'su' : kind === 'lean' ? 'lean' : 'total');
const cmp = (x: number): Grade => (x > 0 ? 'win' : x < 0 ? 'loss' : 'push');

/** Grade one pick. Pure: everything it needs is on the row. */
export function gradePick(p: PickRow): GradedPick {
  const board = boardOf(p.kind);
  const none = (why: string, extra: Partial<GradedPick> = {}): GradedPick => ({ ...p, board, grade: null, ungraded: why, line_used: null, line_source: null, team_vegas: null, ...extra });
  if (p.game_id === null || !p.team || !p.home_team) return none('no game matched');
  const isHome = p.team === p.home_team;
  const team_vegas = p.vegas_spread === null ? null : isHome ? p.vegas_spread : -p.vegas_spread;
  if (!p.completed || p.home_points === null || p.away_points === null) return none('not played yet', { team_vegas });
  const mine = isHome ? p.home_points : p.away_points;
  const theirs = isHome ? p.away_points : p.home_points;
  const done = (grade: Grade, line_used: number | null, line_source: GradedPick['line_source']): GradedPick => ({ ...p, board, grade, ungraded: null, line_used, line_source, team_vegas });

  if (p.kind === 'moneyline' || p.kind === 'lean') return done(mine === theirs ? 'push' : mine > theirs ? 'win' : 'loss', null, null);
  if (p.kind === 'spread') {
    // The stated line when it is believable, else the logged Vegas line.
    let line = p.line;
    let source: GradedPick['line_source'] = 'stated';
    if (line === null || (team_vegas !== null && Math.abs(line - team_vegas) > STATED_LINE_TOLERANCE)) {
      line = team_vegas;
      source = 'vegas';
    }
    if (line === null) return none('no line stated or logged', { team_vegas });
    return done(cmp(mine - theirs + line), line, source);
  }
  if (p.line === null) return none('no total stated', { team_vegas });
  const points = p.kind.startsWith('team_total') ? mine : mine + theirs;
  const over = p.kind.endsWith('over');
  return done(cmp(over ? points - p.line : p.line - points), p.line, 'stated');
}

/**
 * Picks that contradict each other inside one episode with no named host:
 * both sides of a game on the same board (two spread picks on opposite teams,
 * an over and an under on the same total). A panel disagreed and the captions
 * do not say who said what, so neither counts for the channel.
 */
export function conflictedIds(rows: { id: number; source_url: string; game_id: number | null; host: string | null; kind: string; team: string | null }[]): Set<number> {
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    if (r.game_id === null || r.host) continue;
    const board = boardOf(r.kind);
    const scope = r.kind.startsWith('team_total') ? `team:${r.team}` : board;
    const k = `${r.source_url}|${r.game_id}|${scope === 'lean' ? 'su' : scope}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const out = new Set<number>();
  for (const g of groups.values()) {
    const sides = new Set(g.map((r) => (boardOf(r.kind) === 'total' ? (r.kind.endsWith('over') ? 'over' : 'under') : r.team)));
    if (sides.size > 1) for (const r of g) out.add(r.id);
  }
  return out;
}

const PICK_SELECT = `
  SELECT p.id, p.source_url, p.source_channel, p.collection, p.as_of, p.host, p.team, p.opponent, p.game_id, p.kind, p.line, p.strength, p.quote,
         g.home_team, g.away_team, g.home_points, g.away_points, g.completed, g.kickoff_utc,
         (SELECT f.vegas_spread FROM forecasts f
           WHERE f.game_id = p.game_id AND f.snapshot_kind <> 'manual' AND f.vegas_spread IS NOT NULL AND f.snapshot_utc < g.kickoff_utc
           ORDER BY f.snapshot_utc DESC LIMIT 1) AS vegas_spread
    FROM picks p LEFT JOIN games g ON g.game_id = p.game_id`;

export function loadPicks(db: Db, opts: { since?: string } = {}): (GradedPick & { conflicted: boolean })[] {
  const rows = db.prepare(`${PICK_SELECT} WHERE p.as_of >= ? ORDER BY p.as_of DESC`).all(opts.since ?? '0000') as PickRow[];
  const conflicts = conflictedIds(rows);
  return rows.map((r) => ({ ...gradePick(r), conflicted: conflicts.has(r.id) }));
}

// ------------------------------------------------------------ leaderboard

export interface Record3 {
  w: number;
  l: number;
  p: number;
}
export interface LeaderRow {
  source: string;
  picks: number;
  graded: number;
  ats: Record3;
  su: Record3;
  total: Record3;
  lean: Record3;
  /** Straight-up picks on the Vegas underdog, and how many won. */
  dogs: { n: number; w: number };
  conflicted: number;
  unmatched: number;
  pending: number;
}

const empty = (): Record3 => ({ w: 0, l: 0, p: 0 });
/** Win rate over decided picks (pushes excluded), or null with none. */
export const winRate = (r: Record3): number | null => (r.w + r.l === 0 ? null : r.w / (r.w + r.l));
/** Break-even at -110. */
export const ATS_BREAK_EVEN = 0.524;

export function leaderboard(picks: (GradedPick & { conflicted: boolean })[], by: (p: GradedPick) => string = (p) => p.source_channel ?? p.collection ?? 'unknown'): LeaderRow[] {
  const rows = new Map<string, LeaderRow>();
  for (const p of picks) {
    const k = by(p);
    if (!rows.has(k)) rows.set(k, { source: k, picks: 0, graded: 0, ats: empty(), su: empty(), total: empty(), lean: empty(), dogs: { n: 0, w: 0 }, conflicted: 0, unmatched: 0, pending: 0 });
    const r = rows.get(k)!;
    r.picks += 1;
    if (p.conflicted) {
      r.conflicted += 1;
      continue;
    }
    if (!p.grade) {
      if (p.ungraded === 'not played yet') r.pending += 1;
      else r.unmatched += 1;
      continue;
    }
    r.graded += 1;
    const rec = r[p.board];
    if (p.grade === 'win') rec.w += 1;
    else if (p.grade === 'loss') rec.l += 1;
    else rec.p += 1;
    if (p.board === 'su' && p.team_vegas !== null && p.team_vegas > 0) {
      r.dogs.n += 1;
      if (p.grade === 'win') r.dogs.w += 1;
    }
  }
  return [...rows.values()].sort((a, b) => b.graded - a.graded || a.source.localeCompare(b.source));
}

const rec = (r: Record3) => (r.w + r.l + r.p === 0 ? '' : `${r.w}-${r.l}${r.p ? `-${r.p}` : ''}`);
const pct = (r: Record3) => {
  const x = winRate(r);
  return x === null ? '' : `${Math.round(x * 100)}%`;
};

/** Markdown section for the weekly report. `minGraded` hides sources too thin to read. */
export function buildPicksSection(picks: (GradedPick & { conflicted: boolean })[], minGraded = 10): string {
  const out: string[] = ['## Picks scorecard', ''];
  if (picks.length === 0) return [...out, 'No picks stored yet (`npm run picks:extract`).', ''].join('\n');
  const all = leaderboard(picks, () => 'All sources')[0];
  const table = (rows: LeaderRow[]) => {
    out.push('| Source | Graded | Against the spread | ATS % | Straight up | SU % | Underdogs picked (won) | Totals | Leans |', '|---|---|---|---|---|---|---|---|---|');
    for (const r of rows) out.push(`| ${r.source} | ${r.graded} | ${rec(r.ats)} | ${pct(r.ats)} | ${rec(r.su)} | ${pct(r.su)} | ${r.dogs.n ? `${r.dogs.n} (${r.dogs.w})` : ''} | ${rec(r.total)} | ${rec(r.lean)} |`);
    out.push('');
  };
  table([all, ...leaderboard(picks, (p) => `Collection: ${p.collection ?? 'unknown'}`)]);
  const channels = leaderboard(picks).filter((r) => r.graded >= minGraded);
  if (channels.length) {
    out.push(`Channels with at least ${minGraded} graded picks:`, '');
    table(channels);
  }
  out.push(
    `- ${all.picks} picks stored: ${all.graded} graded, ${all.pending} on games not played yet, ${all.unmatched} with no game or line to grade against, ${all.conflicted} set aside because one episode picked both sides with no named speaker.`,
    `- Break-even against the spread at -110 is ${(ATS_BREAK_EVEN * 100).toFixed(1)}%. Spread picks grade against the line the speaker stated when it is within ${STATED_LINE_TOLERANCE} points of the logged Vegas line, otherwise against the Vegas line.`,
    `- A record over a few dozen picks is noise. Read a channel only once it has a few hundred.`,
    '',
  );
  return out.join('\n');
}
