/**
 * Job: tracker (every 15 min via cron, or on demand)
 * Writes reports/tracker.html from the local DB and job log. Read-only: no
 * network calls and no DB writes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../db';
import { loadEnv } from '../env';
import { runJob } from '../log';
import { DATA_DIR, REPORTS_DIR } from '../paths';
import { collectState, latestReport, renderTracker } from '../tracker';

runJob('tracker', async () => {
  loadEnv();
  const db = openDb();
  const logFile = path.join(DATA_DIR, 'jobs.log');
  const logText = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  const state = collectState(db, new Date(), logText, latestReport(REPORTS_DIR));
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const out = path.join(REPORTS_DIR, 'tracker.html');
  fs.writeFileSync(out, renderTracker(state));
  console.log(`${state.headline}\nwrote ${out}`);
});
