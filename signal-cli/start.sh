#!/bin/bash
# ── Ariana Signal-CLI — Persistent Auth via Supabase ──────────

BUCKET="ariana-media"          # reuse existing bucket
FILE="signal-auth/signal-data.tar.gz"   # stored in subfolder
BACKUP_TMP="/tmp/signal-backup.tar.gz"

DATA_PATHS=(
  "/home/.local/share/signal-cli"
  "/root/.local/share/signal-cli"
  "/home/signal-api/.local/share/signal-cli"
)

find_data_dir() {
  for p in "${DATA_PATHS[@]}"; do
    [ -d "$p" ] && echo "$p" && return
  done
  echo "/home/.local/share/signal-cli"
}

restore() {
  if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_SERVICE_ROLE_KEY" ]; then
    echo "⚠️  Supabase env vars not set — skipping restore"
    return
  fi
  echo "🔄 Restoring Signal auth from Supabase..."
  HTTP_STATUS=$(curl -s -w "%{http_code}" -o "$BACKUP_TMP" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
    "${SUPABASE_URL}/storage/v1/object/${BUCKET}/${FILE}")

  if [ "$HTTP_STATUS" = "200" ] && [ -s "$BACKUP_TMP" ]; then
    tar -xzf "$BACKUP_TMP" -C / 2>/dev/null && echo "✅ Signal auth restored — no re-linking needed"
    # json-rpc mode with USER root looks in /root — copy there if needed
    if [ -d "/home/.local/share/signal-cli" ] && [ ! -d "/root/.local/share/signal-cli" ]; then
      mkdir -p /root/.local/share
      cp -r /home/.local/share/signal-cli /root/.local/share/signal-cli
      echo "📋 Synced Signal data to /root path for json-rpc mode"
    fi
  else
    echo "ℹ️  No backup yet — fresh start. Link once and it persists forever."
  fi
}

backup() {
  local DATA_DIR
  DATA_DIR=$(find_data_dir)
  [ ! -d "$DATA_DIR" ] && return

  tar -czf "$BACKUP_TMP" "$DATA_DIR" 2>/dev/null || return

  STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X PUT \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Content-Type: application/gzip" \
    -H "x-upsert: true" \
    --data-binary @"$BACKUP_TMP" \
    "${SUPABASE_URL}/storage/v1/object/${BUCKET}/${FILE}")

  [ "$STATUS" = "200" ] || [ "$STATUS" = "201" ] \
    && echo "💾 Signal auth backed up ($(date '+%H:%M:%S'))" \
    || echo "⚠️  Backup failed: HTTP $STATUS"
}

backup_loop() {
  sleep 60
  while true; do backup; sleep 300; done
}

restore
backup_loop &
echo "🚀 Starting signal-cli-rest-api..."
exec /entrypoint.sh "$@"
