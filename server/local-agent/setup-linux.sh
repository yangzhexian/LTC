#!/usr/bin/env bash
# ============================================================
# LTC Local Agent - one-time Linux setup
# Run once on your own machine:
#   bash server/local-agent/setup-linux.sh
# It installs dependencies, asks for server IP + token once,
# and registers a systemd user service (auto-start at login).
# Afterwards the "Local Agent" tab in the web app just works.
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

echo "============================================"
echo "  LTC Local Agent - Linux setup (one time)"
echo "============================================"

# ---- 1. Node.js ----
if ! command -v node &>/dev/null; then
  echo "Node.js >= 20 is required but not installed."
  echo "Install it, e.g.:"
  echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
  echo "  sudo apt install -y nodejs"
  exit 1
fi
echo "[1/3] Node.js: $(node --version)"

# ---- 2. Dependencies ----
echo "[2/3] Installing dependencies (ws, node-pty)..."
npm install --no-audit --no-fund

# ---- 3. Configuration (first time only) ----
if [ ! -f config.json ]; then
  echo "[3/3] First-time configuration:"
  read -rp "Server IP (e.g. 192.168.1.10): " SERVER_IP
  read -rp "Agent token (run on SERVER: cat ~/LTC/server/.terminal-token): " TOKEN
  read -rp "Local port [8085]: " PORT
  PORT=${PORT:-8085}
  SERVER_IP=${SERVER_IP:-localhost}
  cat > config.json <<EOF
{
  "port": "$PORT",
  "yjsUrl": "http://$SERVER_IP:8082",
  "token": "$TOKEN"
}
EOF
fi

# ---- 4. systemd user service (auto-start) ----
SYSTEMD_DIR="$HOME/.config/systemd/user"
mkdir -p "$SYSTEMD_DIR"
SERVICE_FILE="$SYSTEMD_DIR/ltc-agent.service"
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=LTC local agent terminal
After=network.target

[Service]
WorkingDirectory=$PWD
Environment=NODE_PATH=$PWD/node_modules
ExecStart=$(command -v node) $PWD/../terminal-server.js
Restart=on-failure

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now ltc-agent.service
echo "Auto-start service registered: $SERVICE_FILE"
echo "Status:  systemctl --user status ltc-agent"
echo "Stop:    systemctl --user stop ltc-agent"

echo ""
echo "DONE! Open the web app and click the 'Local Agent' tab."
echo "It connects to ws://127.0.0.1:${PORT:-8085}"
