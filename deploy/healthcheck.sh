#!/usr/bin/env bash
# Runs every 5 minutes from recall-health.timer on the exit host. Checks the
# public URL end to end (front proxy → nginx → app) and messages the owner through
# the bot after two failures in a row, and again on recovery.
set -uo pipefail

set -a; . /etc/recall/recall.env; set +a
URL="${HEALTH_URL:-$APP_ORIGIN/api/health}"
STATE=/var/lib/recall-health/state   # "<consecutive failures> <alerted 0|1>"
mkdir -p "$(dirname "$STATE")"
{ read -r fails alerted < "$STATE"; } 2>/dev/null || { fails=0; alerted=0; }

notify() {
  [[ -n "${BOT_TOKEN:-}" && -n "${OWNER_TELEGRAM_ID:-}" ]] || return 0
  curl -fsS --max-time 10 "https://api.telegram.org/bot$BOT_TOKEN/sendMessage" \
    --data-urlencode "chat_id=$OWNER_TELEGRAM_ID" --data-urlencode "text=$1" >/dev/null || true
}

if body=$(curl -fsS --max-time 10 "$URL" 2>&1) && [[ "$body" == *'"ok":true'* ]]; then
  (( alerted )) && notify "✅ Mnemosyne is back up ($URL)"
  echo "0 0" > "$STATE"
  exit 0
fi

fails=$((fails + 1))
if (( fails >= 2 && ! alerted )); then
  status=$(systemctl is-active recall 2>/dev/null)
  notify "⚠️ Mnemosyne is down: $URL → ${body:0:200} (service: $status, $fails checks in a row)"
  alerted=1
fi
echo "$fails $alerted" > "$STATE"
