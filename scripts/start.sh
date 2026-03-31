#!/bin/bash
# NiuBot start script: kill old process + start new one
# PID file and logs stored in NIUBOT_HOME (default ~/.niubot)
# Logs: niubot-YYYY-MM-DD.log, auto-cleanup files older than 7 days

NIUBOT_HOME="${NIUBOT_HOME:-$HOME/.niubot}"
PID_FILE="$NIUBOT_HOME/niubot.pid"
LOG_DIR="$NIUBOT_HOME/logs"
LOG_FILE="$LOG_DIR/niubot-$(date '+%Y-%m-%d').log"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

mkdir -p "$LOG_DIR"

# Clean up logs older than 7 days
find "$LOG_DIR" -name "niubot-*.log" -mtime +7 -delete 2>/dev/null

# Kill old process if running
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Stopping old process (PID $OLD_PID)..." | tee -a "$LOG_FILE"
    kill "$OLD_PID"
    # Wait up to 5s for graceful shutdown
    for i in $(seq 1 10); do
      kill -0 "$OLD_PID" 2>/dev/null || break
      sleep 0.5
    done
    # Force kill if still alive
    if kill -0 "$OLD_PID" 2>/dev/null; then
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] Force killing PID $OLD_PID" | tee -a "$LOG_FILE"
      kill -9 "$OLD_PID"
    fi
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Old process stopped" | tee -a "$LOG_FILE"
  else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] PID file found but process $OLD_PID not running, cleaning up" | tee -a "$LOG_FILE"
  fi
  rm -f "$PID_FILE"
fi

# Start new process
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting NiuBot..." | tee -a "$LOG_FILE"
cd "$SCRIPT_DIR"
nohup npx tsx src/index.ts >> "$LOG_FILE" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] NiuBot started (PID $NEW_PID, log: $LOG_FILE)" | tee -a "$LOG_FILE"
