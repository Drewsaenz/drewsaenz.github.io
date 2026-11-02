/**
 * News pipeline CLI.
 *   npm run news:extract -- [--dir data/transcripts] [--dry-run] [--limit N] [--model id]
 *   npm run news:report  -- [--days 10]
 *
 * extract: parse every transcript under --dir, keep availability segments,
 *          extract facts with Claude, store them. Files already processed
 *          (same content hash) are skipped, so re-runs cost nothing.
 * report:  print facts per team for the last N days with source counts.
 */
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { loadAliases } from '../src/config';
import { openDb, teamsInSeason } from '../src/db';
import { loadEnv } from '../src/env';
import { log, runJob } from '../src/log';
import { DATA_DIR } from '../src/paths';
import { NEWS_MODEL, alreadyProcessed, extractFacts, listTranscripts, parseTranscript, relevantWindows, resolveFactTeams, sha1, storeFacts, teamNews } from '../src/news';
import { seasonFor } from '../src/season';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const cmd = process.argv[2];

if (cmd === 'extract') {
  runJob('news:extract', async () => {
    loadEnv();
    const dir = path.resolve(arg('dir', path.join(DATA_DIR, 'transcripts'))!);
    const dryRun = flag('dry-run');
    const limit = Number(arg('limit', '0'));
    const model = arg('model', NEWS_MODEL)!;
    const db = openDb();
    const aliases = loadAliases();
    const season = seasonFor(new Date());
    const canonical = teamsInSeason(db, season);
    if (canonical.size === 0) log.warn(`no games stored for ${season}; team names will not be resolved to CFBD names`);
    const kalshiPlusNews = { ...aliases.kalshi, ...(aliases.news ?? {}) };

    const files = listTranscripts(dir);
    if (files.length === 0) throw new Error(`no transcripts found under ${dir}`);
    log.info(`${files.length} transcript(s) under ${dir}${dryRun ? ' (dry run: no API calls, nothing stored)' : ''}`);

    const client = dryRun ? null : new Anthropic();
    let done = 0;
    let skipped = 0;
    let totalFacts = 0;
    let totalIn = 0;
    let totalOut = 0;
    let totalChars = 0;
    for (const file of files) {
      if (limit && done >= limit) break;
      const md = fs.readFileSync(file, 'utf8');
      const hash = sha1(md);
      const t = parseTranscript(md, file);
      if (!t.meta.as_of) {
        log.warn(`skip ${path.basename(file)}: no date in front matter`);
        continue;
      }
      if (alreadyProcessed(db, t.meta.url, hash)) {
        skipped += 1;
        continue;
      }
      const ws = relevantWindows(t.lines);
      const chars = ws.reduce((n, w) => n + w.text.length, 0);
      totalChars += chars;
      log.info(`${path.basename(file)}: ${t.lines.length} lines, ${ws.length} relevant window(s), ~${Math.round(chars / 4)} tokens, as_of ${t.meta.as_of.slice(0, 10)} (${t.meta.as_of_source})`);
      if (dryRun) {
        done += 1;
        continue;
      }
      if (ws.length === 0) {
        storeFacts(db, t.meta, [], { file, sha1: hash, windows: 0, input_tokens: 0, output_tokens: 0, model });
        done += 1;
        continue;
      }
      const res = await extractFacts(client!, t.meta, ws, model);
      const stored = resolveFactTeams(res.facts, kalshiPlusNews, canonical);
      const unresolved = [...new Set(stored.filter((f) => !f.team_resolved).map((f) => f.team))];
      if (unresolved.length) log.warn(`  unresolved team name(s): ${unresolved.join(', ')} (add to the "news" section of config/team-aliases.json)`);
      const n = storeFacts(db, t.meta, stored, { file, sha1: hash, windows: ws.length, input_tokens: res.input_tokens, output_tokens: res.output_tokens, model });
      for (const f of stored) log.info(`  ${f.team_resolved ?? f.team}: ${f.player ?? '(group)'} [${f.position}] ${f.status}/${f.scope} c=${f.confidence.toFixed(1)} — ${f.detail}`);
      totalFacts += n;
      totalIn += res.input_tokens;
      totalOut += res.output_tokens;
      done += 1;
    }
    if (dryRun) {
      log.info(`dry run: ${done} file(s) would be sent, ~${Math.round(totalChars / 4)} input tokens total (${skipped} already processed)`);
    } else {
      log.info(`processed ${done} file(s), skipped ${skipped} already done; ${totalFacts} new fact(s); tokens in=${totalIn} out=${totalOut} (${model})`);
    }
  });
} else if (cmd === 'report') {
  runJob('news:report', async () => {
    loadEnv();
    const days = Number(arg('days', '10'));
    const db = openDb();
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    const teams = teamNews(db, from.toISOString(), to.toISOString());
    if (teams.length === 0) {
      log.info(`no news facts in the last ${days} days`);
      return;
    }
    for (const t of teams) {
      console.log(`\n## ${t.team}`);
      for (const f of t.facts) {
        console.log(`- ${f.player ?? '(group)'} [${f.position}] ${f.status}${f.scope && f.scope !== 'unknown' ? `/${f.scope}` : ''} · ${f.sources} show(s) · as of ${f.as_of.slice(0, 10)}${f.detail ? ` — ${f.detail}` : ''}`);
      }
    }
  });
} else {
  console.error('usage: tsx scripts/news.ts <extract|report> [options]');
  process.exit(2);
}
