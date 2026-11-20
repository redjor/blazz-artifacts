import { resolve } from 'node:path';
import { parseLocaleSetting, type LocaleSetting } from './i18n.ts';

export interface Config {
  dataDir: string;
  hubSecret: Buffer;
  adminPasswordHash: string;
  apiTokenHash: string;
  publicHubUrl: string;
  /** Other origins of the same admin (PUBLIC_HUB_ALT_URLS, comma-separated): trusted for mutations and framing. */
  hubAltUrls: string[];
  publicContentUrl: string;
  maxUploadBytes: number;
  zipMaxFiles: number;
  zipMaxBytes: number;
  adminBind: string;
  contentBind: string;
  /** Language of visitor pages (HUB_LOCALE): en (default), fr, or auto (Accept-Language). */
  locale: LocaleSetting;
  /** Days a deleted artifact stays in the trash before it is purged (TRASH_DAYS, 30); 0: deleted at once, no trash. */
  trashDays: number;
  /** Open Graph page for link-preview services (LINK_PREVIEWS, on by default; 0 turns it off). Design 06. */
  linkPreviews: boolean;
  /** Visitor bar above artifacts, through a frame page (ARTIFACT_BAR, on by default; 0 turns it off). Design 10. */
  artifactBar: boolean;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing variable ${name}`);
  return value;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

function boundedInt(env: NodeJS.ProcessEnv, name: string, fallback: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new Error(`${name} must be an integer between 0 and ${max}`);
  return n;
}

function flag(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  throw new Error(`${name} must be 0 or 1`);
}

function publicOrigin(env: NodeJS.ProcessEnv, name: string, raw: string = required(env, name)): string {
  const url = new URL(raw);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error(`${name} must be an https URL`);
  }
  return url.origin;
}

function altHubOrigins(env: NodeJS.ProcessEnv): string[] {
  const content = publicOrigin(env, 'PUBLIC_CONTENT_URL');
  const list = (env.PUBLIC_HUB_ALT_URLS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.map((raw) => {
    const origin = publicOrigin(env, 'PUBLIC_HUB_ALT_URLS', raw);
    // The content origin serves untrusted pages: it must never be trusted as an admin origin.
    if (origin === content) throw new Error('PUBLIC_HUB_ALT_URLS must not contain PUBLIC_CONTENT_URL');
    return origin;
  });
}

/** Every origin of the admin, primary first. */
export const hubOrigins = (cfg: Pick<Config, 'publicHubUrl' | 'hubAltUrls'>): string[] => [cfg.publicHubUrl, ...cfg.hubAltUrls];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const hubSecret = Buffer.from(required(env, 'HUB_SECRET'), 'base64');
  if (hubSecret.length < 32) {
    throw new Error('HUB_SECRET must contain at least 32 bytes (openssl rand -base64 48)');
  }
  const adminPasswordHash = env.ADMIN_PASSWORD_HASH ?? '';
  if (adminPasswordHash && !adminPasswordHash.startsWith('scrypt:')) {
    throw new Error('ADMIN_PASSWORD_HASH must start with scrypt: (src/scripts/hash-password.ts)');
  }
  const apiTokenHash = env.API_TOKEN_HASH ?? '';
  if (apiTokenHash && !/^[0-9a-f]{64}$/.test(apiTokenHash)) {
    throw new Error('API_TOKEN_HASH must be a hexadecimal SHA-256 (src/scripts/new-api-token.ts)');
  }
  return {
    dataDir: resolve(env.DATA_DIR || '/data'),
    hubSecret,
    adminPasswordHash,
    apiTokenHash,
    publicHubUrl: publicOrigin(env, 'PUBLIC_HUB_URL'),
    hubAltUrls: altHubOrigins(env),
    publicContentUrl: publicOrigin(env, 'PUBLIC_CONTENT_URL'),
    maxUploadBytes: positiveInt(env, 'MAX_UPLOAD_MB', 100) * 1024 * 1024,
    zipMaxFiles: positiveInt(env, 'ZIP_MAX_FILES', 2000),
    zipMaxBytes: positiveInt(env, 'ZIP_MAX_BYTES', 209715200),
    adminBind: env.ADMIN_BIND || '127.0.0.1',
    contentBind: env.CONTENT_BIND || '127.0.0.1',
    locale: parseLocaleSetting(env.HUB_LOCALE),
    trashDays: boundedInt(env, 'TRASH_DAYS', 30, 3650),
    linkPreviews: flag(env, 'LINK_PREVIEWS', true),
    artifactBar: flag(env, 'ARTIFACT_BAR', true),
  };
}
