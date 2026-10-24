#!/usr/bin/env bash
# Sauvegarde PostgreSQL Le Mot du Chef → dumps/lemotduchef-YYYYmmdd-HHMMSS.dump
# Pensé pour cron (aucune source de .env : les variables ont des défauts).
# Rotation intégrée : dumps de plus de BACKUP_KEEP_DAYS jours supprimés (le
# dernier dump restant n'est jamais effacé). Échoue bruyamment si pg_dump
# tombe ou si le fichier produit est vide.
# Usage : ./scripts/backup.sh   [BACKUP_DIR=...] [BACKUP_KEEP_DAYS=...]
set -euo pipefail
cd "$(dirname "$0")/.."

OUT_DIR="${BACKUP_DIR:-dumps}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
mkdir -p "$OUT_DIR"
FILE="$OUT_DIR/lemotduchef-$(date +%Y%m%d-%H%M%S).dump"

if ! docker exec lemotduchef-db pg_dump \
  -U "${POSTGRES_USER:-lemotduchef}" \
  -d "${POSTGRES_DB:-lemotduchef}" \
  --format=custom --compress=6 \
  > "$FILE"; then
  rm -f "$FILE"
  echo "ERREUR : pg_dump a échoué — aucune sauvegarde écrite." >&2
  exit 1
fi

# Un dump vide ou tronqué (conteneur arrêté, disque plein) ne doit jamais
# passer pour une sauvegarde réussie.
if [ ! -s "$FILE" ]; then
  rm -f "$FILE"
  echo "ERREUR : sauvegarde vide — $FILE supprimé." >&2
  exit 1
fi

# Rotation : supprime les dumps de plus de KEEP_DAYS jours, sans jamais
# effacer le dernier dump restant.
LAST="$(ls -1t "$OUT_DIR"/lemotduchef-*.dump 2>/dev/null | head -1 || true)"
find "$OUT_DIR" -name 'lemotduchef-*.dump' -mtime +"$KEEP_DAYS" -print |
  while IFS= read -r old; do
    [ "$old" = "$LAST" ] && continue
    rm -f -- "$old" && echo "Rotation : $old supprimé."
  done

echo "Sauvegarde écrite : $FILE ($(du -h "$FILE" | cut -f1))"
