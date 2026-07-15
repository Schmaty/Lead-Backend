#!/bin/sh
# Nightly encrypted logical backup: pg_dump | gzip | gpg (AES-256, symmetric).
# Decrypt with: gpg --batch --passphrase "$BACKUP_ENCRYPTION_KEY" -d FILE | gunzip
set -eu

: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY is required}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y-%m-%d_%H%M%S)"
FILE="/backups/leadline-${STAMP}.sql.gz.gpg"

pg_dump --no-owner --clean --if-exists \
  | gzip \
  | gpg --batch --yes --symmetric --cipher-algo AES256 \
        --passphrase "$BACKUP_ENCRYPTION_KEY" --pinentry-mode loopback \
        -o "$FILE"

find /backups -name 'leadline-*.sql.gz.gpg' -mtime +"$RETENTION_DAYS" -delete

echo "backup written: $FILE ($(du -h "$FILE" | cut -f1))"
