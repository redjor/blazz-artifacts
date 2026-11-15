# 05 — Bulk actions

## Goal

Every action in the gallery applies to one artifact at a time. Tidying up a hub of a few hundred artifacts (filing
a batch into a folder, tagging a series, moving a set to the trash) takes one menu per artifact. Bulk actions let
the owner select artifacts and act on all of them at once, with the same safeguards as the single actions.

## Decisions

- **Artifacts only.** Folder cards are not selectable: folders have their own panel and their own rules (sub-trees,
  inherited access), and none of the bulk actions below applies to them.
- **Selection mode.** Selecting a first artifact turns the gallery into selection mode: a click on a card toggles it
  instead of opening it, until the selection is empty again. Entry points: the check that appears on a card on hover
  or focus, "Select" in the card menu (the only way in on touch screens), and the `X` key on a focused card.
- **The selection follows what is visible.** Changing folder, search or filters keeps only the selected artifacts
  still shown; "Select all" selects the visible artifacts, never hidden ones.
- **One request, all or nothing.** `POST /artifacts/bulk` applies one operation to a list of ids in one transaction:
  either every artifact changes or none does. One reload follows.
- **Same safeguards, asked once.** Moving into a shared folder (shared itself or through a parent) asks one
  confirmation that counts the non-public artifacts that become visible there; making artifacts public asks one
  confirmation with the count. Trashing asks nothing and offers an undo that restores the whole batch.

## Actions

| Action | Notes |
|---|---|
| Move to… | Same folder picker as the card menu: "No folder", every folder (with its path), "New folder…". A folder created from here gets the selection, after the shared-folder confirmation when it sits inside a shared folder. |
| Tags | Add or remove typed tags (comma-separated, existing tags suggested); the tags already on the selection are listed with their count, one click removes one from every selected artifact. An artifact already at 20 tags makes the whole request fail (all or nothing). |
| Visibility | Private, link or public. "Code" is left out: one code for many artifacts is a different decision, made one by one. Switching to link does not create links. |
| Pin / Unpin | Unpin when every selected artifact is pinned, pin otherwise. Pin keeps the existing pin date of already pinned artifacts. |
| Move to the trash | Undo (toast or `Ctrl/Cmd+Z`) restores the batch, still selected, in its folders (design 04). Without a trash (`TRASH_DAYS=0`), a confirmation with the count. |

Artifacts an action would not change (already in the folder, already public) are left out of the request and of the
counts in the confirmations.

## Admin

### API

`POST /artifacts/bulk` with `{ ids, op, value? }`:

- `op`: `move` (`value`: folder name or null), `addTags` / `removeTags` (`value`: a non-empty list of tags),
  `visibility` (`value`: `private`, `link` or `public`; `code` answers `400 bulk_no_code`), `pin` / `unpin`, `trash`,
  `restore`.
- 1 to 500 distinct ids (`400 invalid_bulk_ids` otherwise). Every id must exist (live, or in the trash for `restore`),
  otherwise `404` and nothing changes. A tag set over 20 answers `400 too_many_tags` with the artifact's title.
  Answers `{ ok: true, count }`, plus `trashed` for `trash` (false when the hub deletes for good).
- Each operation does what its single route does: visibility and trash bump the access epoch, pinning touches neither
  `updated_at` nor the epoch, a move or a tag change updates `updated_at`. Artifacts already in the requested state are
  left untouched.

### Dashboard

- While something is selected, a selection bar takes the place of the title row tools: Clear, "3 selected",
  "Select all (n)" while some shown artifacts are not selected, then Move, Tags, Visibility, Pin and Trash. The title
  row sticks under the top bar so the actions stay at hand while scrolling; on a phone the bar also takes the title's
  room (the top bar still names the page).
- Escape clears the selection; `Ctrl/Cmd+A` outside a text field selects all visible artifacts.
- Cards and list rows show a checked state: a check (replacing the kind tile in the list), an outline on cards, a
  background on rows, and `aria-pressed` on the card button in selection mode. The hover check is mouse only: the card
  itself, `X` and the menu do the same for keyboards and screen readers. The count is announced through the gallery's
  status region.
- After an action the selection is cleared and focus returns to the first selected card, or its nearest neighbour when
  it left the view.

## Tests

- API: each operation on several ids; all or nothing on an unknown id or a tag set over 20; limits (0 or 501 ids,
  duplicates, wrong types), unknown operation, missing or invalid values; visibility bumps the epoch of the changed
  artifacts only; trash bumps the epoch and restore brings the batch back into a folder the trash had emptied; without a
  trash, the batch and its files are deleted.
- The single routes keep their behaviour.

## Out of scope

Selecting folders, bulk actions on folders, a "code" visibility in bulk, bulk share links, range selection with
Shift+click (can come later).
