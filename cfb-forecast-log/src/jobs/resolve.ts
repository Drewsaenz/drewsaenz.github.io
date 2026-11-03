/**
 * Job: resolve (Sun 06:00 and Mon 06:00)
 * Pull completed games and fill outcome/resolved_at on every pending forecast.
 * This is the only UPDATE the forecasts table permits (see schema triggers).
 * Rows that can never be graded fairly (cancelled, postponed, moved kickoff)
 * go to forecast_voids instead; see src/grading.ts for the rules.
 */
import { loadEnv, requireEnv } from '../env';
import { openDb, upsertGames } from '../db';
import { log, runJob } from '../log';
import { CfbdClient } from '../sources/cfbd';
import { VOID_AFTER_DAYS, decide } from '../grading';
import type { GameRow } from '../types';

interface Pending {
  id: number;
  game_id: number;
  season: number;
  yes_team: string;
  snapshot_kind: string;
  snapshot_utc: string;
  stored_kickoff_utc: string;
}

runJob('resolve', async () => {
  loadEnv();
  const db = openDb();
  const pending = db
    .prepare(
      `SELECT f.id, f.game_id, g.season, m.yes_team, f.snapshot_kind, f.snapshot_utc, g.kickoff_utc AS stored_kickoff_utc
         FROM forecasts f
         JOIN games g ON g.game_id = f.game_id
         JOIN markets m ON m.ticker = f.ticker
         LEFT JOIN forecast_voids v ON v.forecast_id = f.id
        WHERE f.outcome IS NULL AND v.forecast_id IS NULL`,
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

  const now = new Date();
  const resolved_at = now.toISOString();
  const updates: { id: number; outcome: 0 | 1 }[] = [];
  const voids: { id: number; reason: string }[] = [];
  let notFinal = 0;
  let missing = 0;
  for (const p of pending) {
    const d = decide(p, gamesById.get(p.game_id), now);
    if (d.kind === 'grade') updates.push({ id: p.id, outcome: d.outcome });
    else if (d.kind === 'void') voids.push({ id: p.id, reason: d.reason });
    else if (d.why === 'missing') missing += 1;
    else notFinal += 1;
  }
  // Warn once per game, not per row.
  const voidedGames = new Map<number, string>();
  for (const v of voids) voidedGames.set(pending.find((p) => p.id === v.id)!.game_id, v.reason);
  for (const [gameId, reason] of voidedGames) log.warn(`voiding forecasts for game ${gameId}: ${reason}`);
  if (missing > 0) log.warn(`${missing} pending row(s) reference games CFBD no longer lists; they are voided ${VOID_AFTER_DAYS} days after kickoff if still missing`);

  const upd = db.prepare('UPDATE forecasts SET outcome = @outcome, resolved_at = @resolved_at WHERE id = @id AND outcome IS NULL');
  const ins = db.prepare('INSERT OR IGNORE INTO forecast_voids (forecast_id, reason, voided_at) VALUES (?, ?, ?)');
  db.transaction(() => {
    upsertGames(db, fetched);
    for (const u of updates) upd.run({ ...u, resolved_at });
    for (const v of voids) ins.run(v.id, v.reason, resolved_at);
  })();
  log.info(`resolved ${updates.length} forecast(s); voided ${voids.length}; ${notFinal + missing} still pending; CFBD calls this run: ${cfbd.callCount}`);
});
