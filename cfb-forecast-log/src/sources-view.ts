/**
 * Tracker section: what the collectors have downloaded, from where, and what
 * the news pipeline got out of it. Reads only local files (data/transcripts,
 * data/availability) and the DB; no network, no writes.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './db';

export type SourceKind = 'Video' | 'Insider article' | 'News article' | 'Official report' | 'Other';

export interface SourceItem {
  key: string; // news_facts.source_url, or a prefix for report files
  title: string;
  url: string | null;
  group: string;
  kind: SourceKind;
  at: string; // when it was downloaded (saved / fetched)
  facts: { team: string; player: string | null; position: string | null; status: string }[];
  processed: boolean;
}

export interface SourceGroup {
  group: string;
  kind: SourceKind;
  items: number;
  facts: number;
  pending: number;
  last: string | null;
}

export interface SourcesView {
  groups: SourceGroup[];
  recent: SourceItem[];
  totals: { items: number; facts: number; pending: number };
}

/** Front matter fields from the top of a transcript/article file. */
export function frontMatter(text: string): Record<string, string> {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    let v = line.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) {
      try {
        v = JSON.parse(v);
      } catch {
        v = v.slice(1, -1);
      }
    }
    out[line.slice(0, i).trim()] = v;
  }
  return out;
}

/** Which source a file belongs to, for grouping. */
export function classify(fm: Record<string, string>, folder: string): { group: string; kind: SourceKind } {
  if (fm.source === 'rss') return { group: `${fm.feed || 'RSS'} (RSS)`, kind: 'News article' };
  if (fm.source === 'otf-forum') return { group: `${fm.channel || 'On Texas Football'} (site)`, kind: 'Insider article' };
  if (fm.video_id) return { group: fm.channel || folder, kind: 'Video' };
  return { group: fm.channel || folder, kind: 'Other' };
}

function walk(dir: string, ext: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out);
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

export function collectSources(db: Db, transcriptsDir: string, availabilityDir: string, recentN = 20): SourcesView {
  const factStmt = db.prepare(`SELECT COALESCE(team, team_raw) AS team, player, position, status FROM news_facts WHERE source_url = ? ORDER BY team, player`);
  const runStmt = db.prepare(`SELECT 1 FROM news_runs WHERE source_url = ?`);
  const items: SourceItem[] = [];

  for (const file of walk(transcriptsDir, '.md')) {
    const head = fs.readFileSync(file, 'utf8').slice(0, 4000);
    const fm = frontMatter(head);
    const folder = path.basename(path.dirname(file));
    const url = fm.url || (fm.video_id ? `https://www.youtube.com/watch?v=${fm.video_id}` : `file://${file}`);
    const { group, kind } = classify(fm, folder);
    const at = fm.saved && !Number.isNaN(Date.parse(fm.saved)) ? new Date(fm.saved).toISOString() : fs.statSync(file).mtime.toISOString();
    items.push({
      key: url,
      title: fm.title || path.basename(file, '.md'),
      url: /^https?:/.test(url) ? url : null,
      group,
      kind,
      at,
      facts: factStmt.all(url) as SourceItem['facts'],
      processed: Boolean(runStmt.get(url)),
    });
  }

  // Official reports: one item per saved report file; its facts are keyed per team.
  const byPrefix = db.prepare(`SELECT COALESCE(team, team_raw) AS team, player, position, status FROM news_facts WHERE source_channel = ? AND source_title LIKE ? ORDER BY team, player`);
  for (const file of walk(availabilityDir, '.json')) {
    let rep: { source?: string; page?: string | null; fetched_at?: string; games?: { report_type?: string | null; publish_date?: string | null; posted_time?: string | null }[] };
    try {
      rep = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const src = rep.source ?? path.basename(path.dirname(file)).toUpperCase();
    const g = rep.games?.[0];
    const type = g?.report_type ?? 'Report';
    const label = `${src} ${type.toLowerCase()} report, posted ${g?.publish_date ?? '?'} ${g?.posted_time?.slice(0, 5) ?? ''}`.trim();
    const facts = byPrefix.all(`${src} availability report`, `${src} ${type} availability report:%`) as SourceItem['facts'];
    items.push({
      key: file,
      title: label,
      url: rep.page ?? null,
      group: `${src} availability report`,
      kind: 'Official report',
      at: rep.fetched_at ?? fs.statSync(file).mtime.toISOString(),
      facts,
      processed: facts.length > 0,
    });
  }

  const groups = new Map<string, SourceGroup>();
  for (const it of items) {
    const g = groups.get(it.group) ?? { group: it.group, kind: it.kind, items: 0, facts: 0, pending: 0, last: null };
    g.items += 1;
    g.facts += it.facts.length;
    if (!it.processed) g.pending += 1;
    if (!g.last || it.at > g.last) g.last = it.at;
    groups.set(it.group, g);
  }
  const KIND_ORDER: SourceKind[] = ['Official report', 'Insider article', 'News article', 'Video', 'Other'];
  const sorted = [...groups.values()].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.facts - a.facts || a.group.localeCompare(b.group));
  return {
    groups: sorted,
    recent: [...items].sort((a, b) => b.at.localeCompare(a.at)).slice(0, recentN),
    totals: { items: items.length, facts: items.reduce((n, i) => n + i.facts.length, 0), pending: items.filter((i) => !i.processed).length },
  };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function renderSources(v: SourcesView, fmtTime: (iso: string) => string): string {
  const rows = v.groups
    .map(
      (g) =>
        `<tr><td><span class="sg">${esc(g.group)}</span><span class="sub">${esc(g.kind)}${g.last ? ` · latest ${esc(fmtTime(g.last))}` : ''}</span></td><td class="num">${g.items}</td><td class="num">${g.facts}</td><td class="num${g.pending ? ' wait' : ''}">${g.pending || '—'}</td></tr>`,
    )
    .join('');
  const recent = v.recent
    .map((it) => {
      const title = it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a>` : esc(it.title);
      const state = !it.processed ? `<span class="pill wait">waiting for extraction</span>` : it.facts.length ? `<span class="pill">${it.facts.length} fact${it.facts.length === 1 ? '' : 's'}</span>` : `<span class="pill none">no injury news</span>`;
      const list = it.facts.length
        ? `<details><summary>Show facts</summary><ul>${it.facts
            .slice(0, 40)
            .map((f) => `<li><b>${esc(f.team)}</b> ${esc(f.player ?? '(group)')}${f.position && f.position !== 'unknown' ? ` <span class="sub">${esc(f.position)}</span>` : ''} · <span class="st ${esc(f.status)}">${esc(f.status)}</span></li>`)
            .join('')}${it.facts.length > 40 ? `<li class="sub">and ${it.facts.length - 40} more</li>` : ''}</ul></details>`
        : '';
      return `<li class="ri"><div class="rt">${title}</div><div class="rm"><span class="sub">${esc(fmtTime(it.at))} · ${esc(it.group)}</span> ${state}</div>${list}</li>`;
    })
    .join('');
  return `<section class="card sources">
  <div class="label">News sources</div>
  <div class="small" style="margin:2px 0 10px">${v.totals.items} items downloaded, ${v.totals.facts} injury and availability facts extracted${v.totals.pending ? `, ${v.totals.pending} waiting for the hourly extraction` : ''}.</div>
  <div class="scroll"><table class="st-t"><thead><tr><th>Source</th><th class="num">Items</th><th class="num">Facts</th><th class="num">Waiting</th></tr></thead><tbody>${rows}</tbody></table></div>
  <div class="label" style="margin:16px 0 6px">Latest downloads</div>
  <ul class="recent">${recent}</ul>
</section>`;
}

export const SOURCES_CSS = `
.sources .scroll{overflow-x:auto}
table.st-t{width:100%}.st-t .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.st-t .num.wait{color:var(--warn-ink);font-weight:600}
.st-t .sg{font-weight:600;display:block}.sources .sub{font-size:12px;color:var(--muted);font-weight:400}
.recent{list-style:none;margin:0;padding:0}.ri{padding:8px 0;border-bottom:1px solid var(--line)}.ri:last-child{border-bottom:0}
.rt{font-size:14px}.rt a{color:var(--ink);text-decoration:none}.rt a:hover{text-decoration:underline}
.rm{margin-top:2px;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.pill{font-size:11px;font-weight:600;border-radius:999px;padding:1px 8px;background:var(--accent);color:#fff}.pill.none{background:var(--line);color:var(--muted)}.pill.wait{background:var(--warn-bg);color:var(--warn-ink)}
.ri details{margin-top:4px;font-size:13px}.ri summary{cursor:pointer;color:var(--accent)}.ri ul{margin:6px 0 0;padding-left:18px}
.st.out{color:var(--bad);font-weight:600}.st.doubtful{color:var(--bad)}.st.questionable,.st.limited{color:var(--warn-ink)}.st.available,.st.probable,.st.returning{color:var(--ok)}
`;
