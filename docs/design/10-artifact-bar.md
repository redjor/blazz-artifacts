# 10 — Artifact bar

## Goal

A visitor who opens an artifact sees the raw page and nothing else: no title, no way back to the folder they came
from, no way to get the original file. Every artifact (HTML page, ZIP site, PDF, Markdown, JSON) gets a slim bar at
the top: where it sits, what it is, and what can be done with it. Folder pages get the same bar.

## Decisions

- **A frame page, for people only.** A browser navigation (`Sec-Fetch-Dest: document`) to an artifact's entry URL
  (`/a/<slug>`, `/d/<folder>/a/<slug>`) gets a script-free page: the bar, then the artifact in an `<iframe>` whose
  `src` is the usual signed path. Everything else keeps today's redirect: `curl` and scripts (no fetch metadata), link
  previews (design 06), assets and inner pages, an explicit file (`/a/<slug>/index.html`), and requests made by the
  frame itself. Access checks, visit counting (the frame request counts once, the iframe never) and share links are
  unchanged.
- **Framing allowed by the content origin only.** Signed-path responses change from `frame-ancestors 'none'` /
  `X-Frame-Options: DENY` to `'self'` / `SAMEORIGIN`; every other response keeps `DENY`. The frame page itself is
  not sandboxed (a sandboxed page has an opaque origin and could not frame the content origin) but allows nothing
  active: `default-src 'none'`, inline styles, `frame-src 'self'`, no script, no form. An artifact (opaque origin)
  still cannot frame another one.
- **What the bar shows**:
  - left: the folder path when the artifact was opened through a folder (from the granting folder down, as on folder
    pages: no ancestor above leaks), then the title and the version (`v3`);
  - right: **Original** (download) for Markdown, JSON and PDF; **Open alone**, the signed path at the top level
    (full screen, printable, valid for an hour like any signed path).
- **Theme**: the bar follows the system theme. A page without script cannot change the theme of the framed document,
  so the Markdown and JSON reader keeps its own theme switch (and its Original link) inside the frame. Folder pages,
  which are not framed, get the theme switch in their bar.
- **Folder pages**: the existing toolbar and breadcrumb become the same top bar (path on the left, theme switch on the
  right); title, description and cards are unchanged.
- **Off switch**: `ARTIFACT_BAR=0` restores the direct redirect (no frame, no bar on artifacts). Default on.

## Known limits

- Navigating inside a ZIP site does not change the address bar; a reload returns to its entry page.
- A `#section` in the address reaches the frame page, not the framed document (no script to pass it on); "Open
  alone" keeps anchors working.
- Printing the frame page prints the visible part of the frame: "Open alone" prints the whole artifact.
- An artifact that navigates `_top` is blocked by its sandbox inside the frame (it never had more than its own page).

## Content server

- `/a/*`: with `rest === ''` and `Sec-Fetch-Dest: document`, after the access checks and the visit count, the frame
  page instead of the redirect. `/d/<folder>/a/<slug>`: the same, with the folder path.
- `serveFile`: `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN` on signed-path files; the global middleware
  only sets `DENY` when a response did not set its own.
- `src/content/frame-page.ts`: the frame page (bar, iframe, CSS shared with the folder page bar).

## Tests

- Browser navigation gets the frame page (no script, unsandboxed CSP with `frame-src 'self'`, iframe on the signed
  path, title, version, Original for Markdown and PDF only, Open alone); `curl`, `Sec-Fetch-Dest: iframe` or `script`,
  explicit file paths and link previews keep the redirect or Open Graph page.
- Signed paths are framable by the content origin only; every other response still says `DENY`.
- Through a folder: path from the granting folder, never above it; private artifact reachable only through the folder.
- One view per opening (frame), none for the iframe load. Private and code-protected artifacts: unchanged answers.
- `ARTIFACT_BAR=0`: redirect as before.

## Out of scope

Actions needing a script (copy link, share), passing anchors or ZIP navigation to the address bar, a bar inside the
artifact itself (its content is never modified), unlock and 404 pages.
