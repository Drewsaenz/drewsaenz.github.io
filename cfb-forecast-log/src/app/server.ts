/**
 * Local app: `npm run app`, then open http://localhost:3300 (port: APP_PORT).
 *
 * Listens on 127.0.0.1 only. Reads the database for the Games, News and Health
 * tabs. The only things it can run are the fixed npm/git commands in ACTIONS,
 * the same ones cron and you run in Terminal, one at a time. It cannot place
 * orders or touch Kalshi auth (no such code exists in this project).
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { openDb } from '../db';
import { DATA_DIR, REPORTS_DIR } from '../paths';
import { currentBoardWeek, gameDetail, gamesForWeek, health, recentNews } from './data';
import { APP_HTML } from './page';

const PROJECT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.APP_PORT ?? 3300);

/** Every command the app can run. Steps run in order and stop at the first failure. */
export const ACTIONS: Record<string, { label: string; steps: [string, string[]][] }> = {
  preview: { label: 'Refresh this week\'s preview', steps: [['npm', ['run', '-s', 'ratings']], ['npm', ['run', '-s', 'snapshot:manual']], ['npm', ['run', '-s', 'tracker']]] },
  grade: { label: 'Grade finished games', steps: [['npm', ['run', '-s', 'resolve']], ['npm', ['run', '-s', 'tracker']]] },
  tracker: { label: 'Rebuild the tracker page', steps: [['npm', ['run', '-s', 'tracker']]] },
  pull: { label: 'Pull code updates', steps: [['git', ['pull', '--ff-only']]] },
};

let running: { action: string; output: string; done: boolean; ok: boolean | null; started: string } | null = null;

function runAction(name: string): void {
  const action = ACTIONS[name];
  running = { action: name, output: '', done: false, ok: null, started: new Date().toISOString() };
  const state = running;
  const next = (i: number) => {
    if (i >= action.steps.length) {
      state.done = true;
      state.ok = true;
      return;
    }
    const [cmd, args] = action.steps[i];
    state.output += `$ ${cmd} ${args.join(' ')}\n`;
    const child = spawn(cmd, args, { cwd: PROJECT, env: process.env });
    child.stdout.on('data', (d) => (state.output += d.toString()));
    child.stderr.on('data', (d) => (state.output += d.toString()));
    child.on('error', (e) => {
      state.output += `\n${e.message}\n`;
      state.done = true;
      state.ok = false;
    });
    child.on('close', (code) => {
      if (state.done) return;
      if (code === 0) next(i + 1);
      else {
        state.output += `\nexited with code ${code}\n`;
        state.done = true;
        state.ok = false;
      }
    });
  };
  next(0);
}

function check(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 3000 }, (err, stdout) => resolve(err ? null : stdout)));
}

function send(res: http.ServerResponse, status: number, body: string, type = 'application/json'): void {
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
  res.end(body);
}
const json = (res: http.ServerResponse, value: unknown, status = 200) => send(res, status, JSON.stringify(value));

export function createServer(): http.Server {
  const db = openDb();
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      // Only same-origin browser requests may start an action (blocks other web pages from posting here).
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (origin && origin !== `http://localhost:${PORT}` && origin !== `http://127.0.0.1:${PORT}`) return json(res, { error: 'cross-origin request refused' }, 403);
      }
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, APP_HTML, 'text/html');
      if (req.method === 'GET' && url.pathname === '/tracker') {
        const file = path.join(REPORTS_DIR, 'tracker.html');
        return fs.existsSync(file) ? send(res, 200, fs.readFileSync(file, 'utf8'), 'text/html') : send(res, 404, 'Run "Rebuild the tracker page" first.', 'text/plain');
      }
      if (req.method === 'GET' && url.pathname === '/api/games') {
        const wk = url.searchParams.get('week') ? { season: Number(url.searchParams.get('season') ?? new Date().getFullYear()), week: Number(url.searchParams.get('week')) } : currentBoardWeek(db);
        return json(res, wk ? { ...wk, games: gamesForWeek(db, wk.season, wk.week) } : { games: [] });
      }
      if (req.method === 'GET' && url.pathname === '/api/game') {
        const d = gameDetail(db, Number(url.searchParams.get('id')));
        return d ? json(res, d) : json(res, { error: 'no such game' }, 404);
      }
      if (req.method === 'GET' && url.pathname === '/api/news') {
        const days = Math.min(30, Math.max(1, Number(url.searchParams.get('days') ?? 4)));
        return json(res, recentNews(db, { days, team: url.searchParams.get('team') || undefined, secOnly: url.searchParams.get('sec') === '1' }));
      }
      if (req.method === 'GET' && url.pathname === '/api/health') {
        const logFile = path.join(DATA_DIR, 'jobs.log');
        const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
        const caf = await check('pgrep', ['-x', 'caffeinate']);
        const cron = await check('crontab', ['-l']);
        const cronLines = cron === null ? null : cron.split('\n').filter((l) => /npm run -s /.test(l) && !l.trim().startsWith('#')).length;
        return json(res, { ...health(db, log, caf === null ? false : caf.trim().length > 0, cronLines), actions: Object.fromEntries(Object.entries(ACTIONS).map(([k, v]) => [k, v.label])), running });
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/run/')) {
        const name = url.pathname.slice('/api/run/'.length);
        if (!ACTIONS[name]) return json(res, { error: 'unknown action' }, 404);
        if (running && !running.done) return json(res, { error: `"${ACTIONS[running.action].label}" is still running` }, 409);
        runAction(name);
        return json(res, running);
      }
      if (req.method === 'GET' && url.pathname === '/api/run') return json(res, running);
      return send(res, 404, 'not found', 'text/plain');
    } catch (e) {
      return json(res, { error: (e as Error).message }, 500);
    }
  });
}

if (require.main === module) {
  createServer().listen(PORT, '127.0.0.1', () => console.log(`cfb-forecast-log app: http://localhost:${PORT}  (Ctrl-C to stop)`));
}
