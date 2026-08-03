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

# ---- Internal auth token (Tier 1: server-to-server only) ----
# Generated once, persisted in server/.terminal-token. Used ONLY by the
# terminal server → yjs server /apply-file bridge. NOT shipped to browsers.
TOKEN_FILE="$PWD/server/.terminal-token"
if [ ! -f "$TOKEN_FILE" ]; then
  head -c 24 /dev/urandom | base64 | tr -d '/+=' > "$TOKEN_FILE" || true
fi
if [ ! -s "$TOKEN_FILE" ]; then
  echo "WARNING: could not generate random token, using fallback (change server/.terminal-token manually!)"
  date +%s | sha256sum | head -c 32 > "$TOKEN_FILE"
fi
TERMINAL_TOKEN="$(cat "$TOKEN_FILE")"

# ---- Site access token (web UI entry gate) ----
# Entered at startup; the web app's first screen asks visitors for it.
# Persisted in server/.site-token so restarts can keep the same token.
SITE_TOKEN_FILE="$PWD/server/.site-token"
SITE_TOKEN=""
if [ -f "$SITE_TOKEN_FILE" ]; then
  SITE_TOKEN="$(cat "$SITE_TOKEN_FILE")"
fi
if [ -t 0 ]; then
  if [ -n "$SITE_TOKEN" ]; then
    read -p "Site access token (press Enter to keep current, or type a new one): " -s SITE_TOKEN_INPUT
  else
    read -p "Site access token for the web UI (empty = no gate, anyone can open the app): " -s SITE_TOKEN_INPUT
  fi
  echo
  if [ -n "$SITE_TOKEN_INPUT" ]; then
    SITE_TOKEN="$SITE_TOKEN_INPUT"
    echo "$SITE_TOKEN" > "$SITE_TOKEN_FILE"
  fi
fi
if [ -z "$SITE_TOKEN" ]; then
  echo "WARNING: no site access token set - the web UI is open to anyone who knows the IP."
  echo "         Set one by running: bash server/start.sh (or echo '<token>' > server/.site-token)"
fi

# ---- Invite code (Tier 1 registration) ----
# New accounts require this code (empty = anyone who passed the gate can
# register). Persisted in server/.invite-code.
INVITE_CODE_FILE="$PWD/server/.invite-code"
INVITE_CODE=""
if [ -f "$INVITE_CODE_FILE" ]; then
  INVITE_CODE="$(cat "$INVITE_CODE_FILE")"
fi
if [ -t 0 ]; then
  if [ -n "$INVITE_CODE" ]; then
    read -p "Registration invite code (press Enter to keep current, or type a new one): " -s INVITE_CODE_INPUT
  else
    read -p "Registration invite code for new accounts (empty = open registration): " -s INVITE_CODE_INPUT
  fi
  echo
  if [ -n "$INVITE_CODE_INPUT" ]; then
    INVITE_CODE="$INVITE_CODE_INPUT"
    echo "$INVITE_CODE" > "$INVITE_CODE_FILE"
  fi
fi
if [ -z "$INVITE_CODE" ]; then
  echo "WARNING: no invite code set - anyone who knows the site token can register an account."
fi

git checkout -- texlyre/userdata.json 2>/dev/null || true
sed -e "s/__HOST_IP__/$HOST_IP/g" texlyre/userdata.server.json > texlyre/userdata.json
cp texlyre/userdata.json texlyre/userdata.local.json
echo "Server config: collab websocket = ws://$HOST_IP:$PORT_WS"
echo "Accounts: invite code ${INVITE_CODE:+set}${INVITE_CODE:-NOT SET - open registration}"

# ---- Build (full pipeline: generate:plugins + tsc + vite build) ----
BUILD_MARKER="texlyre/dist/.ltc-build-v7"
if [ ! -d "texlyre/dist" ] || [ ! -f "$BUILD_MARKER" ]; then
  echo "Building TeXlyre (generate plugins + typecheck + bundle)..."
  (cd texlyre && npm run build:local)
  touch "$BUILD_MARKER"
fi

# ---- Kill previous session ----
tmux kill-session -t "$SESSION" 2>/dev/null || true

# ---- Start services in tmux (command passed directly, no send-keys quoting) ----
tmux new-session -d -s "$SESSION" -n "texlyre" \
  "cd texlyre && node scripts/pm.cjs vite preview --port $PORT_HTTP --host 0.0.0.0 --strictPort"

sleep 1

tmux new-window -t "$SESSION" -n "yjs-ws" \
  "NODE_PATH=$PWD/texlyre/node_modules TERMINAL_TOKEN=$TERMINAL_TOKEN SITE_TOKEN=$SITE_TOKEN INVITE_CODE=$INVITE_CODE node server/yjs-ws-server.js $PORT_WS"

sleep 0.5

tmux new-window -t "$SESSION" -n "terminal" \
  "NODE_PATH=$PWD/texlyre/node_modules TERMINAL_TOKEN=$TERMINAL_TOKEN AUTH_MODE=session node server/terminal-server.js $PORT_TERM"

# ---- Keep crashed windows visible + self-heal ----
tmux set-option -t "$SESSION" remain-on-exit on
sleep 2

for attempt in 1 2; do
  WS_UP=$(ss -tln 2>/dev/null | grep -c ":$PORT_WS ")
  TERM_UP=$(ss -tln 2>/dev/null | grep -c ":$PORT_TERM ")
  if [ "$WS_UP" = "0" ] || [ "$TERM_UP" = "0" ]; then
    echo "  [heal] restarting dead services (attempt $attempt)..."
    tmux kill-window -t "$SESSION:yjs-ws" 2>/dev/null || true
    tmux kill-window -t "$SESSION:terminal" 2>/dev/null || true
    tmux new-window -t "$SESSION" -n "yjs-ws" \
      "NODE_PATH=$PWD/texlyre/node_modules TERMINAL_TOKEN=$TERMINAL_TOKEN SITE_TOKEN=$SITE_TOKEN INVITE_CODE=$INVITE_CODE node server/yjs-ws-server.js $PORT_WS"
    sleep 0.5
    tmux new-window -t "$SESSION" -n "terminal" \
      "NODE_PATH=$PWD/texlyre/node_modules TERMINAL_TOKEN=$TERMINAL_TOKEN AUTH_MODE=session node server/terminal-server.js $PORT_TERM"
    sleep 2
  fi
done

HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")

cat <<EOF

=== READY ===

  Web app:      http://$HOST_IP:$PORT_HTTP/texlyre/
  Yjs sync:     ws://$HOST_IP:$PORT_WS
  Terminal:     ws://$HOST_IP:$PORT_TERM

  Open the browser → click Terminal panel → run:  codex

  Site access token (web UI entry gate): ${SITE_TOKEN:+set (server/.site-token)}${SITE_TOKEN:-NOT SET - web UI is open to anyone}
  Accounts: invite code ${INVITE_CODE:+set (server/.invite-code)}${INVITE_CODE:-NOT SET - open registration}
  Manage accounts: node server/manage-users.js (create-user / list-users / share ...)

  Local agent (each user's own machine, optional):
    # on the user's machine (token = contents of server/.terminal-token):
    TERMINAL_TOKEN=<token> YJS_URL=http://$HOST_IP:$PORT_WS \
      node server/terminal-server.js 8085
    # browser auto-connects to ws://127.0.0.1:8085 first, falls back to server

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
