#!/usr/bin/env bash
#
# start.sh — Centralized TeXlyre server (Overleaf-like).
#
# Starts:
#   1. TeXlyre HTTP server   (port 8080) — serves the web app (vite preview of dist)
#   2. Yjs WebSocket server  (port 8082) — document sync
#   3. Terminal WebSocket    (port 8084) — browser shell (run codex, latexmk, etc.)
#
# Usage:
#   cd /path/to/LTC && bash server/start.sh [http-port] [ws-port] [term-port]
#

set -euo pipefail

cd "$(cd "$(dirname "$0")/.." && pwd)"

PORT_HTTP=${1:-8080}
PORT_WS=${2:-8082}
PORT_TERM=${3:-8084}
SESSION="texlyre-server"

echo "=== TeXlyre Centralized Server ==="
echo "  HTTP:     http://localhost:$PORT_HTTP/texlyre/"
echo "  Yjs WS:   ws://localhost:$PORT_WS"
echo "  Terminal: ws://localhost:$PORT_TERM"
echo ""

# ---- Check dependencies ----
if ! command -v tmux &>/dev/null; then
  echo "ERROR: tmux is required.  Install it: sudo apt install tmux"
  exit 1
fi
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js is required (>=20)"
  exit 1
fi
# node-pty needs make+gcc to compile
if ! command -v make &>/dev/null; then
  echo "Installing build tools (make, gcc)..."
  sudo apt update -qq && sudo apt install build-essential -y -qq
fi

# ---- Install dependencies ----
if [ ! -d "texlyre/node_modules" ]; then
  echo "Installing TeXlyre dependencies..."
  (cd texlyre && npm install)
fi

# node-pty needs its native addon built; rebuild if broken (interactive shell fix)
if ! (cd texlyre && node -e "require('node-pty')" 2>/dev/null); then
  echo "Rebuilding node-pty (native addon)..."
  (cd texlyre && npm rebuild node-pty 2>&1 || true)
fi

# Apply server settings (WebSocket mode) with the real server IP
# Desktop loads userdata.json (not userdata.local.json) — overwrite both.
# Revert tracked copy first so git pull never conflicts.
HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")
git checkout -- texlyre/userdata.json 2>/dev/null || true
sed "s/__HOST_IP__/$HOST_IP/g" texlyre/userdata.server.json > texlyre/userdata.json
cp texlyre/userdata.json texlyre/userdata.local.json
echo "Server config: collab websocket = ws://$HOST_IP:$PORT_WS"

# ---- Build (full pipeline: generate:plugins + tsc + vite build) ----
BUILD_MARKER="texlyre/dist/.ltc-build-v4"
if [ ! -d "texlyre/dist" ] || [ ! -f "$BUILD_MARKER" ]; then
  echo "Building TeXlyre (generate plugins + typecheck + bundle)..."
  (cd texlyre && npm run build:local)
  touch "$BUILD_MARKER"
fi

# ---- Kill previous session ----
tmux kill-session -t "$SESSION" 2>/dev/null || true

# ---- Start services in tmux (command passed directly, no send-keys quoting) ----
tmux new-session -d -s "$SESSION" \
  "cd texlyre && node scripts/pm.cjs vite preview --port $PORT_HTTP --host 0.0.0.0 --strictPort"

sleep 1

tmux new-window -t "$SESSION" \
  "NODE_PATH=$PWD/texlyre/node_modules node server/yjs-ws-server.js $PORT_WS"

sleep 0.5

tmux new-window -t "$SESSION" \
  "NODE_PATH=$PWD/texlyre/node_modules node server/terminal-server.js $PORT_TERM"

sleep 2

HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")

cat <<EOF

=== READY ===

  Web app:      http://$HOST_IP:$PORT_HTTP/texlyre/
  Yjs sync:     ws://$HOST_IP:$PORT_WS
  Terminal:     ws://$HOST_IP:$PORT_TERM

  Open the browser → click Terminal panel → run:  codex

  tmux: attach  → tmux attach -t $SESSION
        detach  → Ctrl+B, D
        stop    → tmux kill-session -t $SESSION

EOF

tmux kill-window -t "${SESSION}:_bootstrap" 2>/dev/null || true

echo ""
echo "Verification:"
for port in "$PORT_HTTP" "$PORT_WS" "$PORT_TERM"; do
  if ss -tln 2>/dev/null | grep -q ":$port "; then
    echo "  OK   port $port is listening"
  else
    echo "  FAIL port $port NOT listening"
  fi
done

echo ""
echo "To inspect a service:  tmux attach -t $SESSION  (Ctrl+B, then window number 0/1/2)"
