import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadCfbdConfig } from '../src/config';
import { CfbdClient } from '../src/sources/cfbd';

function seed(dir: string, url: string, body: unknown, ageHours: number) {
  const key = crypto.createHash('sha1').update(url).digest('hex');
  fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify({ fetched_at: new Date(Date.now() - ageHours * 3_600_000).toISOString(), url, body }));
}

test('big CFBD responses fall back to an expired cached copy when CFBD is unreachable; others do not', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfbd-'));
  const cfg = { ...loadCfbdConfig(), base_url: 'http://127.0.0.1:9' }; // nothing listens there
  const client = new CfbdClient('k', cfg, dir);
  seed(dir, `${cfg.base_url}/stats/player/season?category=passing&seasonType=regular&year=2026`, [{ player: 'Arch Manning', team: 'Texas', statType: 'ATT', stat: '300' }], 30);
  const rows = await client.passAttempts(2026);
  assert.deepEqual(rows, [{ team: 'Texas', player: 'Arch Manning', attempts: 300 }]);

  seed(dir, `${cfg.base_url}/games?seasonType=regular&year=2026`, [], 30);
  await assert.rejects(() => client.games(2026)); // schedules never fall back
  fs.rmSync(dir, { recursive: true });
});
