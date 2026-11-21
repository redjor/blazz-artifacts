# Markdown themes

In a folder's **Details** panel, use **Markdown theme → Create a client theme**. Set a name, client name, logo, colors, typography, reading width, and optional header/footer. Documentation, Report and Editorial provide three layout choices. Logos accept embedded PNG, JPEG or WebP files up to 512 KiB; typography includes standard fonts and a searchable Google Fonts catalog.

Save the theme, select it, and choose **Save for future versions**. New Markdown imports in this folder inherit it. Subfolders inherit the closest ancestor's selection unless they select their own theme. A document can select a different theme in its Details panel; choosing **Inherit from folder** clears its override.

Changing a theme or an assignment never rewrites an existing version. To update a document already uploaded, choose its theme, click **Preview**, then **Apply as a new version**. This creates and activates a version using the existing Markdown source; the document's URL and visibility rules stay the same. Previous retained versions can still be previewed or restored. This action follows the existing publication behavior: the new version is immediately current after applying.

When a themed Markdown version has no uploaded screenshot, its gallery, folder and history thumbnail automatically shows a branded excerpt with its logo, colors and typography. It uses that version's saved theme. An uploaded screenshot takes precedence.

If the document or selected theme changes after preview, applying is refused; reload and preview again. Previews expire after ten minutes. The preview is authenticated and sandboxed, like document content.

Deleting a theme clears its folder/document assignments but preserves all version snapshots. The maintenance rerender script uses the version's stored snapshot, so subsequent edits to the theme library do not alter its branding.

HTML, PDF, ZIP sites and JSON are unaffected. Theme selection controls Markdown rendering only.

In the theme editor, search under **Typography** to choose a Google font family, then use **Preview** to inspect the result. The first preview or save downloads the selected font on the server. Readers do not contact Google: validated font files are stored locally and embedded in each version, including its generated thumbnail. Previously downloaded families work offline. If a first download fails, retry or choose a standard font.

The bundled catalog contains 1,961 families. See [catalog maintenance](../app/src/data/README.md) for its source, refresh command and download limits.
