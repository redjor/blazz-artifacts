import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDb } from '../db.ts';
import { parseLocaleSetting, staticLocale } from '../i18n.ts';
import { renderSourcePage } from '../ingest/ingest.ts';
import { getVersion, listArtifacts } from '../repo.ts';
import { FILE_MODE, versionDir } from '../storage.ts';

// Re-renders the reader page of already published Markdown and JSON artifacts, after a template change
// or a HUB_LOCALE change. Usage: docker compose exec app node src/scripts/rerender-documents.ts
const dataDir = resolve(process.env.DATA_DIR || '/data');
const locale = staticLocale(parseLocaleSetting(process.env.HUB_LOCALE));
const db = openDb(join(dataDir, 'hub.sqlite'));
let done = 0;
let skipped = 0;
for (const art of listArtifacts(db)) {
  if ((art.kind !== 'markdown' && art.kind !== 'json') || !art.current_version_id) continue;
  const version = getVersion(db, art.current_version_id);
  if (!version) continue;
  const dir = versionDir(dataDir, art.id, version.id);
  const source = join(dir, art.kind === 'markdown' ? 'source.md' : 'source.json');
  if (!existsSync(source)) {
    skipped++;
    console.error(`skipped (missing source): ${art.slug}`);
    continue;
  }
  const page = renderSourcePage(art.kind, readFileSync(source, 'utf8'), art.title, locale);
  const target = join(dir, 'index.html');
  writeFileSync(`${target}.tmp`, page);
  chmodSync(`${target}.tmp`, FILE_MODE);
  renameSync(`${target}.tmp`, target);
  done++;
}
db.close();
console.log(`${done} page(s) re-rendered${skipped ? `, ${skipped} skipped` : ''}`);
