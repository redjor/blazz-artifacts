# Publishing integrations Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans task by task.

**Goal:** Deliver all five authorized additions.
**Architecture:** Working and published version pointers; scoped API credentials; MCP adapter to authenticated API; JSX ingest; public embed route and local QR generation.
**Tech Stack:** Existing Node TypeScript, Hono, SQLite and React.
**Spec:** docs/superpowers/specs/2026-11-22-publishing-integrations-design.md

## Global Constraints
Preserve existing links and authorization; no draft leakage; hash credentials; bilingual controls; no execution of uploads on the server.

## Review Focus
Drafts through folders and OG; old signed preview links; publish scopes reaching bulk/access routes; JSX escaping and CDN dependency failures; embed visibility changes.

## Task 1: Publication workflow
Files: app/src/db.ts, repo.ts, admin/api.ts, content/server.ts, content/signing.ts, content/og.ts, app/web/src/ArtifactPanel.tsx, types.ts, api.ts, i18n files, CLI.
- [x] Test publication migration, draft updates, explicit approval, folders and signatures.
- [x] Add published_version_id, publish endpoint and DTO status; preserve admin preview through pinned signatures.
- [x] Add publish controls and CLI flag; adapt intentional publication fixtures.
- [x] Run publication and existing access tests.

## Task 2: API keys and MCP
Files: new API-key module/routes, admin/auth.ts, admin/server.ts, new MCP adapter, new key settings UI; tests and docs.
- [x] Test scopes, expiry, revocation, legacy token compatibility, MCP initialize/list/call authorization.
- [x] Implement named keys with session-only management; add scoped middleware.
- [x] Implement MCP using the existing API and add setup/key management UI.
- [x] Run focused tests and typecheck.

## Task 3: React uploads
Files: ingest/jsx.ts, ingest/ingest.ts, upload validation, kind types/UI/CLI; tests and docs.
- [x] Test JSX and TSX transform, default export, invalid syntax, escaping.
- [x] Add component renderer and upload support; keep sandbox and document network dependencies.
- [x] Run ingest and content tests.

## Task 4: QR and embedding
Files: sharing helper/routes, content embed route, SharePopover UI; tests and docs.
- [x] Test QR formats, missing/expired sharing URLs, published public-only embeds.
- [x] Generate locally; expose share menu controls and iframe snippet.
- [x] Run sharing and content tests.

## Task 5: Integration
- [x] Full Node and CLI suites, typecheck, build, UI inspection.
- [x] Fresh review and fixes; document behavior and limits.

## Completion evidence
- Node suite: 399 passed; Python CLI suite: 90 passed.
- Typecheck and production web build passed.
- Browser: created/revoked temporary API key; authenticated MCP initialize through Vite verified; TSX counter interactive in preview and cross-origin iframe; explicit publication and local QR image observed.
- Fresh review: dev MCP proxy and maintenance rerender findings fixed, re-review clean.
- Implementation choice: JSX/TSX remain HTML-kind artifacts, storing original source and compiled module, so existing storage schema and viewer controls stay compatible.
- Low-level repository seed helpers retain immediate activation by default for existing fixtures; all upload API paths explicitly create drafts.
- Titles/descriptions/access remain artifact-wide; only version file content is held for approval.
