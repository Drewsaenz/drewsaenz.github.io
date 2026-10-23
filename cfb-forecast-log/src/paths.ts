import path from 'node:path';

/** Project root (the directory containing package.json). */
export const ROOT = path.resolve(__dirname, '..');
export const CONFIG_DIR = path.join(ROOT, 'config');
export const DATA_DIR = path.join(ROOT, 'data');
export const CACHE_DIR = path.join(DATA_DIR, 'cache');
export const REPORTS_DIR = path.join(ROOT, 'reports');
export const SCHEMA_PATH = path.join(ROOT, 'db', 'schema.sql');
