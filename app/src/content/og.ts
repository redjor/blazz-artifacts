// Link previews (design 06): the Open Graph page served to link-preview services instead of the usual redirect,
// and the short signed URL of its image. Script-free, served under the visitor pages' sandbox CSP.
import { hmac, safeEqual } from '../crypto.ts';
import { escapeHtml } from '../ingest/page.ts';
import type { Locale } from '../i18n.ts';
import type { Artifact } from '../repo.ts';

/** Preview services fetch the image right after the page; a day covers late fetches and retries. */
export const OG_IMAGE_TTL_S = 86_400;
const DESCRIPTION_MAX = 280;

interface ImageFields { artifactId: string; versionId: string; epoch: number }

// `og|` prefix: never equal to another signed payload, even under a key mix-up.
const payload = (f: ImageFields, exp: number) => `og|${f.artifactId}|${f.versionId}|${f.epoch}|${exp}`;

/** `<exp>.<mac>`, bound to the artifact, its version and its access epoch. */
export function signOgImage(key: Buffer, f: ImageFields, nowS: number, ttlS = OG_IMAGE_TTL_S): string {
  const exp = nowS + ttlS;
  return `${exp}.${hmac(key, payload(f, exp))}`;
}

/** Valid only for the artifact's current version and epoch, before expiry. */
export function checkOgImage(
  key: Buffer, art: Pick<Artifact, 'id' | 'current_version_id' | 'access_epoch'>, versionId: string, sig: string | undefined, nowS: number,
): boolean {
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(sig ?? '');
  if (!m || versionId !== art.current_version_id) return false;
  const exp = Number(m[1]);
  if (exp <= nowS) return false;
  return safeEqual(m[2], hmac(key, payload({ artifactId: art.id, versionId, epoch: art.access_epoch }, exp)));
}

const clip = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

export interface OgCard {
  title: string; description: string;
  /** Absolute URL of the requested page. */
  url: string;
  /** Absolute signed image URL, or null without a thumbnail. */
  image: string | null;
}

export function renderOgPage(card: OgCard, locale: Locale): string {
  const title = escapeHtml(clip(card.title, 200));
  const description = escapeHtml(clip(card.description, DESCRIPTION_MAX));
  const url = escapeHtml(card.url);
  const image = card.image
    ? `<meta property="og:image" content="${escapeHtml(card.image)}">\n<meta property="og:image:alt" content="${title}">\n`
    : '';
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<title>${title}</title>
<meta name="description" content="${description}">
<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${url}">
${image}<meta name="twitter:card" content="${card.image ? 'summary_large_image' : 'summary'}">
</head>
<body><main><h1>${title}</h1><p>${description}</p><p><a href="${url}">${url}</a></p></main></body>
</html>
`;
}
