/**
 * News pipeline CLI.
 *   npm run news:extract -- [--dir data/transcripts] [--dry-run] [--limit N] [--model id]
 *   npm run news:windows -- [--dir data/transcripts] [--out data/news-work]
 *   npm run news:import  -- --in data/news-work [--model manual]
 *   npm run news:report  -- [--days 10]
 *   npm run news:restamp -- [--dir data/transcripts]
 *   npm run news:players -- [--dry-run]   resolve stored player names to roster names
 *   npm run news:availability -- [--dir data/availability]   official reports saved by TranscriptGPT -> facts
 *
 * restamp: after the scraper backfills `published:` into transcripts that were
 *          extracted while only `saved:` existed, move each stored fact's as_of
 *          to the publish date (and refresh the stored content hash) so the
 *          News check attaches facts to the right game. No API calls.
 *
 * extract: parse every transcript under --dir, keep availability segments,
 *          extract facts with Claude, store them. Files already processed
 *          (same content hash) are skipped, so re-runs cost nothing.
 * windows: the no-API half of extract. Write one JSON per unprocessed
 *          transcript to --out with its metadata and availability segments,
 *          so the facts can be written by hand (or by a Claude Code session).
 * import:  read every *.facts.json under --in (the shape is
 *          { source_file, facts: Fact[] }), validate against FactSchema, and
 *          store through the same path extract uses.
 * report:  print facts per team for the last N days with source counts.
 */
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { loadAliases } from '../src/config';
import { openDb, teamsInSeason } from '../src/db';
import { loadEnv, requireEnv } from '../src/env';
import { log, runJob } from '../src/log';
import { DATA_DIR } from '../src/paths';
import { z } from 'zod';
import { FactSchema, NEWS_MODEL, alreadyProcessed, extractFacts, listTranscripts, parseTranscript, relevantWindows, resolveFactPlayers, resolveFactTeams, restampFacts, sha1, storeFacts, teamNews } from '../src/news';
import { canonicalPlayer, indexRoster, type RosterIndex } from '../src/players';
import { AvailabilityFileSchema, teamReportFacts } from '../src/availability';
import { sameName } from '../src/model/v2';
import { resolveTeam } from '../src/teams';
import { seasonFor } from '../src/season';
import { CfbdClient } from '../src/sources/cfbd';

/** The season's rosters, for resolving spoken player names (one cached CFBD call). */
async function loadRoster(season: number): Promise<RosterIndex> {
  const rows = await new CfbdClient(requireEnv('CFBD_API_KEY')).roster(season);
  if (rows.length === 0) throw new Error(`CFBD returned an empty roster for ${season}`);
  return indexRoster(rows);
}

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
    // Fetched before any paid API call, so a CFBD failure costs nothing.
    const roster = dryRun ? new Map() : await loadRoster(season);
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
      const stored = resolveFactPlayers(resolveFactTeams(res.facts, kalshiPlusNews, canonical), roster);
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
} else if (cmd === 'windows') {
  runJob('news:windows', async () => {
    loadEnv();
    const dir = path.resolve(arg('dir', path.join(DATA_DIR, 'transcripts'))!);
    const out = path.resolve(arg('out', path.join(DATA_DIR, 'news-work'))!);
    const db = openDb();
    fs.mkdirSync(out, { recursive: true });
    const files = listTranscripts(dir);
    if (files.length === 0) throw new Error(`no transcripts found under ${dir}`);
    let written = 0;
    let skipped = 0;
    for (const file of files) {
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
      const slug = path.basename(file, '.md').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
      const target = path.join(out, `${slug}.windows.json`);
      fs.writeFileSync(target, JSON.stringify({ source_file: file, sha1: hash, meta: t.meta, windows: ws }, null, 2));
      log.info(`${path.basename(target)}: ${ws.length} window(s), ~${Math.round(ws.reduce((n, w) => n + w.text.length, 0) / 4)} tokens`);
      written += 1;
    }
    log.info(`wrote ${written} window file(s) to ${out} (${skipped} transcript(s) already processed)`);
  });
} else if (cmd === 'import') {
  runJob('news:import', async () => {
    loadEnv();
    const inDir = path.resolve(arg('in', path.join(DATA_DIR, 'news-work'))!);
    const model = arg('model', 'manual')!;
    const db = openDb();
    const aliases = loadAliases();
    const season = seasonFor(new Date());
    const canonical = teamsInSeason(db, season);
    if (canonical.size === 0) log.warn(`no games stored for ${season}; team names will not be resolved to CFBD names`);
    const kalshiPlusNews = { ...aliases.kalshi, ...(aliases.news ?? {}) };
    const ImportSchema = z.object({ source_file: z.string(), facts: z.array(FactSchema) });
    const roster = await loadRoster(season);

    const files = fs.existsSync(inDir) ? fs.readdirSync(inDir).filter((f) => f.endsWith('.facts.json')).sort() : [];
    if (files.length === 0) throw new Error(`no *.facts.json files under ${inDir}`);
    let done = 0;
    let skipped = 0;
    let totalFacts = 0;
    for (const name of files) {
      const parsed = ImportSchema.safeParse(JSON.parse(fs.readFileSync(path.join(inDir, name), 'utf8')));
      if (!parsed.success) {
        log.warn(`skip ${name}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
        continue;
      }
      const { source_file, facts } = parsed.data;
      if (!fs.existsSync(source_file)) {
        log.warn(`skip ${name}: transcript not found at ${source_file}`);
        continue;
      }
      const md = fs.readFileSync(source_file, 'utf8');
      const hash = sha1(md);
      const t = parseTranscript(md, source_file);
      if (!t.meta.as_of) {
        log.warn(`skip ${name}: no date in front matter`);
        continue;
      }
      if (alreadyProcessed(db, t.meta.url, hash)) {
        skipped += 1;
        continue;
      }
      const ws = relevantWindows(t.lines);
      const stored = resolveFactPlayers(resolveFactTeams(facts, kalshiPlusNews, canonical), roster);
      const unresolved = [...new Set(stored.filter((f) => !f.team_resolved).map((f) => f.team))];
      if (unresolved.length) log.warn(`  unresolved team name(s): ${unresolved.join(', ')} (add to the "news" section of config/team-aliases.json)`);
      const n = storeFacts(db, t.meta, stored, { file: source_file, sha1: hash, windows: ws.length, input_tokens: 0, output_tokens: 0, model });
      log.info(`${path.basename(source_file)}: ${n} fact(s) stored`);
      for (const f of stored) log.info(`  ${f.team_resolved ?? f.team}: ${f.player ?? '(group)'} [${f.position}] ${f.status}/${f.scope} c=${f.confidence.toFixed(1)} — ${f.detail}`);
      totalFacts += n;
      done += 1;
    }
    log.info(`imported ${done} file(s), skipped ${skipped} already done; ${totalFacts} new fact(s) (model=${model})`);
  });
} else if (cmd === 'restamp') {
  runJob('news:restamp', async () => {
    loadEnv();
    const dir = path.resolve(arg('dir', path.join(DATA_DIR, 'transcripts'))!);
    const db = openDb();
    const files = listTranscripts(dir);
    if (files.length === 0) throw new Error(`no transcripts found under ${dir}`);
    const res = restampFacts(db, files);
    log.info(`restamped ${res.moved} fact(s) across ${res.transcripts} transcript(s); ${res.unchanged} transcript(s) unchanged; ${res.noDate} still without a publish date`);
  });
} else if (cmd === 'availability') {
  // Official availability reports saved by TranscriptGPT's availability.js
  // (data/availability/<source>/*.json) -> facts at confidence 1.0. No API
  // calls besides the cached roster. Each team's report is stored once, keyed
  // by its posting time, so re-runs and unchanged re-fetches are no-ops.
  runJob('news:availability', async () => {
    loadEnv();
    const dir = path.resolve(arg('dir', path.join(DATA_DIR, 'availability'))!);
    const db = openDb();
    const aliases = loadAliases();
    const season = seasonFor(new Date());
    const canonical = teamsInSeason(db, season);
    const kalshiPlusNews = { ...aliases.kalshi, ...(aliases.news ?? {}) };
    const files: string[] = [];
    const walk = (d: string) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.json')) files.push(p);
      }
    };
    walk(dir);
    files.sort();
    if (files.length === 0) {
      log.info(`no availability reports under ${dir}`);
      return;
    }
    const roster = await loadRoster(season);
    // An "Available" row is stored only when it clears a recent non-available fact.
    const recentlyOut = db.prepare(
      `SELECT player FROM news_facts WHERE team = ? AND player IS NOT NULL AND status NOT IN ('available', 'unknown') AND as_of <= ? AND as_of >= ?`,
    );
    let stored = 0;
    let teams = 0;
    let skipped = 0;
    for (const file of files) {
      const parsed = AvailabilityFileSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (!parsed.success) throw new Error(`${path.basename(file)}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      const rep = parsed.data;
      for (const g of rep.games) {
        for (const t of g.teams) {
          const teamCanon = resolveTeam(t.team, kalshiPlusNews);
          const team = canonical.has(teamCanon) ? teamCanon : null;
          const probe = teamReportFacts(rep.source, rep.page, g, t, () => false);
          if (!probe) continue;
          const since = new Date(Date.parse(probe.as_of) - 21 * 86_400_000).toISOString();
          const outNames = team ? (recentlyOut.all(team, probe.as_of, since) as { player: string }[]).map((r) => r.player) : [];
          const keepAvailable = (name: string) => {
            const canon = team ? canonicalPlayer(roster, team, name, null) ?? name : name;
            return outNames.some((n) => n === canon || n === name || sameName(n, name));
          };
          const tr = teamReportFacts(rep.source, rep.page, g, t, keepAvailable)!;
          const hash = sha1(JSON.stringify({ g: [g.report_type, g.publish_date, g.posted_time], rows: t.rows }));
          if (alreadyProcessed(db, tr.url, hash)) {
            skipped += 1;
            continue;
          }
          const meta = { title: tr.title, channel: tr.channel, url: tr.url, video_id: null, as_of: tr.as_of, as_of_source: 'published' as const, duration_sec: null };
          const facts = resolveFactPlayers(resolveFactTeams(tr.facts, kalshiPlusNews, canonical), roster);
          const n = storeFacts(db, meta, facts, { file, sha1: hash, windows: t.rows.length, input_tokens: 0, output_tokens: 0, model: 'availability-report' });
          if (!team) log.warn(`  ${t.team}: not a ${season} team name; add it to the "news" aliases in config/team-aliases.json`);
          const qbs = facts.filter((f) => f.position === 'QB' && f.status !== 'available').map((f) => `${f.player} ${f.status}`);
          log.info(`${rep.source} ${g.report_type} ${g.publish_date} ${g.posted_time}: ${team ?? t.team} ${n} fact(s)${qbs.length ? ` (QB: ${qbs.join(', ')})` : ''}`);
          stored += n;
          teams += 1;
        }
      }
    }
    log.info(`availability: ${stored} fact(s) from ${teams} team report(s); ${skipped} already stored`);
  });
} else if (cmd === 'players') {
  // One-time (and safe to re-run) cleanup: resolve every stored player name
  // against the roster. Where the new name collides with a fact already stored
  // from the same source, the duplicate row is deleted. --dry-run prints only.
  runJob('news:players', async () => {
    loadEnv();
    const dryRun = flag('dry-run');
    const db = openDb();
    const roster = await loadRoster(seasonFor(new Date()));
    const rows = db
      .prepare(`SELECT id, source_url, team_raw, team, player, player_raw, position, status FROM news_facts WHERE player IS NOT NULL AND team IS NOT NULL ORDER BY id`)
      .all() as { id: number; source_url: string; team_raw: string; team: string; player: string; player_raw: string | null; position: string | null; status: string }[];
    const clash = db.prepare(`SELECT id FROM news_facts WHERE source_url = ? AND team_raw = ? AND player = ? AND status = ? AND id <> ?`);
    const rename = db.prepare(`UPDATE news_facts SET player = ?, player_raw = COALESCE(player_raw, ?) WHERE id = ?`);
    const drop = db.prepare(`DELETE FROM news_facts WHERE id = ?`);
    const keepRaw = db.prepare(`UPDATE news_facts SET player_raw = player WHERE player_raw IS NULL AND player IS NOT NULL`);
    const changes = new Map<string, number>();
    let renamed = 0;
    let merged = 0;
    db.transaction(() => {
      for (const r of rows) {
        const name = canonicalPlayer(roster, r.team, r.player, r.position);
        if (!name || name === r.player) continue;
        const key = `${r.team}: ${r.player} -> ${name}`;
        changes.set(key, (changes.get(key) ?? 0) + 1);
        if (dryRun) continue;
        if (clash.get(r.source_url, r.team_raw, name, r.status, r.id)) {
          drop.run(r.id);
          merged += 1;
        } else {
          rename.run(name, r.player, r.id);
          renamed += 1;
        }
      }
      if (!dryRun) keepRaw.run();
    })();
    for (const [k, n] of [...changes].sort()) console.log(`  ${k}${n > 1 ? ` (${n})` : ''}`);
    log.info(dryRun ? `dry run: ${[...changes.values()].reduce((a, b) => a + b, 0)} fact(s) would change` : `renamed ${renamed} fact(s), removed ${merged} same-source duplicate(s)`);
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
  console.error('usage: tsx scripts/news.ts <extract|windows|import|restamp|players|availability|report> [options]');
  process.exit(2);
}
