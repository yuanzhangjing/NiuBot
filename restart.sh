#!/bin/bash
# restart.sh — Safe restart for NiuBot with health check and rollback
# Usage: Called by /restart command with env vars:
#   NIUBOT_BOT_NAME, NIUBOT_CHAT_ID, NIUBOT_API_SOCKET, NIUBOT_HOME
#
# Flow: build → stop old → start new → health check → rollback to backup on failure → notify
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOT_NAME="${NIUBOT_BOT_NAME:-NiuBot}"
CHAT_ID="${NIUBOT_CHAT_ID:-}"
NIUBOT_HOME="${NIUBOT_HOME:-$HOME/.niubot}"
SOCKET_PATH="${NIUBOT_API_SOCKET:-$NIUBOT_HOME/$BOT_NAME/api.sock}"
LOG_FILE="/tmp/niubot.log"
DEBUG_LOG="/tmp/niubot-restart.log"

DIST_DIR="$SCRIPT_DIR/dist"
BACKUP_DIR="$SCRIPT_DIR/dist.bak"

HEALTH_TIMEOUT=15
HEALTH_INTERVAL=1

debug() { echo "[$(date '+%H:%M:%S')] $*" >> "$DEBUG_LOG"; }

notify() {
    if [ -z "$CHAT_ID" ]; then return; fi
    debug "notify: '$1'"
    curl -s --unix-socket "$SOCKET_PATH" \
        -X POST http://localhost/send \
        -H "Content-Type: application/json" \
        -d "{\"chat_id\":\"$CHAT_ID\",\"text\":\"$1\"}" >> "$DEBUG_LOG" 2>&1 || true
}

stop_service() {
    debug "stopping process..."
    local PID_FILE="$NIUBOT_HOME/niubot.pid"
    local target_pid=""

    # 优先从 PID 文件获取精确 PID
    if [ -f "$PID_FILE" ]; then
        target_pid=$(cat "$PID_FILE")
        if kill -0 "$target_pid" 2>/dev/null; then
            debug "killing PID $target_pid (from PID file)"
            kill -TERM "$target_pid" 2>/dev/null || true
        else
            debug "PID $target_pid not running, cleaning up PID file"
            target_pid=""
        fi
        rm -f "$PID_FILE"
    fi

    # 兜底：pkill 模式匹配（处理没有 PID 文件的情况）
    if [ -z "$target_pid" ]; then
        debug "no PID file, falling back to pkill"
        pkill -TERM -f "tsx src/index.ts" 2>/dev/null || true
        pkill -TERM -f "node dist/index.js" 2>/dev/null || true
    fi

    # 等待进程退出（最多 10s）
    local wait=0
    while [ "$wait" -lt 10 ]; do
        local still_alive=false
        if [ -n "$target_pid" ] && kill -0 "$target_pid" 2>/dev/null; then
            still_alive=true
        elif [ -z "$target_pid" ]; then
            if pgrep -f "tsx src/index.ts" > /dev/null 2>&1 || \
               pgrep -f "node dist/index.js" > /dev/null 2>&1; then
                still_alive=true
            fi
        fi
        if ! $still_alive; then break; fi
        sleep 1
        wait=$((wait + 1))
        debug "  waiting... ($wait/10)"
    done

    # 强制杀
    if [ -n "$target_pid" ] && kill -0 "$target_pid" 2>/dev/null; then
        debug "force killing PID $target_pid"
        kill -9 "$target_pid" 2>/dev/null || true
        sleep 1
    elif [ -z "$target_pid" ]; then
        if pgrep -f "tsx src/index.ts" > /dev/null 2>&1 || \
           pgrep -f "node dist/index.js" > /dev/null 2>&1; then
            debug "force killing via pkill"
            pkill -9 -f "tsx src/index.ts" 2>/dev/null || true
            pkill -9 -f "node dist/index.js" 2>/dev/null || true
            sleep 1
        fi
    fi
    debug "process stopped"
}

start_service() {
    debug "starting new process..."
    cd "$SCRIPT_DIR"
    NIUBOT_LOG_LEVEL="${NIUBOT_LOG_LEVEL:-info}" nohup node dist/index.js >> "$LOG_FILE" 2>&1 &
    debug "new process launched, PID=$!"
}

check_health() {
    debug "health check (timeout: ${HEALTH_TIMEOUT}s)..."
    local elapsed=0
    while [ "$elapsed" -lt "$HEALTH_TIMEOUT" ]; do
        sleep "$HEALTH_INTERVAL"
        elapsed=$((elapsed + HEALTH_INTERVAL))

        if curl -s --max-time 2 --unix-socket "$SOCKET_PATH" http://localhost/ping > /dev/null 2>&1; then
            debug "health check passed (${elapsed}s)"
            return 0
        fi

        if tail -20 "$LOG_FILE" 2>/dev/null | grep -qi "fatal\|panic\|unhandled"; then
            debug "fatal error detected"
            return 1
        fi

        debug "  attempt $elapsed/${HEALTH_TIMEOUT} — not ready"
    done

    debug "health check FAILED"
    return 1
}

# ──────── Main ────────
echo "" > "$DEBUG_LOG"
debug "=== restart.sh started ==="
debug "PID=$$, BOT=$BOT_NAME, CHAT=$CHAT_ID"

# Let the "正在重启..." message get delivered
sleep 2

cd "$SCRIPT_DIR"

# ── Build ──
debug "building..."
if ! npm run build >> "$DEBUG_LOG" 2>&1; then
    debug "build FAILED, old process unaffected"
    notify "重启失败：构建错误，当前服务不受影响。"
    debug "=== restart.sh done (build failed) ==="
    exit 1
fi
debug "build done"

# ── Backup current dist (known-good) ──
if [ -d "$DIST_DIR" ]; then
    rm -rf "$BACKUP_DIR"
    cp -r "$DIST_DIR" "$BACKUP_DIR"
    debug "dist backed up to dist.bak"
fi

# ── Stop old → Start new → Health check ──
stop_service
start_service

if check_health; then
    sleep 1
    rm -rf "$BACKUP_DIR"
    notify "重启成功。"
    debug "=== restart.sh done (success) ==="
    exit 0
fi

# ── Failed — rollback to backup ──
debug "new version failed, rolling back..."
stop_service

if [ -d "$BACKUP_DIR" ]; then
    rm -rf "$DIST_DIR"
    mv "$BACKUP_DIR" "$DIST_DIR"
    debug "dist restored from backup"

    start_service
    if check_health; then
        sleep 1
        notify "新版本启动失败，已回滚到上一版本。"
        debug "=== restart.sh done (rollback success) ==="
        exit 0
    fi

    # Rollback also failed
    debug "rollback also failed"
    notify "重启失败（回滚也失败），请检查日志: $LOG_FILE"
    debug "=== restart.sh done (rollback failed) ==="
    exit 1
else
    debug "no backup to rollback to"
    notify "重启失败，无备份可回滚，请检查日志: $LOG_FILE"
    debug "=== restart.sh done (no backup) ==="
    exit 1
fi
