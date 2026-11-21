# Client Markdown themes

Approved direction: reusable client branding, folder defaults, document overrides, and stable published renderings. User requested implementation with “ok go”.

Use the existing Node/SQLite renderer and React administration UI. Themes contain a name, client name, embedded raster logo, primary and accent colors, font preset, reading width, optional header/footer, and a documentation/report/editorial layout preset. No arbitrary CSS or remote fonts. Provide three built-in starting presets in the editor.

Persist themes in SQLite; nullable theme_id on projects and artifacts selects a theme. An artifact inherits its folder theme when unset, including ancestor folders. Store the complete resolved theme snapshot on each Markdown version and generate HTML using it at upload time. Editing themes or moving documents never changes existing versions. An explicit preview/apply workflow creates a new current version from the existing Markdown source with the selected theme. Existing version publication semantics remain unchanged; a separate draft/publication workflow is outside this feature.

Manage themes from the folder/document panels through a reusable editor and selector. The document panel offers a preview and explicit apply action. Explain that folder selections affect future imports and document selections affect future versions. Retain old snapshots even when a theme is removed. Existing documents and JSON rendering are unchanged without a selected theme.

Alternatives: live CSS references would change published documents unexpectedly; free CSS adds unnecessary validation and maintenance burden. Structured themes with immutable snapshots match the agreed behavior.

Verify inheritance, overrides, snapshot stability, restoration, invalid inputs, escaped branding, and migration idempotence; run existing tests, TypeScript and production build.
