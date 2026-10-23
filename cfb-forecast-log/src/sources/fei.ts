import fs from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { loadFeiConfig, type FeiConfig } from '../config';
import { log } from '../log';
import { CACHE_DIR } from '../paths';
import { getText, sleep } from '../util/http';

export interface FeiRating {
  team: string; // name as printed on the page (not yet mapped to CFBD)
  fei: number;
  ofei: number | null;
  dfei: number | null;
}

/**
 * Parse the FEI ratings table out of a bcftoys page. Header-driven so column
 * order changes do not break it: needs a "Team" column and a "FEI" column;
 * "OFEI"/"DFEI" are optional.
 */
export function parseFeiHtml(html: string): FeiRating[] {
  const $ = cheerio.load(html);
  const tables = $('table').toArray();
  for (const table of tables) {
    const rows = $(table).find('tr').toArray();
    let cols: { team: number; fei: number; ofei: number | null; dfei: number | null } | null = null;
    const out: FeiRating[] = [];
    for (const tr of rows) {
      const cells = $(tr)
        .find('th,td')
        .toArray()
        .map((c) => $(c).text().replace(/\s+/g, ' ').trim());
      if (cells.length === 0) continue;
      const lower = cells.map((c) => c.toLowerCase());
      const teamIdx = lower.indexOf('team');
      const feiIdx = lower.indexOf('fei');
      if (teamIdx >= 0 && feiIdx >= 0) {
        // Header row (may repeat mid-table on bcftoys pages).
        const ofei = lower.indexOf('ofei');
        const dfei = lower.indexOf('dfei');
        cols = { team: teamIdx, fei: feiIdx, ofei: ofei >= 0 ? ofei : null, dfei: dfei >= 0 ? dfei : null };
        continue;
      }
      if (!cols) continue;
      const team = cells[cols.team];
      const fei = parseNum(cells[cols.fei]);
      if (!team || fei === null) continue;
      out.push({
        team,
        fei,
        ofei: cols.ofei !== null ? parseNum(cells[cols.ofei]) : null,
        dfei: cols.dfei !== null ? parseNum(cells[cols.dfei]) : null,
      });
    }
    if (out.length > 0) return out;
  }
  throw new Error('FEI: no ratings table found on page (layout changed?)');
}

function parseNum(s: string | undefined): number | null {
  if (s === undefined) return null;
  const m = s.replace(/,/g, '').match(/^[+-]?\d*\.?\d+$/);
  return m ? Number(m[0]) : null;
}

/** True if robots.txt forbids `urlPath` for either our UA or '*'. Conservative, minimal parser. */
export function robotsDisallows(robotsTxt: string, userAgent: string, urlPath: string): boolean {
  const uaToken = userAgent.split(/[\s/(]/)[0].toLowerCase();
  let applies = false;
  let disallowed = false;
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [k, ...rest] = line.split(':');
    const v = rest.join(':').trim();
    const key = k.trim().toLowerCase();
    if (key === 'user-agent') {
      applies = v === '*' || v.toLowerCase() === uaToken;
    } else if (key === 'disallow' && applies && v) {
      if (urlPath.startsWith(v)) disallowed = true;
    } else if (key === 'allow' && applies && v && urlPath.startsWith(v)) {
      return false;
    }
  }
  return disallowed;
}

export class FeiClient {
  private readonly cfg: FeiConfig;
  private lastRequestAt = 0;

  constructor(private readonly userAgent: string, cfg?: FeiConfig, private readonly cacheDir = CACHE_DIR) {
    this.cfg = cfg ?? loadFeiConfig();
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  private async politeGet(url: string): Promise<string> {
    const wait = this.lastRequestAt + this.cfg.request_delay_ms - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
    log.info(`FEI GET ${url}`);
    return getText(url, { headers: { 'user-agent': this.userAgent } });
  }

  private async assertAllowed(pageUrl: string): Promise<void> {
    const u = new URL(pageUrl);
    const robotsFile = path.join(this.cacheDir, `robots-${u.hostname}-${today()}.txt`);
    let robots: string;
    if (fs.existsSync(robotsFile)) {
      robots = fs.readFileSync(robotsFile, 'utf8');
    } else {
      try {
        robots = await this.politeGet(this.cfg.robots_url);
      } catch {
        robots = ''; // no robots.txt => nothing disallowed
      }
      fs.writeFileSync(robotsFile, robots);
    }
    if (robotsDisallows(robots, this.userAgent, u.pathname)) {
      throw new Error(`FEI: robots.txt disallows ${u.pathname}; not fetching`);
    }
  }

  /**
   * Fetch (at most once per day; cached to data/cache/fei-YYYY-MM-DD.html) and
   * parse the season's FEI page. Historical seasons use a per-season cache file
   * that never expires.
   */
  async ratings(season: number, opts: { historical?: boolean } = {}): Promise<FeiRating[]> {
    const url = this.cfg.season_url.replace('{season}', String(season));
    const cacheFile = opts.historical
      ? path.join(this.cacheDir, `fei-season-${season}.html`)
      : path.join(this.cacheDir, `fei-${today()}.html`);
    let html: string;
    if (fs.existsSync(cacheFile)) {
      log.info(`FEI: using cached ${path.basename(cacheFile)}`);
      html = fs.readFileSync(cacheFile, 'utf8');
    } else {
      await this.assertAllowed(url);
      html = await this.politeGet(url);
      const parsed = parseFeiHtml(html); // validate before caching so a bad page is retried
      if (parsed.length < 100) throw new Error(`FEI: only ${parsed.length} teams parsed; expected ~130 FBS teams`);
      fs.writeFileSync(cacheFile, html);
    }
    return parseFeiHtml(html);
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
