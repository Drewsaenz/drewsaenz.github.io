import fs from 'node:fs';
import path from 'node:path';

function stamp(): string {
  return new Date().toISOString();
}

export const log = {
  info: (msg: string, ...rest: unknown[]) => console.log(`${stamp()} INFO  ${msg}`, ...rest),
  warn: (msg: string, ...rest: unknown[]) => console.warn(`${stamp()} WARN  ${msg}`, ...rest),
  error: (msg: string, ...rest: unknown[]) => console.error(`${stamp()} ERROR ${msg}`, ...rest),
};

/**
 * Runs a job body and enforces "fail loud": any thrown error is printed and
 * the process exits non-zero. Jobs do all their DB writes inside a single
 * transaction after validation, so a failure here means nothing was written.
 */
export async function runJob(name: string, body: () => Promise<void>): Promise<void> {
  const started = Date.now();
  log.info(`[${name}] start`);
  try {
    await body();
    const line = `[${name}] done in ${((Date.now() - started) / 1000).toFixed(1)}s`;
    log.info(line);
    recordRun(`${stamp()} INFO  ${line}`);
  } catch (err) {
    log.error(`[${name}] FAILED, nothing written for this run:`, err instanceof Error ? err.stack ?? err.message : err);
    recordRun(`${stamp()} ERROR [${name}] FAILED, nothing written for this run: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

/**
 * The tracker and the app read job outcomes from data/jobs.log. Cron already sends
 * all output there; a run from Terminal or the app's buttons did not, so a manual
 * fix (e.g. re-running resolve after a failure) left the "failed" warning up.
 * Append the outcome line unless stdout already goes to that file. Off in tests.
 */
function recordRun(line: string): void {
  if (process.env.NODE_TEST_CONTEXT || process.env.JOBS_LOG === 'off') return;
  try {
    const file = process.env.JOBS_LOG || path.join(path.resolve(__dirname, '..'), 'data', 'jobs.log');
    if (!fs.existsSync(path.dirname(file))) return;
    if (fs.existsSync(file)) {
      const out = fs.fstatSync(1);
      const target = fs.statSync(file);
      if (out.dev === target.dev && out.ino === target.ino) return; // cron: stdout is jobs.log already
    }
    fs.appendFileSync(file, `${line}\n`);
  } catch {
    // Logging the outcome must never change the job's result.
  }
}
