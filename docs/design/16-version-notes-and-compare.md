# 16 — Version notes and comparison

## Goal

Versions are numbered and dated, nothing more: “what changed in v4?” has no answer in the hub, and comparing two
versions means opening two previews in two tabs and switching between them.

## Decisions

- **Version note**: one optional line per version (`versions.message`, 200 characters, whitespace folded, blank
  clears). Set at upload (`message` in the multipart of `POST /artifacts` and `PUT /artifacts/:id/content`; `-m` /
  `--message` in the CLI; a field next to “Replace file…” in the panel), written or corrected later in the History tab
  (`PATCH /artifacts/:id/versions/:versionId`). A note never changes the artifact's modification date nor its access.
- **Where it shows**: under each version in the History tab, in `--list-versions` (last column), after `version:` when
  the CLI publishes (`note:`), and in the visitor bar's version tooltip (“Version 3: header reworked”).
- **Comparison**: from the History tab, “Compare” on any older version (against the current one) or “Compare the last
  two”. A full-window view shows two kept versions side by side (stacked on narrow screens), each side with its own
  version picker, date and note, and Desktop / Tablet / Mobile sizes for HTML pages and sites. Each side is the version's
  pinned admin preview in a sandboxed frame (design 14); the two frames cannot scroll together.

## Out of scope

A text or source diff, an overlay or slider comparison, synchronised scrolling, notes on folders.
