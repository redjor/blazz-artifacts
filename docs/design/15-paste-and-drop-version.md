# 15 — Paste to publish, drop a new version

## Goal

Most artifacts come from an assistant's answer: today the owner saves it to a file, then drags or picks the file. And
a new version of an existing artifact goes through “Replace the file…”, at the bottom of its panel.

## Decisions

- **Paste to publish**: `Ctrl/⌘+V` in the gallery (outside text fields and dialogs, not on the trash page) opens the
  usual publish dialog with what was copied: a copied file as is; otherwise the plain text, when it reads as a
  document: HTML (a doctype, an `<html>` element, or markup with a closing block tag), JSON (an object or array that
  parses) or Markdown (anything else on several lines). Shorter than 20 characters, or a single line of prose (a URL,
  a word): not a document, a short message says what can be pasted. The file is named after the document's own title
  (`<title>` or the first `<h1>`, the first `# ` heading), else “Pasted <date> at <time>”; the dialog derives the
  title and address from that name as for any file. “Paste to publish” in the Create menu does the same through the
  asynchronous clipboard API (the browser may ask; on refusal, the message points to `Ctrl/⌘+V`).
- **Drop a new version**: a file dragged over an artifact card (grid or list) highlights it, and the drop overlay says
  “Drop on “X”: new version vN”. Dropping uploads it as the next version (`PUT /artifacts/:id/content`, unchanged).
  The toast offers Undo, which makes the previous version current again; the dropped version stays in the history.
  Not while selecting. Elsewhere in the gallery, a drop still publishes a new artifact.
- The detection is a pure module (`web/src/paste.ts`) tested with the server tests.

## Out of scope

Pasting images (a PNG is not an artifact kind), rich text (`text/html` of a copied web page: the plain text is used),
dropping on a folder card (it moves artifacts), several files at once.
