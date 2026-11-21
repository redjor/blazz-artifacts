# Client Markdown Themes Implementation Plan

**Goal:** Reusable client-branded Markdown themes with frozen version rendering.
**Architecture:** SQLite themes and assignments, structured renderer configuration and immutable version snapshots; existing React panels expose management and preview/apply.
**Tech stack:** Existing TypeScript, Hono, SQLite, React and Tailwind.
**Spec:** docs/superpowers/specs/2026-11-21-client-themes-design.md

## Global constraints
- Keep old versions unchanged when editing themes or assignments.
- Use validated structured fields, no arbitrary CSS or remote font/logo fetching.
- Keep existing access controls and JSON rendering intact.
- English and French UI; use existing UI conventions.

## Review focus
Invalid CSS/HTML values; inherited folder cycles; missing or deleted themes; concurrent apply/upload; rerender script snapshot preservation.

## Tasks
- [x] Backend: migrations, theme CRUD/assignment API, validated rendering, upload snapshots, preview/apply new version, rerender compatibility; integration tests.
- [x] UI: reusable theme editor/selector with presets, logo input, live preview; folder/document panels with explicit apply.
- [x] Review and verification: tests, typecheck, build and usage docs.

Ruling: implementation follows the already approved conversation; no additional design approval requested. Existing publish-on-upload semantics retained; theme application is an explicit new version.

## Verification
- Full suite: 379/379 passed.
- Final input-validation refinement: theme suite 8/8 passed; TypeScript passed.
- Production build passed (existing bundle-size advisory).
- React Doctor found no reported issues in changed tracked files.
- Independent static review approved snapshot binding, custom title consistency, sandboxed preview fonts and atomic application.
- Browser visual verification unavailable: computer-use browser host unavailable.
