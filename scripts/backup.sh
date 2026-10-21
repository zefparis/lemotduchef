#!/usr/bin/env bash
# Sauvegarde PostgreSQL Le Mot du Chef → dumps/lemotduchef-YYYYmmdd-HHMMSS.dump
# Usage : ./scripts/backup.sh
set -euo pipefail
cd "$(dirname "$0")/.."

OUT_DIR="${BACKUP_DIR:-dumps}"
mkdir -p "$OUT_DIR"
FILE="$OUT_DIR/lemotduchef-$(date +%Y%m%d-%H%M%S).dump"

docker exec lemotduchef-db pg_dump \
  -U "${POSTGRES_USER:-lemotduchef}" \
  -d "${POSTGRES_DB:-lemotduchef}" \
  --format=custom --compress=6 \
  > "$FILE"

echo "Sauvegarde écrite : $FILE ($(du -h "$FILE" | cut -f1))"
