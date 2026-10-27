/**
 * Team-name mapping from a source's spelling to CFBD's canonical name, with
 * helpful diagnostics: every problem is reported at once, each with the
 * closest CFBD names, so one edit of config/team-aliases.json fixes a season.
 */

export interface MappingResult<T> {
  mapped: { row: T; team: string }[];
  problems: string[];
}

const STOP = new Set(['state', 'university', 'of', 'the', 'college']);

function tokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t));
}

/** Closest CFBD names by shared word tokens, then by prefix. Up to `n` results. */
export function suggestTeams(name: string, canonical: Iterable<string>, n = 3): string[] {
  const want = tokens(name);
  const scored: { team: string; score: number }[] = [];
  for (const team of canonical) {
    const have = tokens(team);
    let score = 0;
    for (const w of want) if (have.includes(w)) score += 2;
    for (const w of want) for (const h of have) if (w !== h && (h.startsWith(w) || w.startsWith(h)) && Math.min(w.length, h.length) >= 3) score += 1;
    if (team.toLowerCase().startsWith(name.toLowerCase().slice(0, 4))) score += 1;
    if (score > 0) scored.push({ team, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.team.localeCompare(b.team))
    .slice(0, n)
    .map((s) => s.team);
}

export function mapTeams<T>(rows: T[], nameOf: (r: T) => string, aliases: Record<string, string>, canonical: Set<string>, sourceLabel: string): MappingResult<T> {
  const mapped: { row: T; team: string }[] = [];
  const problems: string[] = [];
  for (const row of rows) {
    const raw = nameOf(row);
    const alias = aliases[raw];
    const team = alias ?? raw;
    if (canonical.has(team)) {
      mapped.push({ row, team });
      continue;
    }
    const hint = suggestTeams(raw, canonical);
    const suggestion = hint.length ? `closest CFBD names: ${hint.map((h) => `"${h}"`).join(', ')}` : 'no similar CFBD name found';
    problems.push(
      alias !== undefined
        ? `"${raw}" is aliased to "${alias}", which is not a CFBD team this season (${suggestion})`
        : `"${raw}" has no alias and is not a CFBD team name (${suggestion})`,
    );
  }
  if (problems.length > 0) {
    problems.unshift(`${sourceLabel}: ${problems.length} team name(s) could not be mapped. Fix the "${sourceLabel.split(' ')[0].toLowerCase()}" section of config/team-aliases.json:`);
  }
  return { mapped, problems };
}
