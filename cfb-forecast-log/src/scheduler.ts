/**
 * Long-running scheduler using node-cron (alternative: cron.example).
 * Each job runs as a child `npm run <job>` so a crash in one job cannot take
 * the scheduler down, and jobs never overlap.
 */
import { spawnSync } from 'node:child_process';
import cron from 'node-cron';
import { log } from './log';
import { ROOT } from './paths';

const TZ = 'America/Chicago';
const JOBS: { name: string; schedule: string }[] = [
  { name: 'ratings', schedule: '0 6 * * 2' },
  { name: 'snapshot:tuesday', schedule: '0 7 * * 2' },
  { name: 'snapshot:pregame', schedule: '*/30 * * * 4,5,6' },
  { name: 'resolve', schedule: '0 6 * * 0,1' },
  { name: 'report', schedule: '30 6 * * 1' },
];

let busy = false;
function run(name: string): void {
  if (busy) {
    log.warn(`skipping ${name}: another job is still running`);
    return;
  }
  busy = true;
  try {
    const res = spawnSync('npm', ['run', '-s', name], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, TZ } });
    if (res.status !== 0) log.error(`${name} exited with status ${res.status}`);
  } finally {
    busy = false;
  }
}

for (const j of JOBS) {
  cron.schedule(j.schedule, () => run(j.name), { timezone: TZ });
  log.info(`scheduled ${j.name} at "${j.schedule}" ${TZ}`);
}
