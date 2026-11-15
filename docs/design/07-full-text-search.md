# 07 — Full-text search

## Goal

The gallery search only looks at titles, slugs and tags. A hub that holds reports, notes and mockups is searched for
what is inside them ("the deck that mentioned the Q3 churn"). Full-text search finds artifacts by their content,
keeps the current instant search, and shows where the words matched.

## Decisions

- **SQLite FTS5, in the same database.** No extra service or dependency: `node:sqlite` ships FTS5. One row per artifact
  (title, slug, tags, text of the current version), tokenizer `unicode61 remove_diacritics 2`, so accents and case do
  not matter ("donnee" finds "données", "ecran" finds "Écran").
- **What is indexed, per kind** (current version only):
  - Markdown: the text of `source.md` without its syntax (heading, quote, list and table markers, emphasis, link
    targets); JSON: the source text (`source.json`).
  - HTML page: the visible text of the page (scripts, styles, comments and tags removed, entities decoded).
  - ZIP site: the same for every HTML page of the site, up to 200 pages.
  - PDF: nothing beyond title, slug and tags (no PDF text extraction without a dependency; out of scope).
  - At most 200,000 characters of text per artifact; the rest is not searchable.
- **Kept up to date by the API.** Publishing, a new version or a restored version re-reads the text; a title, slug or
  tag change (single or bulk) updates those fields only. Deleting for good removes the row. Trashed artifacts keep
  their row (a restore needs no re-indexing) but never appear in results. Existing artifacts are indexed once at
  startup.
- **Search as you type, words as prefixes.** Every word of the query must match, each as a prefix ("tri" finds
  "trimestre"); quotes and operators are treated as plain text, there is no search syntax to learn.
- **The gallery stays instant.** The current filter on title, slug and tags still runs on every keystroke; content
  matches from the server join it after a short pause (200 ms, from 2 characters). Folder, filters and sort apply as
  today; the order does not change while searching.
- **Where it matched.** A card found through its content shows one line of context with the matched words highlighted
  ("…the Q3 **churn** rose to…"). The snippet is plain text with highlight ranges, never HTML.
- **Admin only.** Visitor pages get no search.

## Admin

### API

`GET /search?q=` answers `{ results: [{ id, snippet }] }`: live artifacts whose title, slug, tags or text match, at
most 200, best matches first (title weighs more than tags, tags more than text). `snippet` is null unless the text
matched, else a list of `{ text, hit }` segments around the match. An empty or one-character query answers no
results.

### Dashboard

- Search field placeholder: "Title, tag or content".
- The result count announced to screen readers includes the content matches.
- If the search request fails, the gallery keeps its instant results; nothing else changes.

## Data

- `search_index`: FTS5 virtual table (`artifact_id UNINDEXED, title, slug, tags, body`). Created in place like the
  previous migrations; filled at startup for artifacts without a row.
- Text extraction lives in `src/search.ts`; the HTML and Markdown text helpers (`htmlText`, `markdownText`) live in
  `src/preview.ts`, next to the card excerpt they share their stripping with.

## Tests

- Search by content per kind (Markdown, JSON, HTML page, every page of a ZIP site), by title, slug and tag; accents and
  case ignored; prefixes; every word required; quotes and FTS operators harmless.
- Updates: new version, restored version, title and tag changes (single and bulk), deletion for good; trashed
  artifacts hidden, restored ones found again; startup indexing of existing artifacts.
- Snippet: highlight segments only for text matches; length bounded.

## Out of scope

PDF text, old versions, search syntax (OR, exclusion, exact phrase), search on visitor pages, folder descriptions,
relevance ordering in the gallery.
