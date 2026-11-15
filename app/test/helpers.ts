import { crc32, deflateRawSync } from 'node:zlib';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.ts';

export async function tempDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ahub-'));
  for (const sub of ['files', 'tmp', 'backup']) await mkdir(join(dir, sub), { recursive: true });
  return dir;
}

export function testConfig(dataDir: string, over: Partial<Config> = {}): Config {
  return {
    dataDir,
    hubSecret: Buffer.alloc(32, 7),
    adminPasswordHash: '',
    apiTokenHash: '',
    publicHubUrl: 'https://hub.test',
    publicContentUrl: 'https://artifacts.test',
    maxUploadBytes: 1024 * 1024,
    zipMaxFiles: 50,
    zipMaxBytes: 5 * 1024 * 1024,
    adminBind: '127.0.0.1',
    contentBind: '127.0.0.1',
    locale: 'en',
    // Existing tests expect DELETE to remove for good; the trash tests set it.
    trashDays: 0,
    // Existing tests expect the usual redirect for every bot; the link preview tests set it.
    linkPreviews: false,
    ...over,
  };
}


export interface ZipSpec { name: string; data?: Buffer | string; mode?: number; store?: boolean }

export function makeZip(entries: ZipSpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '');
    const method = e.store ? 0 : 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    const mode = e.mode ?? (e.name.endsWith('/') ? 0o040755 : 0o100644);
    central.writeUInt32LE(((mode & 0xffff) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
