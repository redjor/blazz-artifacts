# Publishing and integrations

User authorized all five additions on 2026-11-22.

## Intent
Publish client deliverables through stable links, approve updates deliberately, and allow agents to publish React components securely.

## Decisions
- Preserve existing current_version_id as the working version; add published_version_id. Migrate existing artifacts to their current version. New uploads and theme applications create working versions; explicit publication moves the visitor pointer. A new artifact has no public version until publication. Admin previews may view drafts through pinned signatures; public folders, exports, previews and embeds use published content only. Historical versions remain available to the administrator. Restoring is preparation, publishing is explicit.
- Add named API keys with read, publish and full scopes, optional expiry and independent revocation; store hashes only and show raw keys once. Keep the existing configured token compatible. Key management requires an administrator session; keys never mint more keys. Read cannot mutate; publish may create/update drafts and explicitly publish, but cannot change access, delete or administer keys.
- MCP HTTP endpoint on the admin server uses the same API authorization and publishing operations. Provide list/get/create/update/publish tools and setup documentation.
- JSX/TSX single components become a supported upload format with a default export. Transform locally; React, ReactDOM and additional packages resolve in the viewer through documented CDN dependencies. Never execute uploaded code on the server. Keep opaque-origin sandboxing.
- Generate downloadable QR SVG/PNG locally for the reachable sharing URL. Offer iframe HTML for public, published artifacts only. Dedicated embed entry checks publication and visibility on every load, with no exposure of admin previews or private grants.
- User-facing controls are French and English and follow current components.

## Alternatives
Automatic update would retain existing simplicity but defeat deliberate validation. A separate published pointer preserves stable links and drafts. For React, a full project build service is excessive; single-component transformation fits existing artifacts. Reuse current API handlers for MCP rather than duplicating permissions.

## Validation
Integration tests cover legacy migration, drafts absent from public and folder routes, publication and rollback, scoped key enforcement/expiry/revocation, MCP protocol and authorization, JSX transformation and invalid inputs, QR output and public-only embedding. Run full Node suite, Python CLI suite, typecheck, web build and inspect UI.
