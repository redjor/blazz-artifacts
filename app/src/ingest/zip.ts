import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { CodedError } from '../errors.ts';

export class ZipRejected extends CodedError {}
export interface ZipLimits { maxFiles: number; maxBytes: number }

const RATIO_LIMIT = 100;
const RATIO_MIN_SIZE = 1024 * 1024;

interface Planned { entryName: string; rel: string }

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((res, rej) => {
    yauzl.open(path, { lazyEntries: true, autoClose: true, strictFileNames: true, validateEntrySizes: true }, (err, zf) => {
      if (err || !zf) rej(new ZipRejected('zip_unreadable', { detail: err?.message ?? 'unknown' }));
      else res(zf);
    });
  });
}

const asRejection = (e: unknown) =>
  e instanceof ZipRejected ? e : new ZipRejected('zip_invalid', { detail: (e as Error).message });

function isIgnored(name: string): boolean {
  return name.startsWith('__MACOSX/') || name.split('/').pop() === '.DS_Store';
}

function checkEntryName(name: string): string {
  if (name.includes('\0')) throw new ZipRejected('zip_nul_byte');
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.includes('\\')) {
    throw new ZipRejected('zip_absolute_path', { name });
  }
  const segments = name.split('/');
  if (segments.includes('..')) throw new ZipRejected('zip_traversal', { name });
  const clean = segments.filter((s) => s !== '' && s !== '.').join('/');
  if (!clean) throw new ZipRejected('zip_empty_name');
  return clean;
}

async function scan(zipPath: string, limits: ZipLimits): Promise<Planned[]> {
  const zf = await openZip(zipPath);
  return new Promise((res, rej) => {
    const files: Planned[] = [];
    let count = 0;
    zf.on('error', (e) => rej(asRejection(e)));
    zf.on('end', () => res(files));
    zf.on('entry', (entry: yauzl.Entry) => {
      try {
        const name = entry.fileName;
        if (isIgnored(name)) return zf.readEntry();
        count++;
        if (count > limits.maxFiles) throw new ZipRejected('zip_too_many_files', { max: limits.maxFiles });
        if (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) {
          throw new ZipRejected('zip_symlink', { name });
        }
        const rel = checkEntryName(name);
        if (!name.endsWith('/')) {
          const ratio = entry.uncompressedSize / Math.max(entry.compressedSize, 1);
          if (entry.uncompressedSize > RATIO_MIN_SIZE && ratio > RATIO_LIMIT) {
            throw new ZipRejected('zip_ratio', { name });
          }
          files.push({ entryName: name, rel });
        }
        zf.readEntry();
      } catch (e) {
        zf.close();
        rej(asRejection(e));
      }
    });
    zf.readEntry();
  });
}

function commonRootDir(rels: string[]): string {
  const firsts = new Set(rels.map((r) => (r.includes('/') ? r.split('/')[0] : null)));
  if (rels.length === 0 || firsts.size !== 1 || firsts.has(null)) return '';
  return `${[...firsts][0]}/`;
}

export async function extractZip(zipPath: string, destDir: string, limits: ZipLimits) {
  const planned = await scan(zipPath, limits);
  const prefix = commonRootDir(planned.map((p) => p.rel));
  const targets = new Map<string, string>();
  for (const p of planned) {
    const rel = p.rel.slice(prefix.length);
    if (rel.split('/')[0].startsWith('~')) throw new ZipRejected('zip_reserved_name', { name: p.entryName });
    targets.set(p.entryName, rel);
  }
  if (![...targets.values()].includes('index.html')) {
    throw new ZipRejected('zip_no_index');
  }

  const root = resolve(destDir);
  await mkdir(root, { recursive: true });
  let total = 0;
  const zf = await openZip(zipPath);
  await new Promise<void>((res, rej) => {
    const fail = (e: unknown) => {
      zf.close();
      rej(asRejection(e));
    };
    zf.on('error', fail);
    zf.on('end', () => res());
    zf.on('entry', (entry: yauzl.Entry) => {
      const rel = targets.get(entry.fileName);
      if (rel === undefined) return zf.readEntry();
      const out = resolve(root, rel);
      if (!out.startsWith(root + sep)) return fail(new ZipRejected('zip_outside', { name: entry.fileName }));
      zf.openReadStream(entry, (err, stream) => {
        if (err || !stream) return fail(err ?? new Error('flux absent'));
        const counter = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            total += chunk.length;
            if (total > limits.maxBytes) {
              cb(new ZipRejected('zip_too_large', { max: limits.maxBytes }));
            } else cb(null, chunk);
          },
        });
        mkdir(dirname(out), { recursive: true })
          .then(() => pipeline(stream, counter, createWriteStream(out, { flags: 'wx' })))
          .then(() => zf.readEntry(), fail);
      });
    });
    zf.readEntry();
  });
  return { fileCount: targets.size, totalBytes: total };
}
