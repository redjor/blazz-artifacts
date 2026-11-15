import { closeSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { Kind, Version } from './repo.ts';
import { versionDir } from './storage.ts';

// Excerpt shown on dashboard cards: plain text only, never HTML.
export type Preview = { heading: string | null; text: string | null } | null;

const READ_BYTES = 64 * 1024;
const HEADING_MAX = 120;
const TEXT_MAX = 280;
const JSON_MAX = 200;
const CACHE_MAX = 500;

function readHead(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(READ_BYTES);
    const n = readSync(fd, buf, 0, READ_BYTES, 0);
    // A multi-byte character cut at the end of the read becomes U+FFFD: drop it.
    return buf.subarray(0, n).toString('utf8').replace(/�+$/, '');
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

const clip = (s: string, max: number): string | null => {
  const t = s.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// Block tags → space; inline tags → nothing ("<b>x</b>," stays "x,").
const stripTags = (s: string) =>
  decodeEntities(s.replace(/<\/?(?:br|p|div|li|ul|ol|h[1-6]|tr|td|th|section|article|header|footer|blockquote)\b[^>]*>/gi, ' ').replace(/<[^>]*>/g, ''));

function htmlPreview(raw: string): Preview {
  const html = raw
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ');
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
  const heading = clip(stripTags(title ?? ''), HEADING_MAX) ?? clip(stripTags(h1 ?? ''), HEADING_MAX);
  let text: string | null = null;
  for (const m of html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    text = clip(stripTags(m[1]), TEXT_MAX);
    if (text) break;
  }
  return { heading, text };
}

const stripInline = (s: string) =>
  stripTags(
    s
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
      .replace(/`+([^`]*)`+/g, '$1')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=[^\w*]|$)/g, '$1$2')
      .replace(/~~(.+?)~~/g, '$1'),
  );

function markdownPreview(md: string): Preview {
  const lines = md.replace(/^﻿/, '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').split(/\r?\n/);
  let heading: string | null = null;
  let para: string[] = [];
  let text: string | null = null;
  let fence: string | null = null;
  for (const line of lines) {
    const t = line.trim();
    if (fence) {
      if (t.startsWith(fence)) fence = null;
      continue;
    }
    const f = /^(```|~~~)/.exec(t);
    const isHeading = /^#{1,6}\s/.test(t);
    if (heading === null && /^#\s/.test(t)) heading = clip(stripInline(t.replace(/^#\s+/, '').replace(/\s#+$/, '')), HEADING_MAX);
    const breaks = !t || f || isHeading || /^([-*_])(\s*\1){2,}$/.test(t) || t.startsWith('|') || /^<\/?[a-z][^>]*>$/i.test(t);
    if (breaks) {
      if (text === null && para.length) text = clip(stripInline(para.join(' ')), TEXT_MAX);
      para = [];
      if (f) fence = f[1];
    } else if (text === null) {
      para.push(t.replace(/^>\s?/, '').replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, ''));
    }
    if (heading !== null && text !== null) break;
  }
  if (text === null && para.length) text = clip(stripInline(para.join(' ')), TEXT_MAX);
  return { heading, text };
}

function jsonPreview(raw: string): Preview {
  let pretty: string;
  try {
    pretty = JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    pretty = raw.trim(); // file truncated at 64 KiB: show the beginning as is
  }
  const text = pretty.slice(0, JSON_MAX);
  return { heading: null, text: text.trim() ? text : null };
}

export function computePreview(dataDir: string, artifactId: string, kind: Kind, version: Version): Preview {
  const dir = versionDir(dataDir, artifactId, version.id);
  const file = { markdown: 'source.md', json: 'source.json', html: version.entry_path, site: version.entry_path, pdf: null }[kind];
  if (!file) return null;
  const raw = readHead(join(dir, file));
  if (raw === null) return null;
  if (kind === 'markdown') return markdownPreview(raw);
  if (kind === 'json') return jsonPreview(raw);
  return htmlPreview(raw);
}

// Cache per version (immutable once published); bounded, oldest evicted first.
export function createPreviewCache(dataDir: string) {
  const cache = new Map<string, Preview>();
  return (artifactId: string, kind: Kind, version: Version | undefined): Preview => {
    if (!version) return null;
    const key = `${version.id}:${kind}`;
    if (cache.has(key)) return cache.get(key)!;
    const p = computePreview(dataDir, artifactId, kind, version);
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(key, p);
    return p;
  };
}
