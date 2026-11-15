import { hkdfSync } from 'node:crypto';
import type { StatementSync } from 'node:sqlite';
import { hmac } from './crypto.ts';
import { tx, type Db } from './db.ts';

/**
 * Bots and link previews: never counted. Short, careful list (case-insensitive);
 * “whatsapp” covers WhatsApp's preview, whose User-Agent contains none of the other words.
 */
export const BOT_UA = /bot|crawler|spider|slurp|facebookexternalhit|preview|whatsapp|curl|wget|python-requests|headless/i;

/** A missing or empty User-Agent is a script, not a browser. */
export const isBot = (ua: string | undefined): boolean => !ua || BOT_UA.test(ua);

/**
 * Link-preview services of messaging and social apps (design 06), a narrower list than BOT_UA: search engines,
 * curl and scripts are not in it. iMessage announces itself as facebookexternalhit/Facebot/Twitterbot, Signal as
 * WhatsApp, Teams as SkypeUriPreview.
 */
export const LINK_PREVIEW_UA = /slackbot-linkexpanding|slack-imgproxy|facebookexternalhit|facebot|twitterbot|linkedinbot|discordbot|telegrambot|whatsapp|skypeuripreview|microsoftpreview|mattermost|redditbot|iframely|embedly|pinterestbot|vkshare/i;

export const isLinkPreview = (ua: string | undefined): boolean => !!ua && LINK_PREVIEW_UA.test(ua);

/** A given fingerprint adds at most one view per artifact per 30-minute window. */
export const VIEW_WINDOW_MS = 30 * 60_000;
const DAY_MS = 86_400_000;
const HASH_LEN = 22; // 132 bits de HMAC-SHA256 en base64url
/** Anti-abuse cap: beyond 20 distinct fingerprints from one IP on an artifact and a day, that IP is no longer counted. */
export const MAX_VISITORS_PER_IP = 20;

export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export interface VisitRecorder {
  /** Successful access to an artifact entry. Never throws. */
  view(artifactId: string, ip: string, ua: string, nowMs: number): void;
  /** Opening of a folder page (access granted). Never throws. */
  folderView(projectName: string, ip: string, ua: string, nowMs: number): void;
  /** Successful exchange of a share link (artifact or folder). Never throws. */
  linkOpen(linkId: string, nowMs: number): void;
}

/**
 * Counting on the content server. The IP and User-Agent only feed an HMAC fingerprint
 * with a daily key (derived from HUB_SECRET): they are neither stored nor logged.
 */
export function createVisitRecorder(db: Db, secret: Buffer): VisitRecorder {
  let dayKey = { day: '', key: Buffer.alloc(0) };
  let warned = false;
  const keyFor = (day: string): Buffer => {
    if (dayKey.day !== day) dayKey = { day, key: Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), `artifact-hub/visits/${day}`, 32)) };
    return dayKey.key;
  };
  // A visit must never fail because of counting. One trace per process (message only, never a request parameter).
  const guard = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      if (!warned) {
        warned = true;
        console.error(
          '[visits] counting error (logged once per process; it may persist and later visits may not be counted):',
          err instanceof Error ? err.message : 'erreur inconnue',
        );
      }
    }
  };

  // Prepared on the first visit (not when the app is created): a missing table only costs an uncounted visit.
  // Same rule for artifacts and folders; only the tables change.
  type Stmts = { find: StatementSync; perIp: StatementSync; insert: StatementSync; again: StatementSync; count: StatementSync };
  const prepare = (days: string, seen: string, col: string): Stmts => ({
    find: db.prepare(`SELECT last_seen FROM ${seen} WHERE day = ? AND ${col} = ? AND visitor_hash = ?`),
    perIp: db.prepare(`SELECT COUNT(*) AS n FROM ${seen} WHERE day = ? AND ${col} = ? AND ip_hash = ?`),
    insert: db.prepare(`INSERT INTO ${seen} (day, ${col}, visitor_hash, ip_hash, last_seen) VALUES (?, ?, ?, ?, ?)`),
    again: db.prepare(`UPDATE ${seen} SET last_seen = ?, views = views + 1 WHERE day = ? AND ${col} = ? AND visitor_hash = ?`),
    count: db.prepare(`
      INSERT INTO ${days} (${col}, day, views, uniques, last_at) VALUES (?, ?, 1, ?, ?)
      ON CONFLICT (${col}, day) DO UPDATE SET views = views + 1, uniques = uniques + excluded.uniques, last_at = excluded.last_at`),
  });
  let artifactStmts: Stmts | null = null;
  let folderStmts: Stmts | null = null;
  let openStmt: StatementSync | null = null;

  const record = (s: Stmts, target: string, ip: string, ua: string, nowMs: number, scope: string) => {
    const day = utcDay(nowMs);
    const key = keyFor(day);
    const hash = hmac(key, `${scope}${ip}|${ua}`).slice(0, HASH_LEN);
    const ipHash = hmac(key, `${scope}ip:${ip}`).slice(0, HASH_LEN);
    // Fingerprint and aggregate in one transaction: all or nothing.
    tx(db, () => {
      const row = s.find.get(day, target, hash) as { last_seen: number } | undefined;
      let unique = 0;
      if (!row) {
        if (Number((s.perIp.get(day, target, ipHash) as { n: number }).n) >= MAX_VISITORS_PER_IP) return;
        s.insert.run(day, target, hash, ipHash, nowMs);
        unique = 1;
      } else if (row.last_seen <= nowMs - VIEW_WINDOW_MS) {
        s.again.run(nowMs, day, target, hash);
      } else {
        return;
      }
      s.count.run(target, day, unique, new Date(nowMs).toISOString());
    });
  };

  return {
    view(artifactId, ip, ua, nowMs) {
      guard(() => record((artifactStmts ??= prepare('visit_days', 'visit_seen', 'artifact_id')), artifactId, ip, ua, nowMs, ''));
    },
    folderView(projectName, ip, ua, nowMs) {
      // Distinct prefix: folder fingerprints never overlap artifact ones.
      guard(() => record((folderStmts ??= prepare('folder_visit_days', 'folder_visit_seen', 'project_name')), projectName, ip, ua, nowMs, 'folder|'));
    },
    linkOpen(linkId, nowMs) {
      guard(() => {
        (openStmt ??= db.prepare('UPDATE share_links SET open_count = open_count + 1, last_used_at = ? WHERE id = ?')).run(new Date(nowMs).toISOString(), linkId);
      });
    },
  };
}

/**
 * Deletes fingerprints older than yesterday (UTC): only aggregates survive. With secure_delete (openDb),
 * freed pages are wiped; the TRUNCATE checkpoint then empties the WAL that kept a copy.
 */
export function purgeVisitSeen(db: Db, nowMs: number): void {
  db.prepare('DELETE FROM visit_seen WHERE day < ?').run(utcDay(nowMs - DAY_MS));
  db.prepare('DELETE FROM folder_visit_seen WHERE day < ?').run(utcDay(nowMs - DAY_MS));
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

export interface ViewTotals { total: number; last30: number }

export function viewTotals(db: Db, artifactId: string, nowMs: number): ViewTotals {
  const r = db
    .prepare('SELECT COALESCE(SUM(views), 0) AS total, COALESCE(SUM(CASE WHEN day >= ? THEN views END), 0) AS last30 FROM visit_days WHERE artifact_id = ?')
    .get(utcDay(nowMs - 29 * DAY_MS), artifactId) as { total: number; last30: number };
  return { total: Number(r.total), last30: Number(r.last30) };
}

export interface DayCount { day: string; views: number; uniques: number }
export interface VisitStats { total: { views: number; uniques: number }; days: DayCount[]; lastVisitAt: string | null }

/**
 * All-time totals (uniques are a sum of visitors per day: a visitor cannot be recognised
 * from one day to the next, by design) and the last `days` UTC days, zero-filled, oldest first.
 */
export function visitStats(db: Db, artifactId: string, days: number, nowMs: number): VisitStats {
  return statsFrom(db, 'visit_days', 'artifact_id', artifactId, days, nowMs);
}

/** Same statistics for a folder page. */
export function folderVisitStats(db: Db, projectName: string, days: number, nowMs: number): VisitStats {
  return statsFrom(db, 'folder_visit_days', 'project_name', projectName, days, nowMs);
}

function statsFrom(db: Db, table: string, col: string, key: string, days: number, nowMs: number): VisitStats {
  const total = db
    .prepare(`SELECT COALESCE(SUM(views), 0) AS views, COALESCE(SUM(uniques), 0) AS uniques, MAX(last_at) AS last FROM ${table} WHERE ${col} = ?`)
    .get(key) as { views: number; uniques: number; last: string | null };
  const from = utcDay(nowMs - (days - 1) * DAY_MS);
  const rows = db
    .prepare(`SELECT day, views, uniques FROM ${table} WHERE ${col} = ? AND day >= ?`)
    .all(key, from) as unknown as DayCount[];
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const series: DayCount[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = utcDay(nowMs - i * DAY_MS);
    const r = byDay.get(day);
    series.push({ day, views: Number(r?.views ?? 0), uniques: Number(r?.uniques ?? 0) });
  }
  return { total: { views: Number(total.views), uniques: Number(total.uniques) }, days: series, lastVisitAt: total.last };
}
