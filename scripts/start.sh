#!/usr/bin/env bash
#
# start.sh — One-click launcher for LaTeX collaboration server.
#
# Usage:
#   cd /path/to/project && bash scripts/start.sh
#
# This script:
#   1. Does an initial build with latexmk.
#   2. Starts latexmk in continuous preview mode (watches for changes).
#   3. Starts a Python HTTP server on port 8766.
#
# All three run inside a single tmux session named "ltc".
# Detach with:  Ctrl+B, D
# Re-attach with: tmux attach -t ltc
#

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

PORT=${1:-8766}
SESSION="ltc"

echo "=== LaTeX Collaboration Server ==="
echo "Project : $PROJECT_DIR"
echo "Port    : $PORT"
echo ""

# ---- Step 1: Initial build ----
echo "[1/3] Initial LaTeX build..."
latexmk -pdf -interaction=nonstopmode -f main.tex

# ---- Step 2: Start tmux session ----
echo "[2/3] Starting tmux session '$SESSION' ..."

tmux new-session -d -s "$SESSION" -n "latexmk" \; \
  send-keys "cd '$PROJECT_DIR'" Enter \
  send-keys "latexmk -pdf -pvc -interaction=nonstopmode -e '\$pdf_previewer=\"cat\";\$pvc_view_file=0;' main.tex" Enter

tmux new-window -t "$SESSION" -n "http" \; \
  send-keys "cd '$PROJECT_DIR'" Enter \
  send-keys "python3 scripts/httpserver.py $PORT --dir \"$PROJECT_DIR\"" Enter

# ---- Step 3: Print instructions ----
echo "[3/3] Services running in tmux session '$SESSION'"

HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")

cat <<EOF

=== READY ===

  Local URL:      http://localhost:${PORT}/main.pdf
  Network URL:    http://${HOST_IP}:${PORT}/main.pdf  (if firewall permits)

  tmux commands:
    Attach : tmux attach -t ${SESSION}
    Detach : Ctrl+B, D
    Kill   : tmux kill-session -t ${SESSION}

  To share this port via VS Code Live Share:
    1. Open VS Code
    2. Open the Command Palette (Ctrl+Shift+P)
    3. Run "Live Share: Share Ports"
    4. Add port ${PORT}
    5. Send the Live Share invite link to Guests
    6. Guests open http://localhost:${PORT}/main.pdf in their browser

EOF
