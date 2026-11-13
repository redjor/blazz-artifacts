import { createWriteStream } from 'node:fs';
import { chmod, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { HttpError } from './http.ts';
import { newId } from './ids.ts';
import { DIR_MODE, FILE_MODE, thumbPath, thumbsDir, type ThumbType } from './storage.ts';
import { discard } from './upload.ts';

/** Hard thumbnail limit (the CLI sends ~50-150 KiB as a 960×600 WebP). */
export const THUMB_MAX_BYTES = 2 * 1024 * 1024;

export const THUMB_MIME: Record<ThumbType, string> = { webp: 'image/webp', png: 'image/png', jpeg: 'image/jpeg' };
const BY_MIME = new Map(Object.entries(THUMB_MIME).map(([t, m]) => [m, t as ThumbType]));

const unsupported = () => new HttpError(415, 'thumb_unsupported');
const tooLarge = () => new HttpError(413, 'thumb_too_large');

/** Format from the magic bytes; null for anything else (SVG, GIF, HTML…). Content is never decoded. */
export function sniffImage(head: Uint8Array): ThumbType | null {
  const b = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/**
 * Streams the raw image body into `tmpDir`: cut beyond THUMB_MAX_BYTES, never fully in memory.
 * The declared type (Content-Type) must be WebP/PNG/JPEG and match the magic bytes, otherwise 415.
 */
export function receiveThumb(req: Request, tmpDir: string): Promise<{ tmpPath: string; type: ThumbType }> {
  const declared = BY_MIME.get((req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase());
  if (!declared || !req.body) return Promise.reject(unsupported());
  if (Number(req.headers.get('content-length') ?? 0) > THUMB_MAX_BYTES) return Promise.reject(tooLarge());

  const tmpPath = join(tmpDir, `${newId()}.thumb`);
  const body = Readable.fromWeb(req.body as unknown as NodeReadableStream);
  const out = createWriteStream(tmpPath, { flags: 'wx' });
  return new Promise((resolve, reject) => {
    let size = 0;
    let head = Buffer.alloc(0);
    let settled = false;
    const fail = async (err: Error) => {
      if (settled) return;
      settled = true;
      body.removeListener('data', onData);
      discard(body);
      body.resume();
      if (!out.closed) {
        const closed = new Promise<void>((res) => out.once('close', () => res()));
        out.destroy();
        await closed;
      }
      await rm(tmpPath, { force: true }).catch(() => undefined);
      reject(err);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > THUMB_MAX_BYTES) return void fail(tooLarge());
      if (head.length < 12) {
        head = Buffer.concat([head, chunk.subarray(0, 12 - head.length)]);
        if (head.length >= 12 && sniffImage(head) !== declared) return void fail(unsupported());
      }
      if (!out.write(chunk)) {
        body.pause();
        out.once('drain', () => !settled && body.resume());
      }
    };
    body.on('data', onData);
    body.on('end', () => {
      if (settled) return;
      if (sniffImage(head) !== declared) return void fail(unsupported());
      out.end();
    });
    body.on('error', () => void fail(new HttpError(400, 'upload_interrupted')));
    out.on('error', (e) => void fail(e));
    out.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve({ tmpPath, type: declared });
    });
  });
}

/** Moves the received file to its final place (same volume: atomic rename, replaces an existing file of the same format). */
export async function placeThumb(dataDir: string, artifactId: string, versionId: string, tmpPath: string, type: ThumbType): Promise<string> {
  const dir = thumbsDir(dataDir, artifactId);
  await mkdir(dir, { recursive: true });
  await chmod(dir, DIR_MODE);
  // Mode set before the rename: the image is never visible in place with the temporary file's mode.
  await chmod(tmpPath, FILE_MODE);
  const dest = thumbPath(dataDir, artifactId, versionId, type);
  await rename(tmpPath, dest);
  return dest;
}

/** Serialises critical sections per key (a version) in this process: concurrent uploads apply one after the other. */
export function createKeyedLock() {
  const tails = new Map<string, Promise<void>>();
  return <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const run = (tails.get(key) ?? Promise.resolve()).then(fn);
    const tail = run.then(() => undefined, () => undefined);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
}
