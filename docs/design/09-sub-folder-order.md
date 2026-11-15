# 09 — Sub-folder order

## Goal

Design 03 stores an order for sub-folders (`projects.position`) and exposes `PUT /projects/:name/children-order`, but
deferred the admin UI: sub-folders show in title order unless the API is called by hand. The owner should arrange them
like the artifacts of a folder.

## Decisions

- **Same place, same gestures as the artifact order.** The folder panel's "Order" tab gets a "Sub-folders" list above
  the artifact list, with the existing interaction: drag a row, or "Move" then `↑`/`↓`, Enter or Escape to finish or
  cancel. Each confirmed change is saved at once (`PUT /projects/:name/children-order`) and announced.
- **What the order drives**: the sub-folder cards inside the folder in the gallery and on the visitor page (both already
  read `position`, then title).
- **Rows**: folder icon, title (or name), artifact count, visibility. The tab counter shows artifacts plus sub-folders.
- **Root folders are not ordered here**: at the root the gallery sort (newest, title…) applies, and there is no parent
  panel to hold the list.
- **A concurrent change** (a sub-folder created, moved or deleted elsewhere) makes the server answer
  `409 folder_changed`; the list reloads from the saved order and says so, as the artifact order does.

## Tests

The server route is covered by design 03's tests. The shared ordering list keeps its keyboard and drag behaviour for
both lists.

## Out of scope

Ordering root folders, dragging folder cards in the gallery itself, ordering across levels (moving a folder to another
parent stays in "Move to").
