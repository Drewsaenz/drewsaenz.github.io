import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { openDb, upsertGames } from '../src/db';
import { AVAILABILITY_RE, alreadyProcessed, batchWindows, parseTranscript, qbFlags, relevantWindows, resolveFactTeams, restampFacts, sha1, storeFacts, teamNews, windows, type Fact } from '../src/news';
import { game } from './helpers';

const md = fs.readFileSync(path.join(__dirname, 'fixtures', 'transcript-sample.md'), 'utf8');

test('parseTranscript reads front matter and timestamped lines, stripping noise', () => {
  const t = parseTranscript(md, 'x.md');
  assert.equal(t.meta.title, 'Sample Preview Show');
  assert.equal(t.meta.channel, 'Sample Channel');
  assert.equal(t.meta.url, 'https://www.youtube.com/watch?v=abc123');
  assert.equal(t.meta.as_of, '2026-11-01T18:00:00.000Z');
  assert.equal(t.meta.as_of_source, 'saved');
  assert.equal(t.meta.duration_sec, 300);
  assert.equal(t.lines[0].t, 5); // [music] line dropped, ">>" stripped
  assert.equal(t.lines[0].text, 'Welcome back to the show, we have a');
  assert.ok(t.lines.some((l) => l.t === 120 && l.text.startsWith('Hollywood')));
});

test('parseTranscript prefers a published date when the scraper records one', () => {
  const t = parseTranscript(md.replace('saved: 2026-11-01T18:00:00.000Z', 'published: 20261029\nsaved: 2026-11-01T18:00:00.000Z'));
  assert.equal(t.meta.as_of.slice(0, 10), '2026-10-29');
  assert.equal(t.meta.as_of_source, 'published');
});

test('windows overlap and cover every line', () => {
  const lines = Array.from({ length: 100 }, (_, i) => ({ t: i, text: `l${i}` }));
  const ws = windows(lines, 40, 30);
  assert.equal(ws[0].start_sec, 0);
  assert.equal(ws[1].start_sec, 30);
  assert.equal(ws[ws.length - 1].end_sec, 99);
});

test('relevantWindows keeps availability talk and drops recruiting and candy corn', () => {
  const t = parseTranscript(md);
  const ws = relevantWindows(t.lines);
  assert.equal(ws.length, 1); // whole short transcript is one window
  assert.match(ws[0].text, /starting quarterback/);
  assert.ok(AVAILABILITY_RE.test('he is listed as doubtful'));
  assert.ok(AVAILABILITY_RE.test('Coleman was in street clothes'));
  assert.ok(AVAILABILITY_RE.test('He had a bandaged hand after bleeding in the game'));
  assert.ok(AVAILABILITY_RE.test('Smothers could miss two weeks and is day-to-day'));
  assert.ok(!AVAILABILITY_RE.test('three star linebackers are underrated'));
  assert.ok(!AVAILABILITY_RE.test('I think Texas covers the spread'));
});

test('batchWindows respects the size cap', () => {
  const ws = Array.from({ length: 5 }, (_, i) => ({ start_sec: i, end_sec: i, text: 'x'.repeat(10_000) }));
  const b = batchWindows(ws, 24_000);
  assert.deepEqual(b.map((x) => x.length), [2, 2, 1]);
});

test('facts resolve team names, store once, and skip reprocessing', () => {
  const db = openDb(':memory:');
  upsertGames(db, [game({ game_id: 1, season: 2026, week: 9, home_team: 'Texas', away_team: 'Mississippi State', kickoff_utc: '2026-10-31T23:30:00Z' })]);
  const t = parseTranscript(md.replace('saved: 2026-11-01T18:00:00.000Z', 'published: 2026-10-29'));
  const facts: Fact[] = [
    { team: 'Mississippi State', player: 'Kamario Taylor', position: 'QB', status: 'out', scope: 'season', detail: 'starting QB out for the season', confidence: 1, timestamp_sec: 24 },
    { team: 'Horns', player: 'Collin Simmons', position: 'EDGE', status: 'doubtful', scope: 'game', detail: 'Sark said doubtful', confidence: 0.9, timestamp_sec: 31 },
    { team: 'Mississippi State', player: 'Kamario Taylor', position: 'QB', status: 'out', scope: 'season', detail: 'duplicate', confidence: 1, timestamp_sec: 200 },
    { team: 'Nowhere U', player: null, position: 'OL', status: 'limited', scope: 'unknown', detail: 'x', confidence: 0.3, timestamp_sec: 1 },
  ];
  const stored = resolveFactTeams(facts, { Horns: 'Texas' }, new Set(['Texas', 'Mississippi State']));
  assert.equal(stored[1].team_resolved, 'Texas');
  assert.equal(stored[3].team_resolved, null);
  const hash = sha1(md);
  const n = storeFacts(db, t.meta, stored, { file: 'x.md', sha1: hash, windows: 1, input_tokens: 10, output_tokens: 5, model: 'test' });
  assert.equal(n, 3); // duplicate ignored
  assert.ok(alreadyProcessed(db, t.meta.url, hash));
  assert.ok(!alreadyProcessed(db, t.meta.url, 'other'));
  storeFacts(db, { ...t.meta, url: 'https://x/empty' }, [], { file: 'e.md', sha1: 'h', windows: 0, input_tokens: 0, output_tokens: 0, model: 'test' });
  assert.ok(!alreadyProcessed(db, 'https://x/empty', 'h')); // zero-window runs are re-checked

  const news = teamNews(db, '2026-10-20T00:00:00Z', '2026-11-05T00:00:00Z');
  assert.deepEqual(news.map((x) => x.team).sort(), ['Mississippi State', 'Nowhere U', 'Texas']);

  const flags = qbFlags(db);
  assert.deepEqual(flags.get(1), ['Mississippi State QB Kamario Taylor out']);
});

test('qbFlags ignores facts recorded after kickoff', () => {
  const db = openDb(':memory:');
  upsertGames(db, [game({ game_id: 1, season: 2026, week: 9, home_team: 'Texas', away_team: 'Mississippi State', kickoff_utc: '2026-10-31T23:30:00Z' })]);
  const t = parseTranscript(md); // saved 2026-11-01, after kickoff
  storeFacts(db, t.meta, resolveFactTeams([{ team: 'Mississippi State', player: 'AJ Swann', position: 'QB', status: 'out', scope: 'game', detail: 'knocked out', confidence: 1, timestamp_sec: 1 }], {}, new Set(['Mississippi State'])), { file: 'x', sha1: 'h', windows: 1, input_tokens: 0, output_tokens: 0, model: 't' });
  assert.equal(qbFlags(db).size, 0);
});

test('restampFacts moves facts to the publish date once the scraper backfills it', () => {
  const db = openDb(':memory:');
  upsertGames(db, [game({ game_id: 1, season: 2026, week: 9, home_team: 'Texas', away_team: 'Mississippi State', kickoff_utc: '2026-10-31T23:30:00Z' })]);
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'restamp-'));
  const file = path.join(dir, 't.md');
  fs.writeFileSync(file, md); // saved-only front matter, Nov 1
  const t = parseTranscript(md, file);
  storeFacts(db, t.meta, resolveFactTeams([{ team: 'Mississippi State', player: 'Kamario Taylor', position: 'QB', status: 'out', scope: 'season', detail: 'x', confidence: 1, timestamp_sec: 1 }], {}, new Set(['Mississippi State'])), { file, sha1: sha1(md), windows: 1, input_tokens: 0, output_tokens: 0, model: 't' });
  assert.equal(qbFlags(db).size, 0); // Nov 1 is after kickoff
  // Scraper backfills a publish date before the game.
  const md2 = md.replace('saved: 2026-11-01T18:00:00.000Z', 'published: 2026-10-29T17:00:00.000Z\npublished_source: rss\nsaved: 2026-11-01T18:00:00.000Z');
  fs.writeFileSync(file, md2);
  const first = restampFacts(db, [file]);
  assert.deepEqual(first, { transcripts: 1, moved: 1, unchanged: 0, noDate: 0 });
  assert.deepEqual(qbFlags(db).get(1), ['Mississippi State QB Kamario Taylor out']);
  assert.ok(alreadyProcessed(db, t.meta.url, sha1(md2))); // hash refreshed, no re-extraction
  assert.deepEqual(restampFacts(db, [file]), { transcripts: 0, moved: 0, unchanged: 1, noDate: 0 });
});

test('parseTranscript falls back to paragraphs for untimed articles', () => {
  const article = `---\ntitle: "Hollywood Smothers Update"\nchannel: "On Texas Football"\nauthor: "Bobby Burton"\nurl: https://ontexasfootball.com/topic/1-x/\nsource: otf-forum\npublished: 2026-11-02T17:10:00.000Z\npublished_source: site\nsaved: 2026-11-02T18:00:00.000Z\ntimestamps: false\n---\n\n# Hollywood Smothers Update\n\n## Bobby Burton\n\nSmothers is expected to miss two to three weeks with the ankle injury, per a source.\n\nCoaches are hopeful for LSU.\n`;
  const t = parseTranscript(article, 'a.md');
  assert.equal(t.meta.as_of_source, 'published');
  assert.equal(t.lines.length, 4);
  assert.equal(t.lines[0].text, 'Hollywood Smothers Update');
  const ws = relevantWindows(t.lines);
  assert.equal(ws.length, 1);
  assert.match(ws[0].text, /miss two to three weeks/);
});
