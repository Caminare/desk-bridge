#!/usr/bin/env bash
# Update a DeskBridge relay installed by setup-ubuntu.sh to the latest code and restart it.
#   sudo bash /opt/deskbridge/app/deploy/update.sh [--branch NAME]
set -euo pipefail

# Everything runs inside main(), which bash parses in full before executing. This script
# lives in the repository it updates, so `git checkout` may rewrite it mid-run.
main() {
  local APP_USER="deskbridge"
  local APP_DIR="/opt/deskbridge/app"
  local BRANCH=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --branch) BRANCH="${2:-}"; shift 2 ;;
      *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
  done

  if [[ $EUID -ne 0 ]]; then echo "Run as root (sudo bash $0)." >&2; exit 1; fi
  if [[ ! -d "$APP_DIR/.git" ]]; then echo "No installation found in $APP_DIR. Run setup-ubuntu.sh first." >&2; exit 1; fi

  # The code must belong to the service user. Commands run as root inside the folder (a manual
  # git pull or npm install, a restore) leave root-owned files behind, and git then refuses to
  # work ("detected dubious ownership"). Repair it instead of failing.
  if [[ -n "$(find "$APP_DIR" -not -user "$APP_USER" -print -quit)" ]]; then
    echo "==> Fixing file ownership in $APP_DIR"
    chown -R "$APP_USER:$APP_USER" "$APP_DIR"
  fi

  if [[ -z "$BRANCH" ]]; then
    BRANCH="$(sudo -u "$APP_USER" git -C "$APP_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
  fi

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
  echo "Updated to $(sudo -u "$APP_USER" git -C "$APP_DIR" log -1 --format='%h %s')."
  echo "If the agent changed, re-download DeskBridge-Host.ps1 on each PC."
}

main "$@"
exit
