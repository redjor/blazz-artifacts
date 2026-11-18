# 13 — One “Share” entry point

## Goal

The artifact panel had three overlapping ways to share: “Copy link”, “Share for 7 days” and the “Access & sharing”
tab, whose visibility change needed an extra “Apply”. Worse, an artifact in **link** visibility without any active
link (expired, revoked, or switched in bulk) could be opened by nobody, and nothing said so.

## Decisions

- **One “Share” button** in the panel header, next to “Open”, opens a popover:
  - the visibility, as a compact radio list, **applied at once**;
  - the address that actually works for a visitor (public or code: the artifact URL; link: the most recent active
    share link, with its expiry) and **Copy**;
  - without a working address: “Create a 7-day link and copy it” (the existing share action);
  - “Links, audience and secret code…” opens the Access tab.
- **Immediate visibility, with an undo** in the toast (and `Ctrl/Cmd+Z`), the same mechanism as the trash. The Access
  tab's picker behaves the same; only a secret code still needs its form and “Apply” (a code must be typed).
  Safeguards, as confirmations: making an artifact public; leaving “code” (the code is erased, so there is no undo);
  switching to “link” when earlier links would work again. Switching to “link” with no usable link creates a 7-day
  link at once, which never leaves the artifact out of reach.
- **The dead state is visible**: a link artifact with no active link and no shared folder shows a warning in the
  card's meta line, in the popover and above its share links, with the way out (create a link).
- The card menu keeps its quick “Copy link” and “Share for 7 days”.

## Out of scope

The same popover for folders, bulk visibility changes (unchanged, with their own confirmation), an undo for leaving
code access.
