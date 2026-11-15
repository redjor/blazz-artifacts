# Security design

See [SECURITY.md](../SECURITY.md) for reporting and the short threat model. This page explains the mechanisms.

## Two origins

The admin and content servers must be served from **different hostnames**. Cookies, storage and the admin CSP never
apply to published content, and a mistake in the public proxy cannot expose the admin when the admin port is not
reachable from it (the Tailscale example uses two Docker networks: the public sidecar has no route to the admin
address).

## Sandbox for untrusted content

Every content response gets, whatever its type:

- `Content-Security-Policy: sandbox …` **without** `allow-same-origin` (HTML and sites:
  `allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads`; Markdown and
  JSON readers and folder pages: same without `allow-scripts`) and `frame-ancestors 'none'`;
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`;
- `Cache-Control: no-store` except served files (`private, max-age=3600`).

Each document therefore runs in an **opaque origin**: it cannot read the content domain's cookies or the responses of
other artifacts, and `localStorage`, `sessionStorage` and `IndexedDB` throw. PDFs are the exception (browsers refuse to
render PDFs in sandboxed documents): they are served inline without `sandbox`, the PDF viewer exposes no origin to the
document. Unknown file types are served as `application/octet-stream` attachments; MIME types come from an allow-list.

## Signed paths

Files are reachable only under `/a/<slug>/~<sig>/<path>`. The HMAC-SHA256 signature covers the artifact, the version,
the access epoch and an expiry (one hour). Relative links of a site inherit the signed prefix, so assets load without
cookies (which an opaque origin could not send anyway). Because opaque origins send `Origin: null`, signed responses
carry `Access-Control-Allow-Origin: *` (module scripts, fonts and `fetch()` work); no
`Cross-Origin-Resource-Policy`, which would block them. The signature is the only access control there.

- Expired or stale signature (other version, older epoch): `302` to the unsigned path, which re-checks access and
  re-signs, so navigation inside a site survives expiry. Forged signature: `404`.
- Admin previews of old versions use a distinct pinned form (`~p…`, HMAC payload prefixed `pin|`): a normal token cannot
  be turned into a pinned one.
- A signed path is a bearer credential for at most one hour (copied address bar URLs). Accepted and documented.

## Visibility and grants

| Visibility | `/a/<slug>` |
|---|---|
| `private` | 404, identical to a missing slug. The admin previews through signed URLs. |
| `public` | Direct access. |
| `code` | Unlock form (`POST /unlock/<slug>`); a correct code sets a grant cookie. Codes are 6 to 128 characters, stored as scrypt hashes. |
| `link` | 404 without a grant; `/share/<token>` sets the grant then redirects. |

The grant cookie (`__Host-grant_<artifactId>`, HttpOnly, Secure, SameSite=Lax) is an HMAC-signed claim: artifact,
access epoch, share link (if any), expiry (12 h, capped by the link's expiry). Each request re-checks signature, epoch,
link state (not revoked, not expired) and current visibility.

**Access epoch**: changing visibility or code, or "Cut all access", increments it. Every grant and signed path issued
before becomes invalid at once. Active share links are not revoked by it: revoke them separately.

**Share tokens**: 32 random bytes (base64url). Stored as SHA-256 (lookup) and AES-256-GCM encrypted (so the admin can
copy the link again). Changing `HUB_SECRET` makes stored links unreadable (they can still be revoked).

**Attempt limits** (in memory): codes, 5 failures per 15 minutes per IP and artifact, plus 20 per hour per artifact
(15-minute lock); admin sign-in and API token, 5 per 15 minutes per IP plus 20 per 15 minutes globally. Attempts are
reserved before the asynchronous check, so concurrent requests cannot bypass the limit. The client IP is the **last**
`X-Forwarded-For` entry: the proxy in front must append it.

## Folders

A folder (`/d/<name>`) has its own visibility, code hash, epoch, salt and share links. **Folder access opens its whole
content**, private artifacts included, but only through `/d/<name>/a/<slug>`, which checks folder access and current
membership, then issues the usual signed path. An artifact's own `/a/<slug>` keeps its own visibility. Folder grants use
a dedicated cookie (`__Host-fgrant_<name>`) and key. Folder thumbnails are served only through
`/d/<name>/thumb/<artifact>/<version>`, with folder access or a page-issued signature (1 h, tied to the folder epoch)
and current membership. The admin UI asks for confirmation (with the count) before sharing a folder that contains private
artifacts or moving a non-public artifact into a shared folder.

### Link previews

Known link-preview services (Slack, Teams, iMessage, WhatsApp/Signal, Discord, LinkedIn, Telegram…, a list distinct
from the bot list and without search engines or command-line tools) get a script-free Open Graph page instead of the
redirect, only on entry URLs that already granted access to a cookie-less request: a public `/a/<slug>`, an active
`/share/<token>`, a folder reachable without a cookie and its `/d/<name>/a/<slug>`. Private, code-protected, revoked,
expired and trashed items answer as before. The card holds the title, the plain-text excerpt (or folder description)
and the thumbnail through `/og/<artifact>/<version>?s=…`: an HMAC (dedicated key) over the artifact, its version, its
access epoch and an expiry of 24 hours; a new version, a cut access or the trash refuses it at once, while revoking a
single link leaves an image URL already handed to a service valid until it expires. Previews never count as views or
link opens and set no cookie. `LINK_PREVIEWS=0` turns the feature off.

### Sub-folders

Folders nest up to 4 levels, and access is always inherited: a visitor reaches folder F if F or any ancestor grants access, each checked with its own cookie and epoch; the highest granting folder wins. A private child is reachable through its parent. `/d/<F>/a/<slug>` serves direct members of F only. The breadcrumb starts at the highest ancestor the visitor can access, and the unlock page only names the requested folder, never its parent. Thumbnail signatures are bound to the granting folder and the displayed folder (the granting folder is re-checked as a current ancestor). Moving a folder out of a parent, or deleting the parent, cuts inherited access immediately for new openings (thumbnails are refused at once); an already-issued signed artifact path stays valid for up to 1 hour.

## Admin

Single account. Password: scrypt (`scrypt:N:r:p:salt:hash`, no `$` so Compose does not interpolate it). Session cookie
`__Host-hub_session` (HttpOnly, Secure, SameSite=Strict, 7 days), only its SHA-256 stored. Mutations require
`Origin == PUBLIC_HUB_URL` and `X-CSRF-Token`. The API token (`Authorization: Bearer`) bypasses cookies, Origin and CSRF
(no cookie, no CSRF), cannot sign in or out, and an invalid token fails even with a valid session cookie.

## Uploads

Multipart bodies are streamed to `data/tmp` by busboy and cut at `MAX_UPLOAD_MB`; nothing is buffered in memory. ZIP
extraction rejects the whole archive on absolute paths or drive letters, `..`, NUL bytes, empty names, symbolic links,
more than `ZIP_MAX_FILES` entries, more than `ZIP_MAX_BYTES` extracted (measured while extracting), a compression ratio
above 100:1 on entries over 1 MB, or a first segment starting with `~` (reserved for signatures); final paths are
resolved and checked against the version directory. Markdown is rendered by markdown-it then sanitised (no scripts,
event handlers or `javascript:` URLs). Thumbnails: WebP, PNG or JPEG only, magic bytes must match the declared type (SVG
always refused), 2 MiB max, never decoded by the server, stored outside `files/`.

## Visit statistics and privacy

Counted on the content server only; no script is injected, no cookie set.

- A view is a human `GET` navigation (`Sec-Fetch-Dest` absent or `document`, User-Agent not matching a bot or link-preview
  pattern) on the unsigned entry path, after the access check. Signed paths, `HEAD`, forms, wrong codes and 404s never count.
- A visitor is recognised for one UTC day by `HMAC(daily key, ip | user-agent)`, truncated; the daily key derives from
  `HUB_SECRET` and the date. One view per fingerprint per 30 minutes; at most 20 distinct fingerprints per IP, artifact and
  day (via a second HMAC of the IP alone). Fingerprints live in `visit_seen` for two days at most, purged at startup and
  hourly with `secure_delete` and a WAL checkpoint; only daily totals remain. IPs and User-Agents are never stored or logged.
- "Uniques" add up distinct visitors per day: someone coming back another day counts again.
