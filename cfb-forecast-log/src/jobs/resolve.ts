/**
 * Job: resolve (Sun 06:00 and Mon 06:00)
 * Pull completed games and fill outcome/resolved_at on every pending forecast.
 * This is the only UPDATE the forecasts table permits (see schema triggers).
 */
import { loadEnv, requireEnv } from '../env';
import { openDb, upsertGames } from '../db';
import { log, runJob } from '../log';
import { CfbdClient } from '../sources/cfbd';
import type { GameRow } from '../types';

interface Pending {
  id: number;
  game_id: number;
  season: number;
  yes_team: string;
}

runJob('resolve', async () => {
  loadEnv();
  const db = openDb();
  const pending = db
    .prepare(
      `SELECT f.id, f.game_id, g.season, m.yes_team
         FROM forecasts f
         JOIN games g ON g.game_id = f.game_id
         JOIN markets m ON m.ticker = f.ticker
        WHERE f.outcome IS NULL`,
    )
    .all() as Pending[];
  if (pending.length === 0) {
    log.info('nothing pending');
    return;
  }

  const cfbd = new CfbdClient(requireEnv('CFBD_API_KEY'));
  const gamesById = new Map<number, GameRow>();
  const fetched: GameRow[] = [];
  for (const season of new Set(pending.map((p) => p.season))) {
    for (const g of await cfbd.games(season)) {
      gamesById.set(g.game_id, g);
      fetched.push(g);
    }
  }

  const resolved_at = new Date().toISOString();
  const updates: { id: number; outcome: 0 | 1 }[] = [];
  let notFinal = 0;
  for (const p of pending) {
    const g = gamesById.get(p.game_id);
    if (!g) throw new Error(`pending forecast ${p.id} references game ${p.game_id} missing from CFBD`);
    if (!g.completed || g.home_points === null || g.away_points === null) {
      notFinal += 1;
      continue;
    }
    if (g.home_points === g.away_points) {
      log.warn(`game ${g.game_id} ${g.away_team} @ ${g.home_team} is a tie; leaving pending`);
      continue;
    }
    const homeWon = g.home_points > g.away_points;
    const yesIsHome = p.yes_team === g.home_team;
    updates.push({ id: p.id, outcome: homeWon === yesIsHome ? 1 : 0 });
  }

  const upd = db.prepare('UPDATE forecasts SET outcome = @outcome, resolved_at = @resolved_at WHERE id = @id AND outcome IS NULL');
  db.transaction(() => {
    upsertGames(db, fetched);
    for (const u of updates) upd.run({ ...u, resolved_at });
  })();
  log.info(`resolved ${updates.length} forecast(s); ${notFinal} still pending; CFBD calls this run: ${cfbd.callCount}`);
});
