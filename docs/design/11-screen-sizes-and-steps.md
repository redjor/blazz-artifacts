# 11 — Screen sizes and folder steps

Extends [10 — Artifact bar](10-artifact-bar.md).

## Goal

Most artifacts are mockups. A visitor on a laptop sees a phone mockup stretched to the width of the window, and a
series of screens shared as a folder can only be read by going back to the folder page between each one. The bar
gets two script-free controls: a screen-size switch and previous / next through the folder.

## Decisions

- **Screen sizes** for HTML pages and ZIP sites only (they lay themselves out; Markdown and JSON readers and PDFs
  follow the window). Three links in the bar: Desktop (the window, as today), Tablet (820 × 1180) and Mobile
  (390 × 844). `?w=tablet` or `?w=mobile` on the entry address (`/a/<slug>`, `/d/<folder>/a/<slug>`) renders the
  iframe at that size, centred on the band colour, its height capped by the window. Any other value is ignored. The
  switch is hidden on narrow windows (900 px and below), where the page is already small.
- A size change is a navigation: the frame page is served again with a new signed path, so the artifact reloads.
  Visit counting is unchanged (a reload within half an hour does not count).
- **Folder steps**: an artifact opened through a folder (`/d/<folder>/a/<slug>`) gets previous / next links and its
  position (`2 / 5`), in visitor page order (the folder's order, artifacts without a version left out). The links keep
  the simulated screen. Opened at its own address, an artifact has no steps: it may not belong to a folder the
  visitor can see.
- The ends are disabled buttons (no link), so the controls never move.

## Out of scope

Rotating the simulated device, custom sizes, a device frame (notch, bezel), keyboard shortcuts (no script), steps
across sub-folders.
