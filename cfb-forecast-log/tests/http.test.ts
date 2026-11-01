import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { getText, HttpError, isTransient } from '../src/util/http';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function scripted(steps: Array<'abort' | 'net' | number | string>) {
  let calls = 0;
  globalThis.fetch = (async () => {
    const step = steps[Math.min(calls++, steps.length - 1)];
    if (step === 'abort') throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    if (step === 'net') throw new TypeError('fetch failed');
    if (typeof step === 'number') return new Response('err', { status: step });
    return new Response(step, { status: 200 });
  }) as typeof fetch;
  return () => calls;
}

test('isTransient', () => {
  assert.equal(isTransient(Object.assign(new Error('x'), { name: 'AbortError' })), true);
  assert.equal(isTransient(new TypeError('fetch failed')), true);
  assert.equal(isTransient(new HttpError(503, 'u', '')), true);
  assert.equal(isTransient(new HttpError(429, 'u', '')), true);
  assert.equal(isTransient(new HttpError(404, 'u', '')), false);
  assert.equal(isTransient(new Error('zod parse')), false);
});

test('getText retries a timeout and a dropped connection, then succeeds', async () => {
  const calls = scripted(['abort', 'net', 'ok']);
  assert.equal(await getText('https://x', { backoffMs: [0] }), 'ok');
  assert.equal(calls(), 3);
});

test('getText gives up after the last attempt and throws the last error', async () => {
  const calls = scripted(['abort']);
  await assert.rejects(getText('https://x', { backoffMs: [0] }), /aborted/);
  assert.equal(calls(), 3);
});

test('getText does not retry client errors', async () => {
  const calls = scripted([404]);
  await assert.rejects(getText('https://x', { backoffMs: [0] }), /HTTP 404/);
  assert.equal(calls(), 1);
});
