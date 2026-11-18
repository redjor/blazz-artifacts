# 14 — Live preview and quick look

## Goal

The artifact panel was a set of forms: to see the artifact itself, the owner had to open it in a new tab. Going
through a folder of mockups meant one tab per artifact.

## Decisions

- **Live preview** at the top of the panel's Details tab: the current version in an iframe, HTML pages and sites
  rendered at twice the panel's width and scaled down by half (a desktop-like layout), readers and PDFs at the
  panel's width. It is not interactive (`inert`, no pointer, scripts only in its sandbox): a click opens the quick
  look, and an artifact that focuses itself cannot pull focus into it. The gallery thumbnail and its upload button
  stay just below.
- **Quick look**: a full-window layer over the gallery, or over the panel when opened from it. `Space` on a focused
  card opens it (`Enter` still opens a tab), as does “Quick look” in the card menu and a click on the live preview.
  Inside, `←` / `→` go through the gallery's current order, `Space` (outside its own buttons, which Space activates)
  or `Esc` close it and focus goes back to the
  card last looked at (or into the panel). Desktop, Tablet and Mobile sizes for HTML pages and sites, as in the
  visitor bar (design 11). “Open in a new tab” and “Manage” (the panel) complete it.
- **Framing**: both use the signed admin preview path (valid an hour). Signed-path files accept the admin origin as an
  ancestor next to the content origin, and the admin CSP allows the content origin in `frame-src`; see
  [security](../security.md#admin-preview). The admin adds its own iframe `sandbox` (no same origin, no top navigation,
  no modals), chosen by the kind of the version shown, except for PDFs, which Chrome does not render in a sandboxed
  frame.

## Known limits

- Keys pressed inside the framed artifact stay in it: after clicking into the artifact, close the quick look with its
  button (or click outside the frame first).
- Browsers that ignore `frame-ancestors` and apply `X-Frame-Options: SAMEORIGIN` show no preview.

## Out of scope

Quick look on folder cards, comparing versions there (see the History tab), remembering the chosen screen size.
