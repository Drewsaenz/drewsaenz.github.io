export interface FetchOpts {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Total attempts for transient failures (timeouts, network errors, 429, 5xx). Default 3. */
  attempts?: number;
  /** Delays between attempts in ms. Default [2000, 5000]. */
  backoffMs?: number[];
}

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly url: string, body: string) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 300)}`);
  }
}

/** Timeouts, dropped connections, rate limits and server errors are worth retrying; 4xx client errors are not. */
export function isTransient(err: unknown): boolean {
  if (err instanceof HttpError) return err.status === 429 || err.status >= 500;
  if (err instanceof Error) return err.name === 'AbortError' || err.name === 'TimeoutError' || err instanceof TypeError;
  return false;
}

async function getOnce(url: string, opts: FetchOpts): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 30_000);
  try {
    const res = await fetch(url, { method: 'GET', headers: opts.headers, signal: ctl.signal, redirect: 'follow' });
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, url, text);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET-only helper. There is deliberately no POST/PUT/DELETE in this project.
 * GETs are safe to repeat, so transient failures are retried with backoff; if
 * every attempt fails the last error is thrown and the job still fails loud.
 */
export async function getText(url: string, opts: FetchOpts = {}): Promise<string> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const backoff = opts.backoffMs ?? [2000, 5000];
  for (let i = 1; ; i++) {
    try {
      return await getOnce(url, opts);
    } catch (err) {
      if (i >= attempts || !isTransient(err)) throw err;
      const wait = backoff[Math.min(i - 1, backoff.length - 1)] ?? 0;
      console.warn(`${new Date().toISOString()} WARN  GET ${url} failed (${err instanceof Error ? err.name + ': ' + err.message : err}); retry ${i + 1}/${attempts} in ${wait}ms`);
      await sleep(wait);
    }
  }
}

export async function getJson(url: string, opts: FetchOpts = {}): Promise<unknown> {
  const text = await getText(url, { ...opts, headers: { accept: 'application/json', ...(opts.headers ?? {}) } });
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response from ${url}: ${text.slice(0, 200)}`);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
