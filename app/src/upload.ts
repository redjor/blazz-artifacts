import busboy from 'busboy';
import { createWriteStream, type WriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { HttpError } from './http.ts';
import { newId } from './ids.ts';
import type { UploadedFile } from './ingest/ingest.ts';

// Cancelling a web stream still fed by undici (Node 24) right away throws an
// uncatchable error: drain the body first, then destroy it beyond `cap`
// bytes (guarded destroy, errors ignored).
export function discard(body: Readable, cap = 1048576) {
  let seen = 0;
  body.on('error', () => undefined);
  body.on('data', (chunk: Buffer) => {
    seen += chunk.length;
    if (seen <= cap) return;
    try {
      body.destroy();
    } catch {
      // stream already closed
    }
  });
}

// Straight to disk: never the whole body in memory (mem_limit 256m).
export function receiveUpload(req: Request, tmpDir: string, maxBytes: number) {
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.startsWith('multipart/form-data') || !req.body) {
    return Promise.reject(new HttpError(400, 'multipart_expected'));
  }
  const tooLarge = () => new HttpError(413, 'file_too_large', { max: Math.floor(maxBytes / 1048576) || 1 });
  if (Number(req.headers.get('content-length') ?? 0) > maxBytes + 64 * 1024) return Promise.reject(tooLarge());

  const invalid = () => new HttpError(400, 'multipart_invalid');

  return new Promise<{ fields: Record<string, string>; file: UploadedFile | null }>((resolve, reject) => {
    const fields: Record<string, string> = {};
    const body = Readable.fromWeb(req.body as unknown as NodeReadableStream);
    let bb: busboy.Busboy;
    try {
      bb = busboy({ headers: { 'content-type': contentType }, defParamCharset: 'utf8', limits: { files: 1, fields: 10, fieldSize: 4096, fileSize: maxBytes } });
    } catch {
      body.destroy();
      reject(invalid());
      return;
    }
    let out: WriteStream | null = null;
    let tmpPath: string | null = null;
    let originalName = 'upload';
    let size = 0;
    let written: Promise<void> | null = null;
    let settled = false;

    const fail = async (err: Error) => {
      if (settled) return;
      settled = true;
      body.unpipe(bb);
      discard(body);
      if (out && !out.closed) {
        const closed = new Promise<void>((res) => out!.once('close', () => res()));
        out.destroy();
        await closed;
      }
      if (tmpPath) await rm(tmpPath, { force: true }).catch(() => undefined);
      reject(err);
    };

    bb.on('field', (name, value) => {
      fields[name] = value;
    });
    bb.on('file', (_field, stream, info) => {
      originalName = (info.filename || 'upload').split(/[\\/]/).pop()!.slice(0, 200) || 'upload';
      tmpPath = join(tmpDir, `${newId()}.upload`);
      out = createWriteStream(tmpPath, { flags: 'wx' });
      const target = out;
      written = new Promise<void>((res, rej) => {
        target.on('finish', res);
        target.on('error', (e) => {
          rej(e);
          void fail(e);
        });
        stream.on('error', () => {
          const e = invalid();
          rej(e);
          void fail(e);
        });
      });
      written.catch(() => undefined);
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
      });
      stream.on('limit', () => void fail(tooLarge()));
      stream.pipe(target);
    });
    bb.on('error', () => void fail(invalid()));
    bb.on('close', async () => {
      if (settled) return;
      try {
        if (written) await written;
      } catch (e) {
        return fail(e as Error);
      }
      if (settled) return;
      settled = true;
      resolve({ fields, file: tmpPath ? { tmpPath, originalName, size } : null });
    });
    body.on('error', (e) => void fail(e));
    body.pipe(bb);
  });
}
