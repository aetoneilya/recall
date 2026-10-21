#!/usr/bin/env bash
# Ship the current checkout to the exit host and restart the service.
# First-time host setup is in README.md ("Deploy").
set -euo pipefail

# DEPLOY_HOST=root@<host>, in the environment or in the untracked .deploy.env.
[[ -f "$(dirname "$0")/../.deploy.env" ]] && . "$(dirname "$0")/../.deploy.env"
HOST="${DEPLOY_HOST:?set DEPLOY_HOST=root@<host> (or put it in .deploy.env)}"
DIR=/opt/recall
cd "$(dirname "$0")/.."

# Nothing broken leaves the laptop: typecheck + tests in every workspace.
npm run check
npm -w @recall/web run build

# -R keeps the relative paths, so web/dist lands at $DIR/web/dist.
rsync -azR --delete \
  --exclude node_modules --exclude '.git' --exclude '*.db' --exclude '*.db-*' --exclude .env \
  --exclude 'server/test' \
  package.json package-lock.json .npmrc packages server deploy web/dist web/package.json \
  "$HOST:$DIR/"

ssh "$HOST" "set -e
  cd $DIR
  npm ci --omit=dev -w @recall/server -w @recall/core --no-audit --no-fund
  # A copy of the live DB before the new code (and any migration) touches it.
  install -d -o recall -g recall /var/lib/recall/backups
  sudo -u recall node -e \"const {DatabaseSync}=require('node:sqlite'); new DatabaseSync('/var/lib/recall/recall.db').exec(\\\"VACUUM INTO '/var/lib/recall/backups/pre-deploy-\$(date +%Y%m%d-%H%M%S).db'\\\")\"
  ls -1t /var/lib/recall/backups/pre-deploy-*.db | tail -n +11 | xargs -r rm --
  cp deploy/recall.service deploy/recall-health.service deploy/recall-health.timer /etc/systemd/system/
  systemctl daemon-reload
  systemctl restart recall
  # Migrations run at startup, so give it up to 60 s.
  for i in \$(seq 60); do curl -fsS http://127.0.0.1:8090/api/health 2>/dev/null && break; sleep 1; done
  curl -fsS http://127.0.0.1:8090/api/health
  journalctl -u recall -n 15 --no-pager -o cat | grep -v ExperimentalWarning"
echo
echo deployed
