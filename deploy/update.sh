#!/usr/bin/env bash
# Update a DeskBridge relay installed by setup-ubuntu.sh to the latest code and restart it.
#   sudo bash /opt/deskbridge/app/deploy/update.sh [--branch NAME]
set -euo pipefail

APP_USER="deskbridge"
APP_DIR="/opt/deskbridge/app"
BRANCH="$(git -C "$APP_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch) BRANCH="${2:-}"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ $EUID -ne 0 ]]; then echo "Run as root (sudo bash $0)." >&2; exit 1; fi

echo "==> Fetching $BRANCH"
sudo -u "$APP_USER" git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
sudo -u "$APP_USER" git -C "$APP_DIR" checkout -B "$BRANCH" FETCH_HEAD

echo "==> Installing dependencies and building"
cd "$APP_DIR"
sudo -u "$APP_USER" -H npm install --no-audit --no-fund
sudo -u "$APP_USER" -H env NODE_OPTIONS=--max-old-space-size=1536 npm run build

echo "==> Restarting"
systemctl restart deskbridge
sleep 2
systemctl --no-pager --lines=5 status deskbridge || true
echo
echo "Updated to $(git -C "$APP_DIR" log -1 --format='%h %s')."
echo "If the agent changed, re-download DeskBridge-Host.ps1 on each PC."
