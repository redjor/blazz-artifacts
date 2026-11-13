# Deployment

The image runs as UID 1000, read-only root filesystem, all capabilities dropped, `/tmp` on tmpfs; the only writable
path is the data volume. Memory: about 50 MB at rest, `mem_limit: 256m` is plenty. The image build runs the typecheck,
the test suite and the SPA build (about 1 GB of RAM for a few minutes).

Two shapes are provided in `deploy/`. In both, **admin and content must be on different hostnames**.

## Behind a reverse proxy (`deploy/docker-compose.yml`)

The app publishes `127.0.0.1:3000` (admin) and `127.0.0.1:3001` (content) only.

```bash
cd deploy
cp .env.example .env && chmod 600 .env
sed -i.bak "s|^HUB_SECRET=.*|HUB_SECRET=$(openssl rand -base64 48)|" .env && rm .env.bak
docker compose build
read -s P; printf %s "$P" | docker run --rm -i --network none blazz-artifacts:local node src/scripts/hash-password.ts
# ADMIN_PASSWORD_HASH=scrypt:…   PUBLIC_HUB_URL=https://admin.example.com   PUBLIC_CONTENT_URL=https://artifacts.example.com
mkdir -p data && sudo chown 1000:1000 data
docker compose up -d && docker compose ps
```

Then configure the proxy ([Caddy example](../deploy/caddy/Caddyfile.example)):

- one hostname per server, TLS on both;
- restrict the admin hostname (IP allow-list, VPN, SSO forward-auth…); allow uploads up to `MAX_UPLOAD_MB`;
- the proxy must **append** the client address to `X-Forwarded-For` (Caddy, nginx `$proxy_add_x_forwarded_for` and
  Traefik do). The app uses the last entry for rate limiting and visit counting; without a proxy every client looks the same;
- do not override the app's security headers.

To use a published image instead of building, set `BLAZZ_ARTIFACTS_IMAGE=ghcr.io/<owner>/blazz-artifacts:<version>` and
run `docker compose pull && docker compose up -d` (the release workflow builds multi-arch images on `v*` tags).

## Tailscale (`deploy/docker-compose.tailscale.yml`)

Example used on a home NAS: no port published on the host, the admin reachable only from your tailnet, the content public
through Tailscale Funnel. Two sidecars on two Docker networks; the public sidecar has no route to the admin address.

| URL | Role | Exposure |
|---|---|---|
| `https://artifacts-admin.<tailnet>.ts.net` | Admin | tailnet only (`tailscale serve`) |
| `https://artifacts.<tailnet>.ts.net` | Content | public (`tailscale funnel`) |

One-time Tailscale setup in the admin console:

- **DNS**: enable MagicDNS and HTTPS certificates.
- **Access controls**: add tags and the Funnel attribute, and make sure only your devices can reach the admin node:

  ```json
  "tagOwners": { "tag:artifacts-admin": ["autogroup:admin"], "tag:artifacts": ["autogroup:admin"] },
  "nodeAttrs": [ { "target": ["tag:artifacts"], "attr": ["funnel"] } ]
  ```

  Neither tag should be the `src` of any rule or grant; the policy must not be the default allow-all.
- **Keys**: two **tagged** auth keys (`tag:artifacts-admin`, `tag:artifacts`), not reusable, not ephemeral. Without a tag
  the node would belong to your user and inherit all of your access.

```bash
cd deploy
cp .env.example .env && chmod 600 .env     # HUB_SECRET, password hash, URLs, TS_AUTHKEY_ADMIN, TS_AUTHKEY_CONTENT
mkdir -p data ts-admin/state ts-content/state && sudo chown 1000:1000 data
docker compose -f docker-compose.tailscale.yml up -d --build
```

The stack uses the subnets `172.30.41.0/24` and `172.30.42.0/24` with fixed addresses (the serve configs point to them).
Check they are free (`docker network inspect $(docker network ls -q) --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}'`);
otherwise change the two subnets, the app's two `ipv4_address`, `ADMIN_BIND`, `CONTENT_BIND`, the healthcheck URL and the
`Proxy` targets in `deploy/tailscale/serve-*.json`, then run `scripts/check-compose.sh`.

Tailscale passes the real client address as the last `X-Forwarded-For` entry for serve and Funnel traffic. The Tailscale
image is pinned; to upgrade, change the tag in both services and recreate them. Tailscale state (`ts-*/state`) is not worth
backing up: re-register the nodes with new tagged keys if it is lost.

### Post-deployment checks

From a device **outside** your private network:

- [ ] the admin URL does not answer;
- [ ] a private artifact returns 404 on `/a/<slug>`, its assets too;
- [ ] a share link works, and returns 404 once revoked in the hub;
- [ ] a `code` artifact: wrong code, then right code, then the content (a `__Host-grant_…` cookie is set);
- [ ] a folder shared by link opens after the link; a private artifact of that folder opens from its card, while its own
      `/a/<slug>` stays 404;
- [ ] a published Vite build (`<script type="module">`) renders without CORS errors in the console;
- [ ] six wrong codes from one network: the sixth answers 429; another network has its own counter.

On the host (Tailscale variant): `docker compose -f docker-compose.tailscale.yml exec ts-content wget -qO- -T 3 http://172.30.41.10:3000/api/session` **must fail**.

## Updating

```bash
git pull && cd deploy && docker compose up -d --build      # or pull a new image tag
```

Migrations run at startup. The image pins Node 24 because `node:sqlite` is still experimental (the startup
`ExperimentalWarning` is expected); change that version deliberately and run the tests.

## Backups

`scripts/backup.sh [STACK_DIR] [DEST_DIR]` makes a consistent hot copy of the database **inside the container**
(`VACUUM INTO`, no `sqlite3` needed on the host), then archives it with `data/files`, `data/thumbs` (when present) and
`.env` into `DEST_DIR/blazz-artifacts_<date>.tar.gz` (mode 600, checked with `gzip -t`), keeping `KEEP` archives (14).
Set `COMPOSE_FILE=docker-compose.tailscale.yml` for the Tailscale variant. Schedule it daily from root's crontab.

Published files and thumbnails are written 0644 (folders 0755) whatever the uploaded mode, and the app repairs older
files at startup, so a non-root backup can read everything.

### Restore

```bash
cd deploy
docker compose down
mv data "data.before-restore.$(date +%s)"
mkdir -p /tmp/restore && tar xzf /path/to/blazz-artifacts_<date>.tar.gz -C /tmp/restore
mkdir data && mv /tmp/restore/data/files data/files && mv /tmp/restore/data/backup/hub.sqlite data/hub.sqlite
if [ -d /tmp/restore/data/thumbs ]; then mv /tmp/restore/data/thumbs data/thumbs; fi
sudo chown -R 1000:1000 data
# restore /tmp/restore/.env only if the original is lost (HUB_SECRET must match the database's links)
docker compose up -d && docker compose ps
```

### Restore drill

Extract the latest archive into a scratch folder and read the database read-only:

```bash
docker run --rm --network none -v /tmp/drill/data/backup:/drill:ro blazz-artifacts:local \
  node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/drill/hub.sqlite',{readOnly:true});console.log(d.prepare('select count(*) n from artifacts').get())"
```

Compare the count with the dashboard, then delete the scratch folder. A missing thumbnail after a restore only falls
back to the text excerpt; `publish.py --thumbnail-only --slug S` recaptures it.
