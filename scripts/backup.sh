#!/usr/bin/env bash
#
# Backs up a Blazz Artifacts stack: a consistent copy of the database (VACUUM INTO, run INSIDE the
# container so the host needs no sqlite3), the published files, the thumbnails (when present) and .env.
#
# Usage:  scripts/backup.sh [STACK_DIR] [DEST_DIR]
#   STACK_DIR  folder holding the compose file, .env and data/ (default: $STACK or ./deploy)
#   DEST_DIR   where archives go (default: $DEST or $STACK_DIR/backups)
#   KEEP       archives to keep (default 14)      COMPOSE_FILE  compose file name (default docker-compose.yml)
#
# Schedule it daily, e.g. in root's crontab:
#   0 3 * * * /opt/blazz-artifacts/scripts/backup.sh /opt/blazz-artifacts/deploy /var/backups/blazz-artifacts >> /var/log/blazz-artifacts-backup.log 2>&1

set -euo pipefail
umask 077

STACK="$(cd "${1:-${STACK:-./deploy}}" && pwd)"
DEST="${2:-${DEST:-$STACK/backups}}"
KEEP="${KEEP:-14}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
STAMP="$(date +%Y-%m-%d_%H%M)"
ARCHIVE="${DEST}/blazz-artifacts_${STAMP}.tar.gz"

mkdir -p "$DEST"
docker compose --project-directory "$STACK" -f "$STACK/$COMPOSE_FILE" exec -T app node src/scripts/backup-db.ts >/dev/null

paths=(data/backup/hub.sqlite data/files)
if [ -f "$STACK/.env" ]; then paths+=(.env); fi
if [ -d "$STACK/data/thumbs" ]; then paths+=(data/thumbs); fi
tar czf "$ARCHIVE" -C "$STACK" "${paths[@]}"
chmod 600 "$ARCHIVE"
gzip -t "$ARCHIVE"
rm -f "$STACK/data/backup/hub.sqlite"

ls -1t "${DEST}"/blazz-artifacts_*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

echo "Backup: ${ARCHIVE} ($(du -h "$ARCHIVE" | cut -f1))"
