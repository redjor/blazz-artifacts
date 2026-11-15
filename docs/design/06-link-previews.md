# 06 — Link previews

## Goal

Pasting an artifact or a folder link into Slack, Teams, iMessage, WhatsApp, Signal, Discord or LinkedIn shows a bare
URL, or at best the artifact's own `<title>`: the preview service follows the redirect to the raw file, which is a PDF,
a ZIP site or a page without Open Graph tags. A preview card (title, short excerpt, thumbnail) makes a shared link
recognisable at a glance, which is the point of the thumbnails the CLI already captures.

## Decisions

- **Only for link-preview services, never for people or scripts.** The content server answers a small Open Graph page
  instead of its usual redirect when the User-Agent is a known link-preview service (Slackbot-LinkExpanding,
  facebookexternalhit/Facebot (also iMessage), Twitterbot, LinkedInBot, Discordbot, TelegramBot, WhatsApp (also Signal),
  SkypeUriPreview/MicrosoftPreview (Teams), Mattermost, redditbot, Pinterest, VK, Iframely, Embedly). This list is distinct from the bot list that keeps
  visits uncounted: `curl`, `wget`, scripts and search engines keep today's redirect, so `curl -L` still downloads
  the artifact. Browsers never see the page.
- **A preview shows what the URL already opens, nothing more.** Previews are served on the entry URLs a cookie-less
  visitor can open:
  - `/a/<slug>` of a **public** artifact;
  - `/share/<token>` of an **active** share link (artifact or folder);
  - `/d/<folder>` and `/d/<folder>/a/<slug>` when the folder is reachable without a cookie (public, itself or through
    a parent).

  Private artifacts and folders stay 404. A code-protected artifact or folder keeps its unlock page, whose title is
  already all a preview service can read. A revoked or expired link, a trashed artifact, a cut access: 404, as today.
- **Content of the card.** Title of the artifact (or folder); description: the plain-text excerpt the dashboard cards
  already show (first paragraph, JSON start), the folder description, else the kind ("PDF") / "12 artifacts"; image: the
  captured thumbnail of the current version (for a folder, of its first artifact with one), `summary_large_image` when
  there is one. No site name, no hub branding: the services show the domain.
- **Thumbnail through a short signed URL.** `og:image` points to `/og/<artifactId>/<versionId>?s=…`, an HMAC over
  the artifact, its version, its access epoch and an expiry of 24 hours (new derived key). It needs no cookie (preview
  services fetch images separately), and it stops working when the version changes, when access is cut, or when the
  artifact is trashed. Revoking one share link does not bump the epoch: an image URL already handed to a service can
  still load for at most 24 hours (it shows the thumbnail that service already displayed).
- **Never counted.** Previews add no view and no link open (preview services are already excluded from the counts).
- **Off switch.** `LINK_PREVIEWS=0` disables the feature (previews services then get today's redirect). Default on.
- **Artifact content is never modified.** No tag is injected into the artifact's own HTML: the Open Graph page is a
  separate response, script-free, under the same sandbox CSP as the other visitor pages.

## What changes for visitors

Nothing. People and scripts get exactly the same responses; only the listed preview services see the Open Graph page.

## Content server

- `isLinkPreview(ua)` next to `isBot` (`visits.ts`), with its own short list.
- On the entry routes above, after every existing access check and before the redirect: a preview service gets
  `200 text/html` with `og:title`, `og:description`, `og:image` (absolute URL), `og:url` (the requested URL), `og:type`
  `website`, `twitter:card`, and a plain `<title>`, `<h1>` and link for completeness. `Cache-Control: no-store`.
- `GET /og/<artifactId>/<versionId>?s=…`: the thumbnail, only if the signature is valid, not expired, and the
  artifact is live with that current version and epoch; otherwise 404. `Cache-Control: public, max-age=86400`.
- The excerpt helper lives in `src/preview.ts` (moved from `admin/`), so the content server uses it without importing
  admin code.

## Tests

- A preview User-Agent gets the Open Graph page on each entry URL (escaped title, excerpt, signed image URL); a browser
  and `curl` get the usual redirect; the page adds no view and no link open.
- Private, trashed, revoked or expired link, code-protected (unlock page), folder not reachable without cookie: no
  preview.
- Signed image: valid; forged; expired; new version; epoch bumped (cut access); trashed.
- `LINK_PREVIEWS=0`: usual behaviour for preview services.

## Out of scope

Previews for code-protected items, a custom site name or image, previews of old versions, oEmbed, generating images for
artifacts without a captured thumbnail.
