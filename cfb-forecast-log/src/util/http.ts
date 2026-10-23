export interface FetchOpts {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly url: string, body: string) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 300)}`);
  }
}

/** GET-only helper. There is deliberately no POST/PUT/DELETE in this project. */
export async function getText(url: string, opts: FetchOpts = {}): Promise<string> {
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
