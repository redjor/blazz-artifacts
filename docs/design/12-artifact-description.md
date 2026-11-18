# 12 — Artifact description

## Goal

Folders have a description; artifacts only have a title. A visitor scanning a folder page of ten mockups, or a link
pasted in Slack, gets the title and at best an excerpt of the page, which for a mockup is often a button label.

## Decisions

- **One optional plain-text field**, `description`, 1000 characters at most, trimmed, blank clears it: the same rules
  as a folder description (same error codes). No Markdown, no links: it is rendered as text everywhere.
- **Where it is set**: the artifact panel (Details, under the title), the API (`POST /artifacts` multipart field,
  `PATCH /artifacts/:id`) and the CLI (`--description`, which now applies to artifacts as well as `--create-folder`).
  Changing it is a modification (`updated_at`) but never touches the access epoch.
- **Where it shows**: on folder pages under the card title (three lines at most); in link previews, instead of the
  excerpt (the excerpt stays the fallback); in the gallery search, as its own weighted column of the index.
- **Migration**: a nullable column on `artifacts`, added before the `live_artifacts` view is read. An FTS5 table cannot
  gain a column, so a search index without `description` is dropped and recreated empty; the startup pass that indexes
  artifacts without a row fills it again.

## Out of scope

Descriptions per version, rich text, showing the description inside the visitor bar.
