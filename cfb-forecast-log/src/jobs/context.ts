import { loadEnv, optionalInt, requireEnv } from '../env';
import { log } from '../log';
import { currentWeek, seasonFor } from '../season';
import { CfbdClient } from '../sources/cfbd';
import type { GameRow } from '../types';

/** Shared job setup: env, season, fresh schedule, current week. */
export async function seasonContext(now = new Date()): Promise<{ cfbd: CfbdClient; season: number; week: number; games: GameRow[] }> {
  loadEnv();
  const cfbd = new CfbdClient(requireEnv('CFBD_API_KEY'));
  const season = optionalInt('SEASON') ?? seasonFor(now);
  const games = await cfbd.games(season);
  if (games.length === 0) throw new Error(`CFBD returned no regular-season games for ${season}`);
  const week = optionalInt('WEEK') ?? currentWeek(games, now);
  if (week === null) throw new Error(`Could not determine current week for ${season}`);
  log.info(`season=${season} week=${week} games=${games.length}`);
  return { cfbd, season, week, games };
}
