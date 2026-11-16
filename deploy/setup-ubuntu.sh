#!/usr/bin/env bash
# DeskBridge relay setup for a fresh Ubuntu 22.04/24.04 server (x86_64 or arm64).
#
#   curl -fsSL https://raw.githubusercontent.com/Caminare/desk-bridge/main/deploy/setup-ubuntu.sh -o setup.sh
#   sudo bash setup.sh --domain yourname.duckdns.org
#
# Options:
#   --domain NAME     Public domain pointing at this server (required). Used for HTTPS.
#   --branch NAME     Git branch to deploy (default: main).
#   --repo URL        Git repository (default: https://github.com/Caminare/desk-bridge.git).
#   --swap-gb N       Swap file size if the server has no swap (default: 2, 0 to skip).
#
# Safe to re-run: it updates the code, rebuilds and restarts, keeping the access token and
# paired hosts. What it sets up:
#   - Node.js 22 (NodeSource), git, Caddy (automatic HTTPS), ufw firewall (22/80/443)
#   - a swap file on small servers (building the web app needs more than 1 GB RAM)
#   - a dedicated `deskbridge` system user; code in /opt/deskbridge/app,
#     state (access token, enrollment key, paired hosts) in /var/lib/deskbridge
#   - /etc/deskbridge.env (APP_URL, generated DESKBRIDGE_ACCESS_TOKEN, ...)
#   - systemd service `deskbridge` listening on 127.0.0.1:3000 behind Caddy
set -euo pipefail

DOMAIN=""
BRANCH="main"
REPO="https://github.com/Caminare/desk-bridge.git"
SWAP_GB=2

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --swap-gb) SWAP_GB="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ $EUID -ne 0 ]]; then echo "Run as root (sudo bash $0 ...)." >&2; exit 1; fi
if [[ -z "$DOMAIN" ]]; then echo "Missing --domain (e.g. --domain yourname.duckdns.org)." >&2; exit 1; fi
if ! [[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]; then echo "Invalid domain: $DOMAIN" >&2; exit 1; fi
if ! [[ "$SWAP_GB" =~ ^[0-9]+$ ]]; then echo "Invalid --swap-gb: $SWAP_GB" >&2; exit 1; fi

APP_USER="deskbridge"
APP_HOME="/opt/deskbridge"
APP_DIR="$APP_HOME/app"
DATA_DIR="/var/lib/deskbridge"
ENV_FILE="/etc/deskbridge.env"
PORT=3000

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
export DEBIAN_FRONTEND=noninteractive

step "Checking that $DOMAIN points at this server"
PUBLIC_IP="$(curl -4 -fsS --max-time 5 https://api.ipify.org || true)"
DOMAIN_IP="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)"
if [[ -n "$PUBLIC_IP" && -n "$DOMAIN_IP" && "$PUBLIC_IP" != "$DOMAIN_IP" ]]; then
  echo "WARNING: $DOMAIN resolves to $DOMAIN_IP but this server is $PUBLIC_IP."
  echo "         HTTPS certificates will fail until the DNS record points here."
elif [[ -z "$DOMAIN_IP" ]]; then
  echo "WARNING: $DOMAIN does not resolve yet. HTTPS will start working once it does."
else
  echo "OK: $DOMAIN -> $DOMAIN_IP"
fi

# Fresh Ubuntu servers run unattended-upgrades on first boot, which holds the dpkg lock for
# several minutes. Make every apt call in this run (including the ones inside the NodeSource
# installer) wait for the lock instead of failing, and wait up front so progress is visible.
APT_LOCK_CONF=/etc/apt/apt.conf.d/99deskbridge-setup-lock-timeout
echo 'DPkg::Lock::Timeout "900";' > "$APT_LOCK_CONF"
trap 'rm -f "$APT_LOCK_CONF"' EXIT

wait_for_apt() {
  local waited=0
  while pgrep -x unattended-upgr >/dev/null || pgrep -x apt-get >/dev/null || pgrep -x apt >/dev/null || pgrep -x dpkg >/dev/null; do
    if [[ $waited -eq 0 ]]; then echo "Waiting for automatic system updates to finish (normal on a new server)..."; fi
    sleep 5
    waited=$((waited + 5))
    if [[ $((waited % 60)) -eq 0 ]]; then echo "  still waiting (${waited}s)..."; fi
  done
}

step "Installing system packages"
wait_for_apt
apt-get update -y
apt-get install -y ca-certificates curl git gnupg ufw
if ! apt-get install -y caddy; then
  # Ubuntu 22.04 has no caddy package: use Caddy's official repository.
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]]; then
  step "Installing Node.js 22"
  wait_for_apt
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "Node $(node -v), npm $(npm -v)"

if [[ "$SWAP_GB" -gt 0 ]] && ! swapon --show | grep -q .; then
  step "Creating ${SWAP_GB} GB swap file"
  fallocate -l "${SWAP_GB}G" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

step "Creating user and directories"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_HOME" --create-home --shell /usr/sbin/nologin "$APP_USER"
install -d -o "$APP_USER" -g "$APP_USER" -m 755 "$APP_HOME"
install -d -o "$APP_USER" -g "$APP_USER" -m 700 "$DATA_DIR"

step "Fetching DeskBridge ($BRANCH)"
if [[ -d "$APP_DIR/.git" ]]; then
  sudo -u "$APP_USER" git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  sudo -u "$APP_USER" git -C "$APP_DIR" checkout -B "$BRANCH" FETCH_HEAD
else
  sudo -u "$APP_USER" git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
fi

step "Installing dependencies and building (a few minutes on small servers)"
cd "$APP_DIR"
sudo -u "$APP_USER" -H npm install --no-audit --no-fund
sudo -u "$APP_USER" -H env NODE_OPTIONS=--max-old-space-size=1536 npm run build

step "Writing $ENV_FILE"
if [[ -f "$ENV_FILE" ]]; then
  # Keep the existing token and any keys you added; just refresh APP_URL.
  sed -i "s|^APP_URL=.*|APP_URL=https://$DOMAIN|" "$ENV_FILE"
else
  TOKEN="$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)"
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=$PORT
TRUST_PROXY=1
APP_URL=https://$DOMAIN
DESKBRIDGE_DATA_DIR=$DATA_DIR
DESKBRIDGE_ACCESS_TOKEN=$TOKEN
# Optional: enable the Gemini assistant, then: systemctl restart deskbridge
# GEMINI_API_KEY=
EOF
fi
chown root:"$APP_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"

step "Installing systemd service"
cat > /etc/systemd/system/deskbridge.service <<EOF
[Unit]
Description=DeskBridge relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$APP_DIR/node_modules/.bin/tsx server.ts
Restart=always
RestartSec=3
# Hardening: the relay only needs to write its state directory.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable deskbridge >/dev/null
systemctl restart deskbridge

step "Configuring Caddy (HTTPS for $DOMAIN)"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode zstd gzip
	reverse_proxy 127.0.0.1:$PORT
}
EOF
systemctl enable caddy >/dev/null
systemctl reload caddy 2>/dev/null || systemctl restart caddy

step "Configuring firewall (SSH, HTTP, HTTPS)"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
ufw status | sed -n '1,10p'

step "Checking the relay"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  echo "Relay is running."
else
  echo "Relay did not answer yet. Check: journalctl -u deskbridge -n 50" >&2
fi

TOKEN_NOW="$(grep '^DESKBRIDGE_ACCESS_TOKEN=' "$ENV_FILE" | cut -d= -f2-)"
cat <<EOF

=====================================================================
 DeskBridge is set up.

 Open:          https://$DOMAIN
 Access token:  $TOKEN_NOW
                (stored in $ENV_FILE; keep it private)

 Next:
  1. Open the URL on your phone and sign in with the token.
  2. On each Windows PC, open the URL, go to the Windows Host tab and
     download DeskBridge-Host.ps1 again (it embeds this server's address).

 Useful commands:
  journalctl -u deskbridge -f        live relay logs
  systemctl restart deskbridge       restart after editing $ENV_FILE
  bash $APP_DIR/deploy/update.sh     update to the latest code
=====================================================================
EOF
