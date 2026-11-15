# 08 — Command palette

## Goal

Reaching an artifact deep in a folder tree, or an action buried in a menu, takes several clicks. A command palette
(`Ctrl/Cmd+K`) goes anywhere from the keyboard: type a few letters, press Enter.

## Decisions

- **One shortcut, everywhere in the admin.** `Ctrl/Cmd+K` opens the palette on every page (gallery, folder, trash),
  also from a text field, but not while another dialog is open. It is listed in the `?` shortcuts help.
- **Three kinds of entries**, in this order:
  - **Artifacts**: title, slug, tags and folder match as you type; content matches from the full-text search (design 07)
    join after a short pause. Enter opens the artifact's panel in its folder; `Ctrl/Cmd+Enter` opens the artifact
    itself in a new tab.
  - **Folders**: title, name or path. Enter opens the folder page.
  - **Actions**: publish a file, new folder (in the current folder), trash, grid or list view, switch language, keyboard
    shortcuts, sign out.
- **Empty query**: the most recently modified artifacts (5) and every action, so the palette is also a quick switcher.
- **Matching**: accents and case ignored, every typed word must appear (as a substring) in the entry's text. At most 8
  artifacts and 6 folders are listed; the full-text matches fill the artifact slots left.
- **Keyboard and screen readers**: combobox pattern (input with `aria-activedescendant` on a listbox, grouped
  options), `↑`/`↓` (wrapping), `Enter`, `Escape` closes and gives focus back; `Home`/`End` stay with the text field.
  Mouse hover moves the active entry; a click picks it. The result count is announced.
- **No new API**: the palette reads the lists the gallery already loads, plus `GET /search`.

## Dashboard

- `CommandPalette` component: a modal layer (focus trapped, page inert) at the top third of the screen, full width on
  phones.
- Each row: kind icon, title, a muted second line (folder path, kind and visibility for an artifact; artifact count for
  a folder; shortcut for an action).

## Out of scope

Actions on the found artifact from the palette (share, pin, move), recent searches, fuzzy (subsequence) matching,
commands with arguments.
