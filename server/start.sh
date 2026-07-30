#!/usr/bin/env bash
#
# start.sh — Centralized TeXlyre server (Overleaf-like).
#
# Starts three services:
#   1. Yjs WebSocket server  (port 8082) — document sync
#   2. Codex proxy server    (port 8083) — AI assistant via local codex CLI
#   3. TeXlyre HTTP server   (port 8080) — serves the web app
#
# Usage:
#   cd /path/to/LTC && bash server/start.sh
#

set -euo pipefail

cd "$(cd "$(dirname "$0")/.." && pwd)"

PORT_HTTP=${1:-8080}
PORT_WS=${2:-8082}
PORT_CODEX=${3:-8083}
AI_BACKEND=${4:-anthropic}   # anthropic | openai | ollama | chatgpt
SESSION="texlyre-server"

echo "=== TeXlyre Centralized Server ==="
echo "  HTTP:  http://localhost:$PORT_HTTP"
echo "  WS:    ws://localhost:$PORT_WS"
echo "  Codex: http://localhost:$PORT_CODEX"
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
if [ ! -d "texlyre/node_modules" ]; then
  echo "Installing TeXlyre dependencies..."
  (cd texlyre && npm install)
fi

# ---- Apply server settings ----
echo "Applying server preset..."
cp texlyre/userdata.server.json texlyre/userdata.local.json

# ---- Build TeXlyre if needed ----
if [ ! -d "texlyre/dist" ]; then
  echo "Building TeXlyre (first time)..."
  (cd texlyre && npm run build:local)
fi

# ---- Kill existing session ----
tmux kill-session -t "$SESSION" 2>/dev/null || true

# ---- Start services in tmux ----
tmux new-session -d -s "$SESSION" -n "texlyre" \; \
  send-keys "cd texlyre && npm run preview -- --port $PORT_HTTP --host 0.0.0.0" Enter

sleep 1

tmux new-window -t "$SESSION" -n "yjs-ws" \; \
  send-keys "cd texlyre && node ../server/yjs-ws-server.js $PORT_WS" Enter

sleep 0.5

tmux new-window -t "$SESSION" -n "codex-proxy" \; \
  send-keys "AI_PROXY_BACKEND=$AI_BACKEND node server/codex-proxy.js $PORT_CODEX" Enter

# ---- Print info ----
HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")

cat <<EOF

=== READY ===

  Web app:     http://$HOST_IP:$PORT_HTTP
  Yjs WS:      ws://$HOST_IP:$PORT_WS
  AI API:      http://$HOST_IP:$PORT_CODEX/v1/chat/completions

  tmux session: $SESSION
    Attach:  tmux attach -t $SESSION
    Detach:  Ctrl+B, D
    Stop:    tmux kill-session -t $SESSION

EOF

# ---- Apply settings to TeXlyre ----
echo "=== User Configuration ==="
echo ""
echo "Each user must configure TeXlyre settings ONCE:"
echo ""
echo "  1. Open http://$HOST_IP:$PORT_HTTP"
echo "  2. Go to Settings → Collaboration"
echo "  3. Set Provider Type → 'WebSocket (server)'"
echo "  4. Set WebSocket Server URL → 'ws://$HOST_IP:$PORT_WS'"
echo "  5. (Optional) AI Assistant → set API Base URL to:"
echo "     'http://$HOST_IP:$PORT_CODEX'"
echo ""

# Remove the bootstrap window
tmux kill-window -t "${SESSION}:_bootstrap" 2>/dev/null || true

# Attach
tmux attach -t "$SESSION"
