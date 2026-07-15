FROM alpine:3.20
RUN apk add --no-cache postgresql16-client gnupg tzdata
COPY backup.sh /usr/local/bin/backup.sh
COPY restore.sh /usr/local/bin/restore.sh
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/restore.sh
# Run one backup at startup (so a fresh deploy is protected immediately),
# then hand over to cron for the nightly schedule.
CMD ["/bin/sh", "-c", "backup.sh || echo 'initial backup failed'; echo \"$BACKUP_CRON backup.sh >> /proc/1/fd/1 2>&1\" > /etc/crontabs/root && exec crond -f -l 8"]
