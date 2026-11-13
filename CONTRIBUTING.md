# Contributing

Thanks for your interest. Issues and pull requests are welcome; for larger changes, open an issue first so we
can agree on the approach.

## Setup

- Node 22.18+ (CI runs 22 and 24; the Docker image pins Node 24), Python 3.10+ for the publish CLI.
- `cd app && npm ci && npm run dev`: API on 13000, content on 13001, admin UI with hot reload on
  http://localhost:5173 (password `blazz-artifacts-dev`), demo data in `app/.dev-data/`.
  `npm run dev -- --reset` starts from scratch. Session cookies are `Secure`: use Chrome or Firefox locally.

## Before opening a pull request

```bash
cd app
npm run typecheck      # the project's tsc, never a global one
npm test               # node:test, server and i18n dictionaries
npm run build:web
python3 -m unittest discover -s ../cli/publish-artifact
../scripts/check-compose.sh   # when you touch deploy/
```

- **Server changes are test-first**: add a failing `node:test` case, then the fix. Never weaken an existing
  assertion, especially security ones (headers, status codes, access checks).
- **Schema changes** need idempotent in-place migrations in `src/db.ts` (one transaction), with a test.
- **UI copy**: every user-facing string goes through `web/src/i18n/en.ts` and `fr.ts` (same keys, same
  placeholders; `test/i18n-web.test.ts` checks it). Visitor page copy lives in `src/i18n.ts`.
- **Admin CSP**: no inline styles or scripts, no React `style` props, no remote assets.
- API errors: throw `HttpError(status, code)` with a code from `src/errors.ts`, and add its message to both SPA dictionaries.

## Style

- TypeScript run directly by Node (type stripping): only erasable syntax (no enums, no parameter properties).
- Two-space indentation, single quotes, semicolons; keep functions small and comments about *why*.
- Commits: short imperative subject with a scope, e.g. `feat(folders): …`, `fix(content): …`, `docs: …`.
