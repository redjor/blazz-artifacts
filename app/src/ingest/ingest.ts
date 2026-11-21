import { chmod, copyFile, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ErrorCode, ErrorParams } from '../errors.ts';
import { HttpError } from '../http.ts';
import { tr, type Locale } from '../i18n.ts';
import type { Theme } from '../themes.ts';
import type { Kind } from '../repo.ts';
import { DIR_MODE, normalizeModes } from '../storage.ts';
import { JsonRejected, renderJson } from './json.ts';
import { renderMarkdown } from './markdown.ts';
import { renderArticle } from './page.ts';
import { extractZip, ZipRejected, type ZipLimits } from './zip.ts';

export class IngestRejected extends HttpError {
  constructor(code: ErrorCode, params?: ErrorParams) {
    super(400, code, params);
  }
}

export interface UploadedFile { tmpPath: string; originalName: string; size: number }
export interface IngestResult { kind: Kind; entryPath: string; sizeBytes: number; fileCount: number }

const MAX_TEXT_BYTES = 5 * 1024 * 1024;

const KINDS: Record<string, Kind> = {
  html: 'html', htm: 'html', md: 'markdown', markdown: 'markdown', pdf: 'pdf', json: 'json', zip: 'site',
};

export function detectKind(name: string): Kind | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return name.includes('.') && Object.hasOwn(KINDS, ext) ? KINDS[ext] : null;
}

export function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, '') || name;
}

async function assertPdf(path: string): Promise<void> {
  const fh = await open(path, 'r');
  try {
    const { buffer } = await fh.read(Buffer.alloc(5), 0, 5, 0);
    if (buffer.toString('latin1') !== '%PDF-') throw new IngestRejected('invalid_pdf');
  } finally {
    await fh.close();
  }
}

// Reader page of a Markdown or JSON file, built from its stored source (re-rendered by src/scripts/rerender-documents.ts).
export function renderSourcePage(kind: 'markdown' | 'json', text: string, title: string, locale: Locale = 'en', theme: Theme | null = null): string {
  if (kind === 'markdown') {
    return renderArticle({ fallbackTitle: title, body: renderMarkdown(text), originalHref: 'source.md', originalLabel: tr(locale, 'original.markdown'), locale, theme });
  }
  return renderArticle({ fallbackTitle: title, body: renderJson(text), originalHref: 'source.json', originalLabel: tr(locale, 'original.json'), locale });
}

export async function ingestFile(file: UploadedFile, destDir: string, limits: ZipLimits, locale: Locale = 'en', theme: Theme | null = null, title?: string): Promise<IngestResult> {
  const result = await ingestInto(file, destDir, limits, locale, theme, title);
  // Modes normalised after writing: a copied upload keeps its own mode (0700 seen in production).
  await normalizeModes(destDir);
  await chmod(dirname(destDir), DIR_MODE);
  return result;
}

async function ingestInto(file: UploadedFile, destDir: string, limits: ZipLimits, locale: Locale, theme: Theme | null, fallbackTitle?: string): Promise<IngestResult> {
  const kind = detectKind(file.originalName);
  if (!kind) throw new IngestRejected('unsupported_format');
  await mkdir(destDir, { recursive: true });
  const title = fallbackTitle ?? stripExtension(file.originalName);
  if ((kind === 'markdown' || kind === 'json') && file.size > MAX_TEXT_BYTES) {
    await rm(destDir, { recursive: true, force: true });
    throw new IngestRejected('text_too_large');
  }
  try {
    switch (kind) {
      case 'html':
        await copyFile(file.tmpPath, join(destDir, 'index.html'));
        return { kind, entryPath: 'index.html', sizeBytes: file.size, fileCount: 1 };
      case 'pdf':
        await assertPdf(file.tmpPath);
        await copyFile(file.tmpPath, join(destDir, 'document.pdf'));
        return { kind, entryPath: 'document.pdf', sizeBytes: file.size, fileCount: 1 };
      case 'markdown': {
        const text = await readFile(file.tmpPath, 'utf8');
        await writeFile(join(destDir, 'source.md'), text);
        await writeFile(join(destDir, 'index.html'), renderSourcePage('markdown', text, title, locale, theme));
        return { kind, entryPath: 'index.html', sizeBytes: file.size, fileCount: 2 };
      }
      case 'json': {
        const text = await readFile(file.tmpPath, 'utf8');
        const page = renderSourcePage('json', text, title, locale);
        await writeFile(join(destDir, 'source.json'), text);
        await writeFile(join(destDir, 'index.html'), page);
        return { kind, entryPath: 'index.html', sizeBytes: file.size, fileCount: 2 };
      }
      case 'site': {
        const r = await extractZip(file.tmpPath, destDir, limits);
        return { kind, entryPath: 'index.html', sizeBytes: r.totalBytes, fileCount: r.fileCount };
      }
    }
  } catch (e) {
    await rm(destDir, { recursive: true, force: true });
    if (e instanceof ZipRejected || e instanceof JsonRejected) throw new IngestRejected(e.code, e.params);
    throw e;
  }
}
