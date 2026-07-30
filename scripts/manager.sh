#!/usr/bin/env bash
#
# manager.sh — Multi-project LTC manager.
#
# Manages multiple LaTeX projects under a base directory.
# Each project must contain a main.tex.  A unique HTTP port
# is auto-assigned starting from BASE_PORT.
#
# Usage:
#   manager.sh <base-dir> status                    # show all projects
#   manager.sh <base-dir> start                     # start all projects
#   manager.sh <base-dir> start <project>           # start one project
#   manager.sh <base-dir} stop                      # stop all
#   manager.sh <base-dir> stop <project>            # stop one
#   manager.sh <base-dir> restart [project]         # restart
#

set -euo pipefail

# ---- Dependency check ----
if ! command -v tmux &>/dev/null; then
    echo "ERROR: tmux is required but not installed."
    echo "  Install it:  sudo apt install tmux   (Debian/Ubuntu)"
    echo "               sudo yum install tmux   (RHEL/CentOS)"
    exit 1
fi

BASE_DIR="$(cd "$1" 2>/dev/null && pwd)" || {
    echo "Usage: $0 <base-dir> {status|start|stop|restart} [project]"
    exit 1
}
CMD="${2:-status}"
FILTER="${3:-}"
BASE_PORT=8761
SESSION="ltc"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ---- Discover projects ----
find_projects() {
    local projects=()
    for dir in "$BASE_DIR"/*/; do
        [ -f "$dir/main.tex" ] || continue
        local name
        name=$(basename "$dir")
        # Honour optional port override
        local port=$BASE_PORT
        [ -f "$dir/.ltc" ] && port=$(grep -i "^PORT=" "$dir/.ltc" 2>/dev/null | cut -d= -f2) || true
        projects+=("$name:$dir:$port")
    done
    # Sort by name
    IFS=$'\n' projects=($(sort <<<"${projects[*]}")); unset IFS
    echo "${projects[@]}"
}

# ---- Per-project actions ----
start_project() {
    local name="$1" dir="$2" port="$3"
    local win="${SESSION}:${name}"

    if tmux has-session -t "$win" 2>/dev/null; then
        echo "  [SKIP] $name — already running (port $port)"
        return
    fi

    echo "  [START] $name → port $port"

    # Create window with two panes: latexmk | http
    tmux new-window -t "$SESSION" -n "$name" -d
    tmux send-keys -t "$win" "cd '$dir'" Enter

    # Pane 0: latexmk -pvc
    tmux send-keys -t "$win" \
        "latexmk -pdf -pvc -interaction=nonstopmode \
         -e '\$pdf_previewer=\"cat\";\$pvc_view_file=0;' main.tex" Enter

    # Pane 1: HTTP server — split vertically
    tmux split-window -t "$win" -v -l 8
    tmux send-keys -t "${win}.1" "cd '$dir'" Enter
    tmux send-keys -t "${win}.1" \
        "python3 '${SCRIPT_DIR}/httpserver.py' $port --dir '$dir'" Enter
}

stop_project() {
    local name="$1"
    local win="${SESSION}:${name}"

    if tmux has-session -t "$win" 2>/dev/null; then
        echo "  [STOP] $name"
        tmux kill-window -t "$win"
    else
        echo "  [SKIP] $name — not running"
    fi
}

status_project() {
    local name="$1" dir="$2" port="$3"
    local win="${SESSION}:${name}"
    local pid=""

    if tmux has-session -t "$win" 2>/dev/null; then
        pid="$(tmux list-panes -t "$win" -F '#{pane_pid}' 2>/dev/null | head -1)"
        echo "  $name    RUNNING    http://localhost:$port/    (tmux: $win)"
    else
        echo "  $name    STOPPED    (config port: $port)"
    fi
}

# ---- Main ----
IFS=' ' read -ra PROJECTS <<< "$(find_projects)"

case "$CMD" in
    status)
        echo "=== LTC Manager — $BASE_DIR ==="
        echo ""
        for p in "${PROJECTS[@]}"; do
            IFS=':' read -r n d pt <<< "$p"
            status_project "$n" "$d" "$pt"
        done
        ;;

    start)
        # Create the tmux session if it doesn't exist
        if ! tmux has-session -t "$SESSION" 2>/dev/null; then
            tmux new-session -d -s "$SESSION" -n "_bootstrap"
        fi

        echo "=== Starting projects in $BASE_DIR ==="
        for p in "${PROJECTS[@]}"; do
            IFS=':' read -r n d pt <<< "$p"
            if [ -n "$FILTER" ] && [ "$n" != "$FILTER" ]; then
                continue
            fi
            start_project "$n" "$d" "$pt"
        done

        # Kill the bootstrap window only AFTER real project windows exist
        tmux kill-window -t "${SESSION}:_bootstrap" 2>/dev/null || true

        echo ""
        echo "Use: tmux attach -t $SESSION"
        echo "     tmux detach: Ctrl+B, D"
        echo "     $0 $BASE_DIR status"
        ;;

    stop)
        echo "=== Stopping projects in $BASE_DIR ==="
        if [ -n "$FILTER" ]; then
            stop_project "$FILTER"
        else
            for p in "${PROJECTS[@]}"; do
                IFS=':' read -r n d pt <<< "$p"
                stop_project "$n"
            done
            # Kill the session if no windows left
            tmux kill-session -t "$SESSION" 2>/dev/null || true
        fi
        ;;

    restart)
        echo "=== Restarting projects in $BASE_DIR ==="
        if [ -n "$FILTER" ]; then
            stop_project "$FILTER"
            for p in "${PROJECTS[@]}"; do
                IFS=':' read -r n d pt <<< "$p"
                [ "$n" = "$FILTER" ] && start_project "$n" "$d" "$pt"
            done
        else
            for p in "${PROJECTS[@]}"; do
                IFS=':' read -r n d pt <<< "$p"
                stop_project "$n"
            done
            for p in "${PROJECTS[@]}"; do
                IFS=':' read -r n d pt <<< "$p"
                start_project "$n" "$d" "$pt"
            done
        fi
        ;;

    *)
        echo "Unknown command: $CMD"
        echo "Usage: $0 <base-dir> {status|start|stop|restart} [project]"
        exit 1
        ;;
esac
