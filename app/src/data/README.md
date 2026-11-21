# Google Fonts catalog

`google-fonts.json` is a normalized snapshot of the official public catalog at
https://fonts.google.com/metadata/fonts. It includes family names, categories and
available upright weights; no font binaries are shipped in this catalog.

Refresh from `app/` with `node scripts/refresh-google-fonts.ts`, review the diff,
then run the font and theme tests. `updatedAt` is the catalog download date.
The CSS2 API is documented at https://developers.google.com/fonts/docs/css2.

Only the selected family is fetched from Google by the server, in the supported
weights nearest 400 and 700. Italics use browser synthesis, except for families available only in italic. Unicode subsets are
preserved, including non-Latin scripts. Validated WOFF2 assets are cached under
`DATA_DIR/fonts` and embedded into saved themes and published version snapshots.
Published content, previews and generated thumbnails make no Google requests.
Deleting a theme or refreshing the catalog does not change existing snapshots.

Downloads accept only HTTPS CSS2 requests and Google static WOFF2 paths, without
redirects. Each import has a 30-second deadline, 512-KiB CSS limit, 2-MiB per-face
limit, 512-face limit and 16-MiB aggregate binary limit. At most eight imports are
pending per process and six binaries download concurrently per import. Font
unavailability returns `font_unavailable` (503); previously cached families work
offline. Assets beyond these bounds cannot be imported. Normal theme DTOs omit
the server-owned `fontData` to preserve the existing admin request size limit.
