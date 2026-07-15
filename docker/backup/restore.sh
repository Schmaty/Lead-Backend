#!/bin/sh
# Restore an encrypted backup into the running db service.
# Usage (from the host):
#   docker compose exec backup restore.sh /backups/leadline-YYYY-MM-DD_HHMMSS.sql.gz.gpg
set -eu

FILE="${1:?usage: restore.sh /backups/leadline-....sql.gz.gpg}"
: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY is required}"

echo "Restoring $FILE into ${PGDATABASE}@${PGHOST} …"
gpg --batch --passphrase "$BACKUP_ENCRYPTION_KEY" --pinentry-mode loopback -d "$FILE" \
  | gunzip \
  | psql --set ON_ERROR_STOP=on

echo "Restore complete."
