# Development

## Layout

```
app/
  src/            server (Node runs the TypeScript directly)
    admin/        admin Hono app: auth, API, SPA serving, preview cache
    content/      content Hono app: pages, grants, signing, folder pages, storage shim
    ingest/       upload ingestion: detection, ZIP extraction, Markdown/JSON readers
    scripts/      hash-password, new-api-token, backup-db, rerender-documents
    errors.ts     API error codes   i18n.ts  visitor page copy
  web/src/        React admin SPA (i18n/ holds the en and fr dictionaries)
  test/           node:test suites (server, i18n dictionaries)
  dev/            local runner (run.ts, which watches api.ts) and demo seed files
cli/publish-artifact/   Python publish CLI, Claude Code skill, unit tests
deploy/                 compose files, Tailscale serve configs, Caddy example, .env.example
scripts/                backup.sh, check-compose.sh
```

## Running locally

```bash
cd app
npm ci
npm run dev                 # API :13000, content :13001, Vite admin UI :5173, demo data in .dev-data/
npm run dev -- --reset      # start from an empty database (demo data re-created)
npm run dev -- --no-web     # serve the built UI (npm run build:web) from the API
HUB_LOCALE=fr npm run dev   # French visitor pages
```

Sign in with `blazz-artifacts-dev` (or `DEV_PASSWORD`). The API token printed at startup works with the CLI:
`ARTIFACT_HUB_URL=http://localhost:5173 ARTIFACT_HUB_TOKEN=… python3 ../cli/publish-artifact/publish.py file.md`.
Session cookies are `Secure`: Chrome and Firefox accept them on `localhost`, Safari does not. Changes in `web/src`
hot-reload; changes in `src/` restart the API and content servers (`node --watch`), Vite stays up and the API token
stays the same.

## Checks

```bash
npm run typecheck          # project TypeScript (tsc 7), covers server, tests and SPA
npm test                   # node --test, sequential
npm run build:web
python3 -m unittest discover -s ../cli/publish-artifact
../scripts/check-compose.sh
```

CI runs the same on Node 22 and 24. The Dockerfile runs typecheck, tests and the SPA build before producing the image.

## Adding UI copy

1. Add the key to `web/src/i18n/en.ts` and the same key to `fr.ts` (TypeScript rejects missing or extra keys).
2. Use `t('key', { param })` or `tn('pluralBase', n)` (needs `pluralBase.one` and `pluralBase.other`).
3. Format dates and numbers with the helpers in `web/src/format.ts` (they follow the active locale).

Visitor page copy goes to `src/i18n.ts` (both locales). New API errors: add a code to `src/errors.ts`, throw
`new HttpError(status, 'code', params?)`, and add `error.<code>` to both SPA dictionaries (a test enforces it).
