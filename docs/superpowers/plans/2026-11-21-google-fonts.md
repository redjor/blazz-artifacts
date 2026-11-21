# Google Fonts in Markdown themes

**Goal:** Search and choose Google font families in the existing theme editor, preview and use them in documents and thumbnails.
**Architecture:** Ship a refreshed snapshot of Google's family catalog; fetch only the selected family's assets server-side. Persist locally and freeze font data with the theme/version. Keep existing sans/serif/mono values compatible.
**Constraints:** No browser requests to Google, no API key, no arbitrary URLs/CSS from API clients, validated font names and bounded downloads, graceful offline error, old versions unaffected.

- [x] Backend catalog and local font assets, theme validation/preparation, rendering and thumbnails, authenticated catalog API and tests.
- [x] Searchable selector in theme editor, standard fonts retained, preview via existing server-rendered preview, English/French loading/error messages.
- [x] Verify actual Google font import, snapshot stability, full test suite, TypeScript and production build.

Contract: GET /api/themes/fonts returns { fonts: [{family,category}], updatedAt: string }; font value is `google:<family>` or an existing preset. Existing theme save/preview routes prepare the selected font. Font assets are server-owned and omitted from editor DTOs.

Source: https://fonts.google.com/metadata/fonts (catalog snapshot); CSS2 API documentation: https://developers.google.com/fonts/docs/css2.
