/**
 * Player names heard on podcasts -> the team's official roster name.
 *
 * Auto-captions and hosts misspell names (Kamarion/Kamario, Cade/Kade,
 * Swan/Swann) and often say only a last name. Each fact's player is resolved
 * against the CFBD roster for its team so one player is one name everywhere.
 *
 * Rules, in order, all within the fact's team:
 *  1. Candidates: roster players whose last name matches the spoken last word
 *     exactly, or within one edit when both are 4+ letters.
 *  2. If the fact names a position group, keep candidates in that group
 *     (when that leaves anyone).
 *  3. If a first name was spoken, keep candidates whose first name is within
 *     two edits or starts with the same sound (when that leaves anyone).
 *  4. Exactly one candidate left -> its roster name. Otherwise no change.
 *  A bare last name only one player on the team has resolves to him whatever the
 *  position label says, and a resolved fact takes the roster's position.
 *
 * Rule 3 falls back rather than rejecting, so "Billy Puckett" still resolves
 * to the only Puckett at QB. Two Colemans on the line stay unresolved.
 */
import { nameTokens } from './model/v2';

export interface RosterPlayer {
  team: string;
  first: string;
  last: string;
  position: string | null;
}

export type RosterIndex = Map<string, RosterPlayer[]>;

export function indexRoster(rows: RosterPlayer[]): RosterIndex {
  const out: RosterIndex = new Map();
  for (const r of rows) {
    if (!r.last) continue;
    if (!out.has(r.team)) out.set(r.team, []);
    out.get(r.team)!.push(r);
  }
  return out;
}

/** Fact position -> roster position codes it covers. */
const GROUPS: Record<string, string[]> = {
  QB: ['QB'],
  RB: ['RB', 'FB'],
  WR: ['WR'],
  TE: ['TE'],
  OL: ['OL', 'OT', 'G', 'C'],
  DL: ['DL', 'DT', 'DE', 'NT', 'EDGE'],
  EDGE: ['EDGE', 'DE', 'DL', 'LB'],
  LB: ['LB', 'EDGE'],
  DB: ['DB', 'CB', 'S'],
  K: ['PK', 'K'],
  P: ['P'],
};

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

const lastWord = (s: string) => {
  const t = nameTokens(s);
  return t[t.length - 1] ?? '';
};
const sound = (x: string) => x.replace(/^c/, 'k');

function lastNameCount(players: RosterPlayer[], sLast: string): number {
  return players.filter((p) => {
    const rLast = lastWord(p.last);
    return rLast === sLast || (Math.min(rLast.length, sLast.length) >= 4 && editDistance(rLast, sLast) <= 1);
  }).length;
}

export function fullName(p: RosterPlayer): string {
  return `${p.first} ${p.last}`.trim();
}

/** Roster position code -> the fact position enum (null when it maps to nothing useful). */
const FACT_POSITION: Record<string, string> = {
  QB: 'QB', RB: 'RB', FB: 'RB', WR: 'WR', TE: 'TE',
  OL: 'OL', OT: 'OL', G: 'OL', OG: 'OL', C: 'OL', IOL: 'OL',
  DL: 'DL', DT: 'DL', DE: 'DL', NT: 'DL', EDGE: 'EDGE',
  LB: 'LB', DB: 'DB', CB: 'DB', S: 'DB', PK: 'K', K: 'K', P: 'P',
};
export function factPositionOf(rosterPosition: string | null): string | null {
  return (rosterPosition && FACT_POSITION[rosterPosition.toUpperCase()]) || null;
}

/** First names as one word ("Ollie Wood" vs "Hollywood"), allowing more edits for longer names. */
function firstNamesMatch(spokenFirst: string[], rosterFirst: string): boolean {
  const r = nameTokens(rosterFirst);
  if (r.length === 0 || spokenFirst.length === 0) return false;
  if (editDistance(r[0], spokenFirst[0]) <= 2 || sound(r[0])[0] === sound(spokenFirst[0])[0]) return true;
  const a = r.join('');
  const b = spokenFirst.join('');
  return editDistance(a, b) <= Math.max(2, Math.floor(Math.max(a.length, b.length) / 3));
}

/** The roster player a spoken name refers to, or null when it is not clear (see the rules at the top). */
export function rosterMatch(roster: RosterIndex, team: string | null, spoken: string | null, position: string | null): RosterPlayer | null {
  if (!team || !spoken || position === 'coach') return null;
  const players = roster.get(team);
  if (!players) return null;
  const tokens = nameTokens(spoken);
  if (tokens.length === 0) return null;
  const sLast = tokens[tokens.length - 1];

  let cands = players.filter((p) => {
    const rLast = lastWord(p.last);
    if (!rLast) return false;
    if (rLast === sLast) return true;
    return Math.min(rLast.length, sLast.length) >= 4 && editDistance(rLast, sLast) <= 1;
  });
  if (cands.length === 0) return null;
  // A bare last name that only one player on the team has is that player, whatever
  // position the extractor guessed ("Smothers" labeled QB is the running back).
  if (tokens.length === 1 && cands.length === 1 && lastNameCount(players, sLast) === 1) return cands[0];

  const group = position ? GROUPS[position] : undefined;
  if (group && cands.length > 1) {
    const byPos = cands.filter((p) => p.position !== null && group.includes(p.position));
    if (byPos.length > 0) cands = byPos;
  }
  let firstMatched = false;
  if (tokens.length > 1) {
    const byFirst = cands.filter((p) => firstNamesMatch(tokens.slice(0, -1), p.first));
    if (byFirst.length > 0) {
      cands = byFirst;
      firstMatched = true;
    }
    // The spoken first name matches nobody: only trust the last name if it is
    // unique on the whole team (a host saying "Billy" for Parker Puckett), not
    // when the position filter merely narrowed several same-named players to one.
    // A known position must agree too, since the roster can be missing the real player.
    else if (lastNameCount(players, sLast) !== 1 || !group || cands[0].position === null || !group.includes(cands[0].position)) return null;
  }
  if (cands.length !== 1) return null;
  // A position that rules out the only match blocks it, unless the first name
  // matched too: a full-name match outranks an extraction's position label.
  const only = cands[0];
  if (!firstMatched && group && only.position !== null && !group.includes(only.position)) return null;
  return only;
}

export function canonicalPlayer(roster: RosterIndex, team: string | null, spoken: string | null, position: string | null): string | null {
  const p = rosterMatch(roster, team, spoken, position);
  return p ? fullName(p) : null;
}
