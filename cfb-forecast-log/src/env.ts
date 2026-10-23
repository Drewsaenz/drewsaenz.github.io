import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths';

/** Minimal .env loader (no dependency). Existing process.env values win. */
export function loadEnv(file = path.join(ROOT, '.env')): void {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

export function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required environment variable ${key} (see .env.example)`);
  return v;
}

export function optionalInt(key: string): number | undefined {
  const v = process.env[key];
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`${key} must be an integer, got "${v}"`);
  return n;
}
