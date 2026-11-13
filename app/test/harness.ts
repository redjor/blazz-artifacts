import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Config } from '../src/config.ts';
import { createContentApp } from '../src/content/server.ts';
import { deriveKeys, hashSecret } from '../src/crypto.ts';
import { openDb } from '../src/db.ts';
import { newId } from '../src/ids.ts';
import { codeLimiterOptions, RateLimiter } from '../src/ratelimit.ts';
import { insertArtifactWithVersion, type Kind, type Visibility } from '../src/repo.ts';
import { versionDir } from '../src/storage.ts';
import { tempDataDir, testConfig } from './helpers.ts';

export async function setup(over: Partial<Config> = {}) {
  const cfg = testConfig(await tempDataDir(), over);
  const db = openDb(':memory:');
  const keys = deriveKeys(cfg.hubSecret);
  let t = Date.now();
  const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
  const content = createContentApp({ db, cfg, keys, codeLimiter: new RateLimiter(codeLimiterOptions, clock.now), now: clock.now });
  return { cfg, db, keys, clock, content };
}

export type Harness = Awaited<ReturnType<typeof setup>>;

export async function seedArtifact(
  h: Harness,
  o: { slug: string; visibility: Visibility; files: Record<string, string | Buffer>; kind?: Kind; entry?: string; code?: string; memoryStorage?: boolean; project?: string; title?: string },
) {
  const id = newId();
  const versionId = newId();
  const dir = versionDir(h.cfg.dataDir, id, versionId);
  for (const [rel, data] of Object.entries(o.files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), data);
  }
  return insertArtifactWithVersion(
    h.db,
    { id, slug: o.slug, title: o.title ?? o.slug, kind: o.kind ?? 'site', visibility: o.visibility, code_hash: o.code ? await hashSecret(o.code) : null, memory_storage: o.memoryStorage ? 1 : 0, project: o.project ?? null },
    { id: versionId, entry_path: o.entry ?? 'index.html', original_name: 'x', size_bytes: 1, file_count: Object.keys(o.files).length },
  );
}

export function setCookies(res: Response): string {
  return res.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ');
}
