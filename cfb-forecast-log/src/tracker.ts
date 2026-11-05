/**
 * Weekly progress tracker. Reads only the local DB, data/jobs.log and the
 * reports/ folder (no network, no writes to the DB) and renders one static
 * HTML page showing where the current week is in the pipeline.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './db';
import { BOARD_CSS, BOARD_JS, renderBoard, type BoardView } from './board';
import { RESULTS_CSS, RESULTS_JS, renderResults, type ResultsView } from './results';
import { SOURCES_CSS, renderSources, type SourcesView } from './sources-view';

const TZ = 'America/Chicago';
export const SEASON_TARGET_WEEKS = 8;
const STALE_PREGAME_MIN = 45;

export type StageStatus = 'done' | 'active' | 'pending' | 'failed';

export interface Stage {
  key: string;
  label: string;
  schedule: string;
  status: StageStatus;
  detail: string;
}

export interface JobRun {
  job: string;
  lastDone: string | null;
  lastFailed: string | null;
}

export interface TrackerState {
  generatedAt: string;
  season: number | null;
  week: number | null;
  headline: string;
  stages: Stage[];
  weeksScored: number;
  warnings: string[];
  jobs: JobRun[];
}

const JOBS = ['ratings', 'snapshot:tuesday', 'snapshot:pregame', 'resolve', 'report'];

export function chicago(iso: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...opts }).format(new Date(iso));
}
const shortTime = (iso: string) => chicago(iso, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/** Last success and last failure per job, from data/jobs.log lines written by runJob(). */
export function parseJobLog(text: string): JobRun[] {
  const runs = new Map<string, JobRun>(JOBS.map((j) => [j, { job: j, lastDone: null, lastFailed: null }]));
  const re = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) (INFO|ERROR) +\[([^\]]+)\] (done|FAILED)/;
  for (const line of text.split('\n')) {
    const m = line.match(re);
    if (!m) continue;
    const run = runs.get(m[3]);
    if (!run) continue;
    if (m[4] === 'done') run.lastDone = m[1];
    else run.lastFailed = m[1];
  }
  return [...runs.values()];
}

/** Latest mtime of any reports/*.md file, or null. */
export function latestReport(dir: string): { file: string; mtime: string } | null {
  if (!fs.existsSync(dir)) return null;
  let best: { file: string; mtime: string } | null = null;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const mtime = fs.statSync(path.join(dir, f)).mtime.toISOString();
    if (!best || mtime > best.mtime) best = { file: f, mtime };
  }
  return best;
}

interface WeekRow {
  game_id: number;
  ticker: string | null;
  snapshot_kind: string;
  snapshot_utc: string;
  outcome: number | null;
  resolved_at: string | null;
  kickoff_utc: string;
}

export function collectState(db: Db, now: Date, logText: string, report: { file: string; mtime: string } | null): TrackerState {
  const generatedAt = now.toISOString();
  const jobs = parseJobLog(logText);
  const warnings: string[] = [];

  for (const j of jobs) {
    if (j.lastFailed && (!j.lastDone || j.lastFailed > j.lastDone)) {
      warnings.push(`The ${j.job} job failed at ${shortTime(j.lastFailed)} and has not succeeded since. Check data/jobs.log.`);
    }
  }

  const weeksScored = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT g.season || '-' || g.week) AS n FROM forecasts f JOIN games g ON g.game_id = f.game_id
          WHERE f.snapshot_kind = 'tuesday' AND f.outcome IS NOT NULL`,
      )
      .get() as { n: number }
  ).n;

  // Current week = the week of the most recent Tuesday snapshot.
  const latest = db
    .prepare(
      `SELECT g.season, g.week FROM forecasts f JOIN games g ON g.game_id = f.game_id
        WHERE f.snapshot_kind = 'tuesday' ORDER BY f.snapshot_utc DESC LIMIT 1`,
    )
    .get() as { season: number; week: number } | undefined;

  const ratingsFor = (season: number, week: number) =>
    db.prepare('SELECT COUNT(*) AS n, MAX(fetched_at) AS at FROM ratings WHERE season = ? AND week = ?').get(season, week) as { n: number; at: string | null };

  if (!latest) {
    const anyRatings = db.prepare('SELECT season, week FROM ratings ORDER BY fetched_at DESC LIMIT 1').get() as { season: number; week: number } | undefined;
    const r = anyRatings ? ratingsFor(anyRatings.season, anyRatings.week) : { n: 0, at: null };
    const stages = baseStages();
    stages[0].status = r.n > 0 ? 'done' : 'pending';
    stages[0].detail = r.n > 0 ? `${r.n} ratings · ${shortTime(r.at!)}` : 'Not pulled yet';
    return {
      generatedAt,
      season: anyRatings?.season ?? null,
      week: anyRatings?.week ?? null,
      headline: r.n > 0 ? 'Ratings are in. Predictions go in Tuesday at 7 AM.' : 'Waiting for the first Tuesday run.',
      stages,
      weeksScored,
      warnings,
      jobs,
    };
  }

  const { season, week } = latest;
  const rows = db
    .prepare(
      `SELECT f.game_id, f.ticker, f.snapshot_kind, f.snapshot_utc, f.outcome, f.resolved_at, g.kickoff_utc
         FROM forecasts f JOIN games g ON g.game_id = f.game_id
         LEFT JOIN forecast_voids v ON v.forecast_id = f.id
        WHERE g.season = ? AND g.week = ? AND f.snapshot_kind <> 'manual' AND v.forecast_id IS NULL`,
    )
    .all(season, week) as WeekRow[];
  const voided = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM forecast_voids v JOIN forecasts f ON f.id = v.forecast_id JOIN games g ON g.game_id = f.game_id
          WHERE g.season = ? AND g.week = ? AND f.snapshot_kind <> 'manual'`,
      )
      .get(season, week) as { n: number }
  ).n;

  const stages = baseStages();
  const nowMs = now.getTime();

  // 1. Ratings
  const r = ratingsFor(season, week);
  stages[0].status = r.n > 0 ? 'done' : 'pending';
  stages[0].detail = r.n > 0 ? `${r.n} ratings · ${shortTime(r.at!)}` : 'Not pulled yet';

  // 2. Tuesday predictions
  const tues = rows.filter((x) => x.snapshot_kind === 'tuesday');
  stages[1].status = tues.length > 0 ? 'done' : 'pending';
  stages[1].detail = tues.length > 0 ? `${new Set(tues.map((x) => x.ticker)).size} markets · ${shortTime(tues[0].snapshot_utc)}` : 'Not logged yet';

  // 3. Pregame snapshots, counted per game. Tue/Wed games are outside the Thu-Sat schedule.
  const games = new Map<number, { kickoff: string; pregame: boolean }>();
  for (const x of rows) {
    const g = games.get(x.game_id) ?? { kickoff: x.kickoff_utc, pregame: false };
    if (x.snapshot_kind === 'pregame') g.pregame = true;
    games.set(x.game_id, g);
  }
  let captured = 0;
  let missed = 0;
  let upcoming = 0;
  let offSchedule = 0;
  for (const g of games.values()) {
    const day = chicago(g.kickoff, { weekday: 'short' });
    const scheduled = day === 'Thu' || day === 'Fri' || day === 'Sat';
    if (g.pregame) captured += 1;
    else if (!scheduled) offSchedule += 1;
    else if (Date.parse(g.kickoff) <= nowMs) missed += 1;
    else upcoming += 1;
  }
  const inScope = captured + missed + upcoming;
  stages[2].status = upcoming === 0 && inScope > 0 ? 'done' : captured + missed > 0 ? 'active' : 'pending';
  stages[2].detail =
    `${captured} of ${inScope} games captured` +
    (missed > 0 ? ` · ${missed} missed` : '') +
    (upcoming > 0 ? ` · ${upcoming} to go` : '') +
    (offSchedule > 0 ? ` · ${offSchedule} Tue/Wed not tracked` : '');
  if (missed > 0) warnings.push(`${missed} game(s) kicked off without a pregame snapshot. The Mac was probably asleep during their window.`);

  // Stalled pregame runs during the Thu-Sat window.
  const today = chicago(generatedAt, { weekday: 'short' });
  const pre = jobs.find((j) => j.job === 'snapshot:pregame')!;
  const lastPre = [pre.lastDone, pre.lastFailed].filter(Boolean).sort().pop();
  if ((today === 'Thu' || today === 'Fri' || today === 'Sat') && upcoming > 0) {
    const ageMin = lastPre ? (nowMs - Date.parse(lastPre)) / 60_000 : Infinity;
    if (ageMin > STALE_PREGAME_MIN) {
      warnings.push(
        lastPre
          ? `Pregame checks last ran ${Math.round(ageMin)} minutes ago. They should run every 30 minutes. Is the Mac asleep or cron off?`
          : 'No pregame check has run yet today. Is cron installed?',
      );
    }
  }

  // 4. Final scores
  const resolved = rows.filter((x) => x.outcome !== null);
  const allKicked = [...games.values()].every((g) => Date.parse(g.kickoff) <= nowMs);
  stages[3].status = rows.length > 0 && resolved.length === rows.length ? 'done' : resolved.length > 0 ? 'active' : 'pending';
  stages[3].detail = `${resolved.length} of ${rows.length} rows graded` + (voided > 0 ? ` · ${voided} void (game cancelled or moved)` : '');

  // 5. Report: a report file written after the week's last result was filled in.
  const lastResolved = resolved.map((x) => x.resolved_at!).sort().pop();
  const reportDone = stages[3].status === 'done' && report !== null && lastResolved !== undefined && report.mtime >= lastResolved;
  stages[4].status = reportDone ? 'done' : 'pending';
  stages[4].detail = reportDone ? `reports/${report!.file}` : '';

  // Mark a stage failed when its job's latest run failed.
  const jobForStage: Record<string, string> = { ratings: 'ratings', tuesday: 'snapshot:tuesday', pregame: 'snapshot:pregame', results: 'resolve', report: 'report' };
  for (const s of stages) {
    const j = jobs.find((x) => x.job === jobForStage[s.key]);
    if (s.status !== 'done' && j?.lastFailed && (!j.lastDone || j.lastFailed > j.lastDone)) s.status = 'failed';
  }

  let headline: string;
  if (stages[0].status !== 'done') headline = 'Waiting for Tuesday’s ratings pull.';
  else if (stages[1].status !== 'done') headline = 'Predictions go in Tuesday at 7 AM.';
  else if (stages[2].status !== 'done') headline = captured + missed === 0 ? 'Predictions logged. Pregame checks start Thursday.' : `Pregame checks running: ${captured} of ${inScope} games captured.`;
  else if (stages[3].status !== 'done') headline = resolved.length === 0 ? (allKicked ? 'All games played. Grading runs Sunday and Monday at 6 AM.' : 'Games in progress.') : `Grading: ${resolved.length} of ${rows.length} rows done.`;
  else if (stages[4].status !== 'done') headline = 'Everything is graded. Report drops Monday at 6:30 AM.';
  else headline = `Week ${week} report is ready: reports/${report!.file}`;

  return { generatedAt, season, week, headline, stages, weeksScored, warnings, jobs };
}

function baseStages(): Stage[] {
  return [
    { key: 'ratings', label: 'Ratings pulled', schedule: 'Tue 6:00 AM', status: 'pending', detail: '' },
    { key: 'tuesday', label: 'Predictions logged', schedule: 'Tue 7:00 AM', status: 'pending', detail: '' },
    { key: 'pregame', label: 'Pregame checks', schedule: 'Thu–Sat, every 30 min', status: 'pending', detail: '' },
    { key: 'results', label: 'Games graded', schedule: 'Sun & Mon 6:00 AM', status: 'pending', detail: '' },
    { key: 'report', label: 'Report ready', schedule: 'Mon 6:30 AM', status: 'pending', detail: '' },
  ];
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function renderTracker(s: TrackerState, results: ResultsView | null = null, board: BoardView | null = null, sources: SourcesView | null = null): string {
  const icon: Record<StageStatus, string> = { done: '✓', active: '●', pending: '', failed: '!' };
  const word: Record<StageStatus, string> = { done: 'Done', active: 'In progress', pending: 'Up next', failed: 'Failed' };
  const SHORT: Record<string, string> = { ratings: 'Ratings', tuesday: 'Picks', pregame: 'Pregame', results: 'Graded', report: 'Report' };
  const steps = s.stages
    .map((st, i) => {
      const tip = [st.label, word[st.status], st.schedule, st.detail].filter(Boolean).join(' · ');
      return `<li class="step ${st.status}" title="${esc(tip)}"><span class="dot" aria-hidden="true">${icon[st.status] || i + 1}</span><span class="sl">${esc(SHORT[st.key] ?? st.label)}</span><span class="vh">${esc(word[st.status])}</span></li>`;
    })
    .join('');
  // One line of detail: the failed stage, else the first unfinished one, else the last.
  const focus = s.stages.find((x) => x.status === 'failed') ?? s.stages.find((x) => x.status !== 'done') ?? s.stages[s.stages.length - 1];
  const focusLine = `<div class="focus ${focus.status}"><b>${esc(focus.label)}</b> <span class="state">${word[focus.status]}</span><span class="small"> · ${esc(focus.detail || focus.schedule)}</span></div>`;
  const pips = Array.from({ length: SEASON_TARGET_WEEKS }, (_, i) => `<span class="pip${i < s.weeksScored ? ' on' : ''}"></span>`).join('');
  const warnings = s.warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join('');
  const jobs = s.jobs
    .map(
      (j) => `<tr><td>${esc(j.job)}</td><td>${j.lastDone ? esc(shortTime(j.lastDone)) : '—'}</td><td class="${j.lastFailed && (!j.lastDone || j.lastFailed > j.lastDone) ? 'bad' : ''}">${j.lastFailed ? esc(shortTime(j.lastFailed)) : '—'}</td></tr>`,
    )
    .join('');
  const title = s.week ? `Week ${s.week}, ${s.season}` : 'No week yet';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="300">
<title>Forecast Tracker</title>
<style>
:root{--bg:#f5f6f8;--card:#fff;--ink:#16202c;--muted:#5d6b7c;--line:#dde3ea;--accent:#1f6feb;--ok:#1a7f45;--warn-bg:#fff4dc;--warn-ink:#7a4b00;--bad:#c62828}
@media (prefers-color-scheme:dark){:root{--bg:#0e131a;--card:#161d27;--ink:#e6ecf2;--muted:#94a3b5;--line:#273242;--accent:#5b9dff;--ok:#43c47a;--warn-bg:#3a2c0e;--warn-ink:#f3cf86;--bad:#ff6b6b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:13px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin:0 0 4px}
.head{font-size:22px;font-weight:650;margin:0 0 4px}
.upd{color:var(--muted);font-size:13px;margin-bottom:20px}.upd.stale{color:var(--bad)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:16px}
.warn{background:var(--warn-bg);color:var(--warn-ink);border-radius:10px;padding:10px 14px;margin-bottom:10px;font-size:14px}
.steps{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(5,1fr)}
.step{position:relative;display:flex;flex-direction:column;align-items:center;gap:4px;cursor:default}
.step:not(:first-child)::before{content:"";position:absolute;top:12px;left:-50%;right:50%;height:2px;background:var(--line)}
.step.done+.step::before{background:var(--ok)}
.dot{position:relative;z-index:1;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font-weight:700;font-size:12px;border:2px solid var(--line);color:var(--muted);background:var(--card)}
.done .dot{background:var(--ok);border-color:var(--ok);color:#fff}
.active .dot{border-color:var(--accent);color:var(--accent)}
.failed .dot{background:var(--bad);border-color:var(--bad);color:#fff}
.sl{font-size:12px;color:var(--muted)}.done .sl,.active .sl{color:var(--ink)}.failed .sl{color:var(--bad)}
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.focus{margin-top:12px;padding-top:10px;border-top:1px solid var(--line);font-size:14px}
.label{font-weight:600}.state{font-weight:500;font-size:12px;color:var(--muted);margin-left:4px}
.active .state{color:var(--accent)}.failed .state{color:var(--bad)}.done .state{color:var(--ok)}
.pips{display:flex;gap:6px;margin:8px 0 4px}.pip{flex:1;height:8px;border-radius:4px;background:var(--line)}.pip.on{background:var(--accent)}
.small{font-size:13px;color:var(--muted)}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:6px 4px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-weight:500}td.bad{color:var(--bad);font-weight:600}
${RESULTS_CSS}
${BOARD_CSS}
${SOURCES_CSS}
</style></head>
<body><main>
<h1>${esc(title)}</h1>
<div class="head">${esc(s.headline)}</div>
<div class="upd" id="upd" data-at="${s.generatedAt}">Updated ${esc(shortTime(s.generatedAt))}</div>
${warnings}
<section class="card"><ol class="steps">${steps}</ol>${focusLine}</section>
<section class="card">
  <div class="label">Season progress</div>
  <div class="pips">${pips}</div>
  <div class="small">${s.weeksScored} of ${SEASON_TARGET_WEEKS} weeks graded. Results start to mean something around week 6 to 8.</div>
</section>
${board && board.rows.length ? renderBoard(board, shortTime) : ''}
${results ? renderResults(results) : ''}
${sources && sources.totals.items ? renderSources(sources, shortTime) : ''}
<section class="card">
  <div class="label" style="margin-bottom:6px">Last job runs</div>
  <table><thead><tr><th>Job</th><th>Last success</th><th>Last failure</th></tr></thead><tbody>${jobs}</tbody></table>
</section>
</main>
<div id="tip" role="tooltip"></div>
<script>
${RESULTS_JS}
${BOARD_JS}
(function(){var el=document.getElementById('upd');var at=Date.parse(el.dataset.at);
function tick(){var m=Math.round((Date.now()-at)/60000);el.textContent='Updated '+(m<1?'just now':m+' min ago');
if(m>${STALE_PREGAME_MIN}){el.classList.add('stale');el.textContent+=' (stale: the Mac may be asleep or cron is off)';}}
tick();setInterval(tick,30000);})();
</script>
</body></html>
`;
}
