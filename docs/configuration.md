# Configuration

All configuration is read from environment variables at startup (`src/config.ts`). Invalid values stop the process
with an explicit message.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `HUB_SECRET` | yes | | Base64, ≥ 32 bytes after decoding: `openssl rand -base64 48`. Derives (HKDF) the keys for grants, folder grants, signed paths, link encryption, previews and visit fingerprints. **Changing it** signs everyone out, invalidates grants and signed paths, and makes stored share links unreadable (re-create them). |
| `PUBLIC_HUB_URL` | yes | | Admin origin, https (http only for `localhost`/`127.0.0.1`). Compared to the `Origin` header of mutations. |
| `PUBLIC_CONTENT_URL` | yes | | Content origin, used for artifact, folder and share URLs returned by the API. |
| `ADMIN_PASSWORD_HASH` | no | empty | `scrypt:…`, produced by `node src/scripts/hash-password.ts` (reads the password on stdin, 12 characters minimum). Empty: nobody can sign in (a warning is logged). |
| `API_TOKEN_HASH` | no | empty | 64 hex characters, produced by `node src/scripts/new-api-token.ts` (prints `token=` and `hash=`). Empty: Bearer authentication disabled. |
| `HUB_LOCALE` | no | `en` | Visitor pages: `en`, `fr` or `auto` (best match of the visitor's `Accept-Language`, English otherwise). Markdown/JSON readers are rendered at upload time: with `auto` they are English; after changing it, run `node src/scripts/rerender-documents.ts`. The admin UI language is chosen in the UI. |
| `DATA_DIR` | no | `/data` | Must be writable by the app user (UID 1000 in the image). |
| `ADMIN_BIND`, `CONTENT_BIND` | no | `127.0.0.1` | Listen addresses. In Docker, `0.0.0.0` with loopback-only port publishing, or fixed addresses on separate networks. |
| `ADMIN_PORT`, `CONTENT_PORT` | no | `3000`, `3001` | Listen ports. |
| `MAX_UPLOAD_MB` | no | `100` | Upload limit, enforced while streaming. |
| `ZIP_MAX_FILES` | no | `2000` | Maximum entries in a ZIP site. |
| `ZIP_MAX_BYTES` | no | `209715200` | Maximum extracted size of a ZIP site. |
| `TZ` | no | | Only affects log timestamps; visit days are UTC. |

Development only (`npm run dev`): `DEV_PASSWORD` (default `blazz-artifacts-dev`), `WEB_PORT` (5173), and the ports
above default to 13000/13001.

## Publish CLI

| Variable or file | Purpose |
|---|---|
| `ARTIFACT_HUB_URL` (alias `BLAZZ_ARTIFACTS_URL`) | Admin origin. Else first line of `~/.config/artifact-hub/url`. |
| `ARTIFACT_HUB_TOKEN` (alias `BLAZZ_ARTIFACTS_TOKEN`) | API token. Else macOS Keychain, service `artifact-hub`, account `api-token`. |

The `ARTIFACT_HUB_*` names, the `~/.config/artifact-hub/` path and the `artifact-hub` Keychain service are kept for
compatibility with existing installations; when both a primary variable and its alias are set, the primary wins.

## Forcing everyone to sign out

```bash
docker compose exec app node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/hub.sqlite');console.log(d.prepare('DELETE FROM admin_sessions').run())"
```
