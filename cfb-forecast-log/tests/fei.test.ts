import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parseFeiHtml, robotsDisallows } from '../src/sources/fei';

test('parseFeiHtml reads a header-driven table and skips repeated headers', () => {
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'fei-sample.html'), 'utf8');
  const rows = parseFeiHtml(html);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], { team: 'Ohio State', fei: 1.12, ofei: 0.61, dfei: 0.51 });
  assert.equal(rows[1].team, 'Miami-FL');
  assert.equal(rows[2].team, 'Texas A&M');
  assert.equal(rows[3].fei, -1.45);
});

test('parseFeiHtml throws when no table matches', () => {
  assert.throws(() => parseFeiHtml('<html><table><tr><th>Foo</th></tr><tr><td>1</td></tr></table></html>'), /no ratings table/);
});

test('robotsDisallows', () => {
  const robots = 'User-agent: *\nDisallow: /private/\n\nUser-agent: badbot\nDisallow: /\n';
  assert.equal(robotsDisallows(robots, 'cfb-forecast-log (x)', '/2025-fei/'), false);
  assert.equal(robotsDisallows(robots, 'cfb-forecast-log (x)', '/private/x'), true);
  assert.equal(robotsDisallows(robots, 'badbot/1.0', '/2025-fei/'), true);
  assert.equal(robotsDisallows('', 'x', '/anything'), false);
});

test('parseFeiHtml merges several tables and dedupes teams', () => {
  const t = (rows: string) => `<table><tr><th>Rk</th><th>Team</th><th>FEI</th></tr>${rows}</table>`;
  const html = t('<tr><td>1</td><td>A</td><td>1.0</td></tr><tr><td>2</td><td>B</td><td>0.5</td></tr>') + '<p>x</p>' + t('<tr><td>3</td><td>C</td><td>0.1</td></tr><tr><td>1</td><td>A</td><td>9.9</td></tr>');
  const rows = parseFeiHtml(html);
  assert.deepEqual(rows.map((r) => [r.team, r.fei]), [['A', 1.0], ['B', 0.5], ['C', 0.1]]);
});
