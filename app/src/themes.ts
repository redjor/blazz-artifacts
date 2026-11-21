import { isGoogleFont, type FontData } from './google-fonts.ts';
import { tx, type Db } from './db.ts';
import { HttpError } from './http.ts';
import { getProject } from './repo.ts';

export interface Theme {
  id: string; name: string; clientName: string; logoDataUrl: string;
  primaryColor: string; accentColor: string;
  fontData?: FontData;
  font: 'sans' | 'serif' | 'mono' | `google:${string}`; width: 'narrow' | 'standard' | 'wide';
  preset: 'documentation' | 'report' | 'editorial'; header: string; footer: string;
}
export function parseTheme(value: unknown, snapshot = false): Omit<Theme, 'id'> {
  const fail = (): never => { throw new HttpError(400, 'invalid_theme'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const o = value as Record<string, unknown>;
  const text = (key: string, max: number) => {
    const v = o[key];
    if (typeof v !== 'string' || v.length > max || /\0/.test(v)) return fail();
    return v;
  };
  const name = text('name', 120).trim();
  if (!name) return fail();
  const clientName = text('clientName', 120), header = text('header', 1000), footer = text('footer', 1000);
  const primaryColor = text('primaryColor', 7), accentColor = text('accentColor', 7);
  if (![primaryColor, accentColor].every(c => /^#[0-9a-f]{6}$/i.test(c))) return fail();
  const logoDataUrl = text('logoDataUrl', 700000);
  if (logoDataUrl) {
    const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(logoDataUrl);
    if (!m) return fail();
    const b = Buffer.from(m[2], 'base64');
    if (b.length > 512 * 1024 || b.toString('base64') !== m[2]) return fail();
    const valid = m[1] === 'png' ? b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : m[1] === 'jpeg' ? b[0] === 255 && b[1] === 216 && b[2] === 255 : b.toString('ascii',0,4) === 'RIFF' && b.toString('ascii',8,12) === 'WEBP';
    if (!valid) return fail();
  }
  if (typeof o.font !== 'string' || typeof o.width !== 'string' || typeof o.preset !== 'string' || (!['sans','serif','mono'].includes(o.font) && !isGoogleFont(o.font) && !(snapshot && /^google:[^\x00-\x1f]{1,200}$/.test(o.font))) || !['narrow','standard','wide'].includes(String(o.width)) || !['documentation','report','editorial'].includes(String(o.preset))) return fail();
  return { name, clientName, logoDataUrl, primaryColor, accentColor, header, footer, font: o.font as Theme['font'], width: o.width as Theme['width'], preset: o.preset as Theme['preset'] };
}
export function getTheme(db: Db, id: string): Theme | null {
  const row = db.prepare('SELECT data FROM themes WHERE id = ?').get(id) as {data: string} | undefined;
  return row ? JSON.parse(row.data) as Theme : null;
}
export function listThemes(db: Db): Theme[] {
  return db.prepare('SELECT data FROM themes ORDER BY rowid').all().map(r => JSON.parse(r.data as string) as Theme);
}
export function saveTheme(db: Db, theme: Theme): Theme {
  db.prepare('INSERT INTO themes(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(theme.id,JSON.stringify(theme));
  return theme;
}
export function deleteTheme(db: Db, id: string): void {
  if (!getTheme(db,id)) throw new HttpError(404,'theme_not_found');
  tx(db, () => { db.prepare('DELETE FROM themes WHERE id = ?').run(id); });
}
export function parseThemeId(db: Db, value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !getTheme(db,value)) throw new HttpError(400,'theme_not_found');
  return value;
}
export function resolveTheme(db: Db, themeId: string | null, project: string | null): Theme | null {
  if (themeId) return getTheme(db, themeId);
  const seen = new Set<string>();
  while (project && !seen.has(project)) {
    seen.add(project);
    const p = getProject(db, project);
    if (!p) break;
    if (p.theme_id) return getTheme(db,p.theme_id);
    project = p.parent_name;
  }
  return null;
}

/** Editor DTO excludes server-owned font bytes. */
export function themeDto({ fontData: _fontData, ...theme }: Theme): Omit<Theme, 'fontData'> { return theme; }
