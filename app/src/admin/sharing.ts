import { Hono } from 'hono';
import QRCode from 'qrcode';
import type { AdminEnv } from './auth.ts';
import type { Db } from '../db.ts';
import type { Config } from '../config.ts';
import { decrypt, type Keys } from '../crypto.ts';
import { getArtifact, listLinks } from '../repo.ts';
import { escapeHtml } from '../ingest/page.ts';
import { HttpError } from '../http.ts';

export function sharingRoutes(db: Db, cfg: Config, keys: Keys, now: () => number): Hono<AdminEnv> {
 const app = new Hono<AdminEnv>();
 const sharing = (id: string) => {
   const art = getArtifact(db,id);
   if (!art) throw new HttpError(404,'artifact_not_found');
   if (!art.published_version_id) throw new HttpError(409,'no_content');
   let url: string | null = art.visibility === 'public' || art.visibility === 'code' ? `${cfg.publicContentUrl}/a/${art.slug}` : null;
   if (art.visibility === 'link') {
     for (const link of listLinks(db,id)) {
       if (link.revoked_at || (link.expires_at && Date.parse(link.expires_at) <= now())) continue;
       try { url = `${cfg.publicContentUrl}/share/${decrypt(keys.linkEnc,link.token_enc)}`; break; } catch { /* rotated encryption key */ }
     }
   }
   if (!url) throw new HttpError(409,'link_not_found');
   const embedCode = art.visibility === 'public' ? `<iframe src="${escapeHtml(cfg.publicContentUrl)}/embed/${art.slug}/" title="${escapeHtml(art.title)}" width="100%" height="600" style="border:0" loading="lazy" allowfullscreen></iframe>` : null;
   return {url,embedCode,slug:art.slug};
 };
 app.get('/artifacts/:id/sharing', c => c.json(sharing(c.req.param('id'))));
 app.get('/artifacts/:id/qr', async c => {
   const {url,slug} = sharing(c.req.param('id'));
   const format = c.req.query('format') ?? 'svg';
   if (format !== 'svg' && format !== 'png') throw new HttpError(400,'unsupported_format');
   const headers: Record<string,string> = {'Content-Type':format === 'svg' ? 'image/svg+xml' : 'image/png','Cache-Control':'private, no-store'};
   if (c.req.query('download') === '1') headers['Content-Disposition'] = `attachment; filename="${slug}-qr.${format}"`;
   if (format === 'svg') return c.body(await QRCode.toString(url,{type:'svg',margin:4,errorCorrectionLevel:'M'}),200,headers);
   return c.body(new Uint8Array(await QRCode.toBuffer(url,{type:'png',width:512,margin:4,errorCorrectionLevel:'M'})),200,headers);
 });
 return app;
}
