import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';

const base = {
  HUB_SECRET: Buffer.alloc(48, 1).toString('base64'),
  PUBLIC_HUB_URL: 'https://hub.example.com/',
  PUBLIC_CONTENT_URL: 'https://artifacts.example.com',
};

test('loadConfig applique les valeurs par défaut', () => {
  const cfg = loadConfig(base);
  assert.equal(cfg.publicHubUrl, 'https://hub.example.com');
  assert.equal(cfg.maxUploadBytes, 100 * 1024 * 1024);
  assert.equal(cfg.zipMaxFiles, 2000);
  assert.equal(cfg.zipMaxBytes, 209715200);
  assert.equal(cfg.dataDir, '/data');
  assert.equal(cfg.adminPasswordHash, '');
});

test('loadConfig refuse un secret trop court', () => {
  assert.throws(() => loadConfig({ ...base, HUB_SECRET: Buffer.alloc(16).toString('base64') }), /32 bytes/);
});

test('loadConfig refuse une URL publique en http hors localhost', () => {
  assert.throws(() => loadConfig({ ...base, PUBLIC_HUB_URL: 'http://hub.example.com' }), /https/);
});

test('loadConfig accepte http://localhost pour le développement', () => {
  assert.equal(loadConfig({ ...base, PUBLIC_HUB_URL: 'http://localhost:5173' }).publicHubUrl, 'http://localhost:5173');
});

test('loadConfig refuse un hash admin au mauvais format', () => {
  assert.throws(() => loadConfig({ ...base, ADMIN_PASSWORD_HASH: '$2b$10$abc' }), /scrypt:/);
});

test('loadConfig : API_TOKEN_HASH vide par défaut, validé quand présent', () => {
  assert.equal(loadConfig(base).apiTokenHash, '');
  assert.equal(loadConfig({ ...base, API_TOKEN_HASH: 'a'.repeat(64) }).apiTokenHash, 'a'.repeat(64));
  assert.throws(() => loadConfig({ ...base, API_TOKEN_HASH: 'xyz' }), /API_TOKEN_HASH must be a hexadecimal SHA-256/);
});
