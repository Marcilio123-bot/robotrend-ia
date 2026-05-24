#!/usr/bin/env bash
set -euo pipefail
# Backup do Postgres do Robotrend (rodar em VPS via cron)
# Cron diário 03:00: 0 3 * * * /opt/robotrend/scripts/backup-postgres.sh

DEST="${BACKUP_DIR:-/var/backups/robotrend}"
DB_URL="${DATABASE_URL:?DATABASE_URL não definido}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"

mkdir -p "$DEST"
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$DEST/robotrend-$STAMP.sql.gz"

pg_dump "$DB_URL" | gzip -9 > "$OUT"
echo "backup ok: $OUT ($(du -h "$OUT" | cut -f1))"

find "$DEST" -name 'robotrend-*.sql.gz' -mtime +"$RETENTION_DAYS" -delete
echo "rotacao $RETENTION_DAYS dias aplicada"
