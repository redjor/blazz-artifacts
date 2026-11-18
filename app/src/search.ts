// Full-text search (design 07): the text of each artifact's current version in an FTS5 table, kept up to date by the
// admin API, and the query behind GET /api/search.
import { closeSync, openSync, readdirSync, readSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import type { Db } from './db.ts';
import { htmlText, markdownText } from './preview.ts';
import { getTags, getVersion, type Artifact, type Kind, type Version } from './repo.ts';
import { versionDir } from './storage.ts';

/** Searchable text per artifact; the rest is not indexed. */
export const MAX_TEXT_CHARS = 200_000;
/** HTML pages read in a ZIP site. */
export const MAX_SITE_PAGES = 200;
/** Bytes read per file: enough for MAX_TEXT_CHARS of text in markup. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_RESULTS = 200;

function readText(path: string, max = MAX_FILE_BYTES): string {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return '';
  }
  try {
    const buf = Buffer.alloc(max);
    const n = readSync(fd, buf, 0, max, 0);
    // A multi-byte character cut at the end of the read becomes U+FFFD: drop it.
    return buf.subarray(0, n).toString('utf8').replace(/�+$/, '');
  } catch {
    return '';
  } finally {
    closeSync(fd);
  }
}

/** HTML pages of a site, entry page first, then in path order; at most MAX_SITE_PAGES. */
function sitePages(dir: string, entry: string): string[] {
  const pages: string[] = [];
  const walk = (d: string) => {
    let names: string[];
    try {
      names = readdirSync(d, { withFileTypes: true }).map((e) => (e.isDirectory() ? `${e.name}${sep}` : e.name)).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (pages.length >= MAX_SITE_PAGES * 2) return; // enough candidates
      if (name.endsWith(sep)) walk(join(d, name.slice(0, -1)));
      else if (['.html', '.htm'].includes(extname(name).toLowerCase())) pages.push(relative(dir, join(d, name)));
    }
  };
  walk(dir);
  const rest = pages.filter((p) => p !== entry);
  return [entry, ...rest].slice(0, MAX_SITE_PAGES);
}

/** Searchable text of a version: Markdown text without its syntax, JSON source, visible text of the HTML page(s), nothing for a PDF. */
export function extractText(dataDir: string, artifactId: string, kind: Kind, version: Version): string {
  const dir = versionDir(dataDir, artifactId, version.id);
  let text = '';
  if (kind === 'markdown') text = markdownText(readText(join(dir, 'source.md')));
  else if (kind === 'json') text = readText(join(dir, 'source.json'));
  else if (kind === 'html') text = htmlText(readText(join(dir, version.entry_path)));
  else if (kind === 'site') {
    for (const page of sitePages(dir, version.entry_path)) {
      text += `${htmlText(readText(join(dir, page)))}\n`;
      if (text.length >= MAX_TEXT_CHARS) break;
    }
  }
  return text.slice(0, MAX_TEXT_CHARS);
}

const fields = (db: Db, art: Artifact) => ({ title: art.title, slug: art.slug, tags: getTags(db, art.id).join(' '), description: art.description ?? '' });

/** (Re)indexes an artifact entirely, text of its current version included: publish, new or restored version. */
export function indexArtifact(db: Db, dataDir: string, art: Artifact): void {
  const v = art.current_version_id ? getVersion(db, art.current_version_id) : undefined;
  const body = v ? extractText(dataDir, art.id, v.kind ?? art.kind, v) : '';
  const f = fields(db, art);
  db.prepare('DELETE FROM search_index WHERE artifact_id = ?').run(art.id);
  db.prepare('INSERT INTO search_index (artifact_id, title, slug, tags, body, description) VALUES (?, ?, ?, ?, ?, ?)').run(art.id, f.title, f.slug, f.tags, body, f.description);
}

/** Title, slug, tags and description only (the text is unchanged); indexes everything if the artifact has no row yet. */
export function indexFields(db: Db, dataDir: string, art: Artifact): void {
  const f = fields(db, art);
  const res = db.prepare('UPDATE search_index SET title = ?, slug = ?, tags = ?, description = ? WHERE artifact_id = ?').run(f.title, f.slug, f.tags, f.description, art.id);
  if (Number(res.changes) === 0) indexArtifact(db, dataDir, art);
}

/** Indexes every artifact (trash included) that has no row yet: existing hubs, at startup. Returns how many. */
export function indexMissing(db: Db, dataDir: string): number {
  const missing = db
    .prepare('SELECT * FROM artifacts WHERE id NOT IN (SELECT artifact_id FROM search_index)')
    .all() as unknown as Artifact[];
  for (const art of missing) indexArtifact(db, dataDir, art);
  return missing.length;
}

/**
 * FTS5 query from what was typed: every word required, each as a prefix, quoted (quotes and operators are plain text).
 * Null when there is nothing to search (fewer than 2 characters, or no letter or digit).
 */
export function ftsQuery(input: string): string | null {
  if (input.trim().length < 2) return null;
  const words = input
    .normalize('NFC')
    .split(/\s+/)
    .map((w) => w.replace(/"/g, ''))
    .filter((w) => /[\p{L}\p{N}]/u.test(w));
  return words.length ? words.map((w) => `"${w}"*`).join(' ') : null;
}

export interface SnippetPart { text: string; hit: boolean }
export interface SearchResult { id: string; snippet: SnippetPart[] | null }

const OPEN = '\u0002';
const CLOSE = '\u0003';

/** Snippet marked by FTS5 → plain-text segments; null when nothing in it is highlighted. */
function toParts(marked: string | null): SnippetPart[] | null {
  if (!marked || !marked.includes(OPEN)) return null;
  const parts: SnippetPart[] = [];
  for (const [i, chunk] of marked.split(OPEN).entries()) {
    if (i === 0) {
      if (chunk) parts.push({ text: chunk, hit: false });
      continue;
    }
    const [hit, after = ''] = chunk.split(CLOSE);
    if (hit) parts.push({ text: hit, hit: true });
    if (after) parts.push({ text: after, hit: false });
  }
  return parts;
}

/** Live artifacts matching `input` in title, slug, tags, text or description, best first; the snippet comes from the text. */
export function searchArtifacts(db: Db, input: string, limit = MAX_RESULTS): SearchResult[] {
  const match = ftsQuery(input);
  if (!match) return [];
  const rows = db.prepare(`
    SELECT search_index.artifact_id AS id, snippet(search_index, 4, '${OPEN}', '${CLOSE}', '…', 12) AS marked
    FROM search_index JOIN live_artifacts a ON a.id = search_index.artifact_id
    WHERE search_index MATCH ?
    ORDER BY bm25(search_index, 0, 8, 4, 4, 1, 2)
    LIMIT ?`).all(match, limit) as { id: string; marked: string | null }[];
  return rows.map((r) => ({ id: r.id, snippet: toParts(r.marked) }));
}
