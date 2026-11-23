/**
 * Picks scorecard CLI (src/picks.ts). Reads transcripts and articles, stores
 * picks, prints the leaderboard. Feeds no model and places no orders.
 *
 *   npm run picks:extract -- [--dry-run] [--limit N] [--since YYYY-MM-DD] [--model id] [--concurrency N]
 *       pull picks out of transcripts not processed yet (Claude API; --dry-run sizes the job, no calls)
 *   npm run picks:report -- [--since YYYY-MM-DD] [--min N]
 *       the leaderboard as markdown (reads only)
 */
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { loadAliases } from '../src/config';
import { openDb, teamsInSeason } from '../src/db';
import { loadEnv } from '../src/env';
import { log, runJob } from '../src/log';
import { listTranscripts, parseTranscript, sha1 } from '../src/news';
import { DATA_DIR } from '../src/paths';
import { PICKS_MODEL, buildPicksSection, extractPicks, loadPicks, pickWindows, picksAlreadyProcessed, resolvePicks, storePicks, type GameRef } from '../src/picks';
import { seasonFor } from '../src/season';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const cmd = process.argv[2];

if (cmd === 'extract') {
  runJob('picks:extract', async () => {
    loadEnv();
    const dir = path.resolve(arg('dir', path.join(DATA_DIR, 'transcripts'))!);
    const dryRun = flag('dry-run');
    const limit = Number(arg('limit', '0'));
    const since = arg('since', '2026-10-20')!;
    const model = arg('model', PICKS_MODEL)!;
    const concurrency = Math.max(1, Number(arg('concurrency', '4')));
    const db = openDb();
    const aliases = loadAliases();
    const season = seasonFor(new Date());
    const canonical = teamsInSeason(db, season);
    if (canonical.size === 0) throw new Error(`no games stored for ${season}; picks cannot be matched to games`);
    const names = { ...aliases.kalshi, ...(aliases.news ?? {}) };
    const games = db.prepare('SELECT game_id, kickoff_utc, home_team, away_team FROM games WHERE season = ?').all(season) as GameRef[];

    // Work list: transcripts published since `since` whose current text has not been processed.
    const todo: { file: string; collection: string; hash: string; t: ReturnType<typeof parseTranscript>; ws: ReturnType<typeof pickWindows> }[] = [];
    let skipped = 0;
    for (const file of listTranscripts(dir)) {
      const md = fs.readFileSync(file, 'utf8');
      const t = parseTranscript(md, file);
      if (!t.meta.as_of || t.meta.as_of < since) continue;
      const hash = sha1(md);
      if (picksAlreadyProcessed(db, t.meta.url, hash)) {
        skipped += 1;
        continue;
      }
      todo.push({ file, collection: path.relative(dir, file).split(path.sep)[0], hash, t, ws: pickWindows(t.lines) });
    }
    const work = limit > 0 ? todo.slice(0, limit) : todo;
    const chars = work.reduce((n, x) => n + x.ws.reduce((m, w) => m + w.text.length, 0), 0);
    log.info(`${work.length} transcript(s) to process (${skipped} already done), ${work.filter((x) => x.ws.length).length} with pick windows, about ${Math.round(chars / 4 / 1000)}k tokens of text (model=${model})${dryRun ? ' [dry run: no calls, nothing stored]' : ''}`);
    if (dryRun || work.length === 0) return;

    // One extraction at a time: an hourly run that starts during a long backfill would pay for the same files twice.
    const lock = path.join(DATA_DIR, 'picks.lock');
    if (fs.existsSync(lock)) {
      const pid = Number(fs.readFileSync(lock, 'utf8'));
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      if (alive) {
        log.info(`another picks:extract is running (pid ${pid}); nothing done`);
        return;
      }
    }
    fs.writeFileSync(lock, String(process.pid));
    process.on('exit', () => fs.rmSync(lock, { force: true }));

    const client = new Anthropic();
    let tin = 0;
    let tout = 0;
    let stored = 0;
    let unmatched = 0;
    let failed = 0;
    let next = 0;
    const worker = async () => {
      while (next < work.length) {
        const x = work[next++];
        try {
          const r = x.ws.length ? await extractPicks(client, x.t.meta, x.ws, model) : { picks: [], input_tokens: 0, output_tokens: 0, refused: 0 };
          const resolved = resolvePicks(r.picks, names, canonical, games, x.t.meta.as_of);
          const n = storePicks(db, x.t.meta, x.collection, resolved, { file: x.file, sha1: x.hash, windows: x.ws.length, input_tokens: r.input_tokens, output_tokens: r.output_tokens, model });
          tin += r.input_tokens;
          tout += r.output_tokens;
          stored += n;
          unmatched += resolved.filter((p) => p.game_id === null).length;
          if (n > 0) log.info(`${path.basename(x.file).slice(0, 70)}: ${n} pick(s)`);
        } catch (e) {
          failed += 1;
          log.warn(`picks: ${path.basename(x.file)} failed and will be retried next run: ${(e as Error).message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    log.info(`processed ${work.length - failed} file(s), ${failed} failed; ${stored} new pick(s), ${unmatched} not matched to a game; tokens in=${tin} out=${tout} (${model})`);
  });
} else if (cmd === 'report') {
  runJob('picks:report', async () => {
    const db = openDb();
    process.stdout.write(buildPicksSection(loadPicks(db, { since: arg('since') }), Number(arg('min', '10'))) + '\n');
  });
} else {
  console.error('usage: tsx scripts/picks.ts <extract|report> [options]');
  process.exit(1);
}
