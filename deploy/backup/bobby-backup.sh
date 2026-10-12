#!/usr/bin/env bash
# Nightly encrypted backup of the agent's state: the data directory (memory, conversations,
# connector and WhatsApp logins), the env file with its API keys, and the service glue that
# is not in git. Keeps a few copies on this machine and uploads to an rclone remote.
# Setup and restore: deploy/backup/README.md.
set -euo pipefail
umask 077

DATA=${INSTINCT_DATA:-$HOME/open-instinct/.instinct}
ENV_FILE=${INSTINCT_ENV_FILE:-$HOME/.instinct.env}
REPO=${INSTINCT_REPO:-$HOME/open-instinct}
CONF=${BOBBY_BACKUP_CONF:-$HOME/.config/bobby-backup}
LOCAL=${BOBBY_BACKUP_LOCAL:-$HOME/backups/bobby}
LOCAL_KEEP=${BOBBY_BACKUP_LOCAL_KEEP:-3}
REMOTE=${BOBBY_BACKUP_REMOTE:-gdrive:Bobby backups}
KEEP_DAYS=${BOBBY_BACKUP_KEEP_DAYS:-14}
RCLONE=${RCLONE:-$(command -v rclone || echo "$HOME/.local/bin/rclone")}
PASSPHRASE="$CONF/passphrase"

log() { echo "$(date -Is) $*"; }
[ -s "$PASSPHRASE" ] || { log "no passphrase at $PASSPHRASE (see README)"; exit 1; }
[ -d "$DATA" ] || { log "no data directory at $DATA"; exit 1; }

name="bobby-$(hostname)-$(date +%Y-%m-%d_%H%M).tar.zst.gpg"
mkdir -p "$LOCAL"
work=$(mktemp -d)
trap 'rm -rf "$work"; rm -f "$LOCAL/.partial"' EXIT

mkdir -p "$work/extra"
cp "$ENV_FILE" "$work/extra/instinct.env"
cp "$REPO/.git/hooks/post-receive" "$work/extra/" 2>/dev/null || true
git -C "$REPO" rev-parse HEAD > "$work/extra/commit" 2>/dev/null || true
systemctl cat instinct > "$work/extra/instinct.service" 2>/dev/null || true
crontab -l > "$work/extra/crontab" 2>/dev/null || true

# Browser caches are large and rebuild themselves. GNU tar exits 1 when a file changed while
# it was read (the agent is running); that copy is still usable, anything worse is fatal.
{ tar -cf - --exclude='Cache' --exclude='Code Cache' --exclude='GPUCache' --exclude='CacheStorage' \
    --exclude='ScriptCache' --warning=no-file-changed --warning=no-file-removed \
    -C "$(dirname "$DATA")" "$(basename "$DATA")" -C "$work" extra || [ $? -eq 1 ]; } |
  zstd -q -T1 -10 |
  gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-file "$PASSPHRASE" \
    --symmetric --cipher-algo AES256 --compress-algo none -o "$LOCAL/.partial"

# Prove it decrypts and unpacks before it replaces anything.
gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$PASSPHRASE" -d "$LOCAL/.partial" |
  zstd -q -d | tar -tf - > /dev/null
mv "$LOCAL/.partial" "$LOCAL/$name"
log "wrote $LOCAL/$name ($(du -h "$LOCAL/$name" | cut -f1))"

ls -1t "$LOCAL"/bobby-*.gpg | tail -n +$((LOCAL_KEEP + 1)) | xargs -r rm --

if [ -x "$RCLONE" ] && "$RCLONE" listremotes | grep -qx "${REMOTE%%:*}:"; then
  "$RCLONE" copy "$LOCAL/$name" "$REMOTE" --retries 5
  "$RCLONE" delete "$REMOTE" --min-age "${KEEP_DAYS}d" --include 'bobby-*.gpg' --drive-use-trash=false
  log "uploaded to $REMOTE"
else
  log "no rclone remote ${REMOTE%%:*}: configured, kept locally only"
  exit 2
fi
date -Is > "$CONF/last-ok"
