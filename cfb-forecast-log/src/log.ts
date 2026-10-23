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
    log.info(`[${name}] done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (err) {
    log.error(`[${name}] FAILED, nothing written for this run:`, err instanceof Error ? err.stack ?? err.message : err);
    process.exitCode = 1;
  }
}
