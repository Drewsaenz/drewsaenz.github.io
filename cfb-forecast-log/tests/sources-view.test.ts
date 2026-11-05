import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openDb } from '../src/db';
import { classify, collectSources, frontMatter, renderSources } from '../src/sources-view';

test('front matter reads quoted and bare values', () => {
  const fm = frontMatter('---\ntitle: "Florida\'s QB: Jones"\nurl: https://x.test/a\nsource: rss\n---\n# body');
  assert.equal(fm.title, "Florida's QB: Jones");
  assert.equal(fm.url, 'https://x.test/a');
});

test('files are grouped by feed, forum, or channel', () => {
  assert.deepEqual(classify({ source: 'rss', feed: 'Yahoo' }, 'rss news'), { group: 'Yahoo (RSS)', kind: 'News article' });
  assert.deepEqual(classify({ source: 'otf-forum', channel: 'On Texas Football' }, 'otf'), { group: 'On Texas Football (site)', kind: 'Insider article' });
  assert.deepEqual(classify({ video_id: 'abc', channel: 'Josh Pate' }, 'national'), { group: 'Josh Pate', kind: 'Video' });
});

test('collectSources counts items, facts and pending extraction per source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'src-view-'));
  const tdir = path.join(root, 'transcripts', 'national');
  fs.mkdirSync(tdir, { recursive: true });
  const write = (name: string, fm: string) => fs.writeFileSync(path.join(tdir, name), `---\n${fm}\n---\nbody`);
  write('a.md', 'title: "A"\nchannel: "Josh Pate"\nvideo_id: aaa\nurl: https://y.test/a\nsaved: 2026-11-05T10:00:00.000Z');
  write('b.md', 'title: "B"\nchannel: "Josh Pate"\nvideo_id: bbb\nurl: https://y.test/b\nsaved: 2026-11-05T12:00:00.000Z');
  const adir = path.join(root, 'availability', 'sec');
  fs.mkdirSync(adir, { recursive: true });
  fs.writeFileSync(path.join(adir, 'r.json'), JSON.stringify({ source: 'SEC', page: 'https://sec.test', fetched_at: '2026-11-05T01:00:00.000Z', games: [{ report_type: 'Initial', publish_date: '2026-11-04', posted_time: '19:10:00' }] }));

  const db = openDb(':memory:');
  const fact = db.prepare(
    `INSERT INTO news_facts (source_url, source_channel, source_title, as_of, team_raw, team, player, position, status, scope, detail, confidence, timestamp_sec, extracted_at, model) VALUES (?, ?, ?, '2026-11-05', ?, ?, ?, 'QB', 'out', 'game', '', 1, 0, 'x', 'm')`,
  );
  fact.run('https://y.test/a', 'Josh Pate', 'A', 'Texas', 'Texas', 'Arch Manning');
  fact.run('https://sec.test#1', 'SEC availability report', 'SEC Initial availability report: Texas vs Missouri', 'Texas', 'Texas', 'Hollywood Smothers');
  db.prepare(`INSERT INTO news_runs (source_url, file, sha1, windows, facts, processed_at, model) VALUES ('https://y.test/a', 'a.md', 'h', 1, 1, 'x', 'm')`).run();

  const v = collectSources(db, path.join(root, 'transcripts'), path.join(root, 'availability'));
  const pate = v.groups.find((g) => g.group === 'Josh Pate')!;
  assert.deepEqual([pate.items, pate.facts, pate.pending], [2, 1, 1]);
  const sec = v.groups.find((g) => g.group === 'SEC availability report')!;
  assert.deepEqual([sec.kind, sec.items, sec.facts, sec.pending], ['Official report', 1, 1, 0]);
  assert.equal(v.groups[0].kind, 'Official report'); // official sources listed first
  assert.equal(v.recent[0].title, 'B'); // newest download first
  assert.deepEqual(v.totals, { items: 3, facts: 2, pending: 1 });

  const html = renderSources(v, (iso) => iso.slice(0, 10));
  assert.match(html, /waiting for extraction/);
  assert.match(html, /Hollywood Smothers/);
});
