#!/bin/bash
# start.sh — Dev cold start for NiuBot (build + launch + health check)
# Usage: NIUBOT_HOME=~/.niubot bash start.sh
#   --no-build    Skip the build step (use existing dist/)
#   --foreground  Run in foreground (don't detach, logs to stdout)
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOT_NAME="${NIUBOT_BOT_NAME:-NiuBot}"
if [ -z "${NIUBOT_HOME:-}" ]; then
    echo "Error: NIUBOT_HOME is not set." >&2
    exit 1
fi
export NIUBOT_HOME
SOCKET_PATH="$NIUBOT_HOME/$BOT_NAME/api.sock"
PID_FILE="$NIUBOT_HOME/niubot.pid"
LOG_DIR="$NIUBOT_HOME/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/niubot-$(date '+%Y-%m-%d').log"

HEALTH_TIMEOUT=15
HEALTH_INTERVAL=1

DO_BUILD=true
FOREGROUND=false

for arg in "$@"; do
    case "$arg" in
        --no-build)   DO_BUILD=false ;;
        --foreground) FOREGROUND=true ;;
        *) echo "Unknown option: $arg"; exit 1 ;;
    esac
done

# ── Check if already running ──
if [ -f "$PID_FILE" ]; then
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
        echo "NiuBot is already running (PID $pid)."
        echo "Use restart.sh to restart, or stop first."
        exit 1
    fi
    rm -f "$PID_FILE"
fi

# ── Build ──
if $DO_BUILD; then
    echo "Building..."
    cd "$SCRIPT_DIR"
    if ! npm run build; then
        echo "Build failed."
        exit 1
    fi
    echo "Build done."

fi

# ── Start ──
cd "$SCRIPT_DIR"

if $FOREGROUND; then
    echo "Starting in foreground (Ctrl+C to stop)..."
    echo "  Log: stdout"
    NIUBOT_LOG_LEVEL="${NIUBOT_LOG_LEVEL:-info}" exec node dist/index.js
fi

echo "Starting..."
NIUBOT_LOG_LEVEL="${NIUBOT_LOG_LEVEL:-info}" nohup node dist/index.js >> "$LOG_FILE" 2>&1 &
echo "$!" > "$PID_FILE"
echo "Process started (PID $!)"
echo "  Log: $LOG_FILE"

# ── Health check ──
elapsed=0
while [ "$elapsed" -lt "$HEALTH_TIMEOUT" ]; do
    sleep "$HEALTH_INTERVAL"
    elapsed=$((elapsed + HEALTH_INTERVAL))

    if curl -s --max-time 2 --unix-socket "$SOCKET_PATH" http://localhost/ping > /dev/null 2>&1; then
        echo "Health check passed (${elapsed}s)."
        echo ""
        echo "NiuBot is running."
        exit 0
    fi

    if tail -20 "$LOG_FILE" 2>/dev/null | grep -qi "fatal\|panic\|unhandled"; then
        echo "Fatal error detected. Check log: $LOG_FILE"
        exit 1
    fi
done

echo "Health check timed out (${HEALTH_TIMEOUT}s). Check log: $LOG_FILE"
exit 1
