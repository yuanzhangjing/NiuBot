#!/bin/bash
# restart.sh — Safe restart for NiuBot with health check and rollback
# Usage: Called by /restart command with env vars:
#   NIUBOT_BOT_NAME, NIUBOT_CHAT_ID, NIUBOT_API_SOCKET, NIUBOT_HOME
#
# Flow: build → preflight (verify new code) → stop old → start new → health check → rollback on failure → notify
set -eo pipefail

# Block agent sessions from running this script directly.
# Only the /restart Feishu builtin command (which sets NIUBOT_INTERNAL_RESTART=1)
# or an interactive terminal are allowed.
if [ "${NIUBOT_INTERNAL_RESTART:-}" != "1" ] && [ ! -t 0 ]; then
    echo "Error: restart.sh cannot be run from an agent session." >&2
    echo "Use the /restart command in Feishu instead." >&2
    exit 1
fi

# Auto-detach: re-exec in background so the caller can exit safely.
# Skip if already detached (RESTART_DETACHED=1) or if --no-detach is passed.
if [ "$1" = "--no-detach" ]; then
    shift
elif [ "${RESTART_DETACHED:-}" != "1" ]; then
    if [ -z "${NIUBOT_HOME:-}" ]; then
        echo "Error: NIUBOT_HOME is not set." >&2
        exit 1
    fi
    LOG_DIR="$NIUBOT_HOME/logs"
    mkdir -p "$LOG_DIR"
    RESTART_DETACHED=1 perl -e 'use POSIX "setsid"; setsid(); exec @ARGV' bash "$0" "$@" >> "$LOG_DIR/restart-debug.log" 2>&1 &
    echo "restart detached (pid=$!)"
    echo "  debug log: $LOG_DIR/restart-debug.log"
    echo "  service log: $LOG_DIR/niubot-$(date '+%Y-%m-%d').log"
    exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOT_NAME="${NIUBOT_BOT_NAME:-NiuBot}"
CHAT_ID="${NIUBOT_CHAT_ID:-}"
if [ -z "${NIUBOT_HOME:-}" ]; then
    echo "Error: NIUBOT_HOME is not set." >&2
    exit 1
fi
export NIUBOT_HOME
SOCKET_PATH="${NIUBOT_API_SOCKET:-$NIUBOT_HOME/$BOT_NAME/api.sock}"
LOG_DIR="$NIUBOT_HOME/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/niubot-$(date '+%Y-%m-%d').log"
DEBUG_LOG="$LOG_DIR/restart-debug.log"

DIST_DIR="$SCRIPT_DIR/dist"
BACKUP_DIR="$SCRIPT_DIR/dist.bak"

HEALTH_TIMEOUT=15
HEALTH_INTERVAL=1
PREFLIGHT_TIMEOUT=20
PREFLIGHT_SOCKET="$NIUBOT_HOME/$BOT_NAME/api.sock.preflight"

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

# Preflight: start new code with --preflight, verify it can init successfully
# without stopping the old process. Returns 0 if preflight passes.
run_preflight() {
    debug "preflight: starting new code with --preflight..."
    rm -f "$PREFLIGHT_SOCKET"

    # Run preflight in background, capture PID
    NIUBOT_LOG_LEVEL="${NIUBOT_LOG_LEVEL:-info}" node dist/index.js --preflight >> "$LOG_FILE" 2>&1 &
    local preflight_pid=$!
    debug "preflight: PID=$preflight_pid"

    local elapsed=0
    while [ "$elapsed" -lt "$PREFLIGHT_TIMEOUT" ]; do
        # Check if process already exited
        if ! kill -0 "$preflight_pid" 2>/dev/null; then
            wait "$preflight_pid" 2>/dev/null
            local exit_code=$?
            if [ "$exit_code" -eq 0 ]; then
                debug "preflight: passed (exit code 0, ${elapsed}s)"
                rm -f "$PREFLIGHT_SOCKET"
                return 0
            else
                debug "preflight: FAILED (exit code $exit_code)"
                rm -f "$PREFLIGHT_SOCKET"
                return 1
            fi
        fi

        sleep "$HEALTH_INTERVAL"
        elapsed=$((elapsed + HEALTH_INTERVAL))
        debug "  preflight: waiting... ($elapsed/${PREFLIGHT_TIMEOUT})"
    done

    # Timed out — kill preflight process
    debug "preflight: TIMEOUT, killing PID $preflight_pid"
    kill -9 "$preflight_pid" 2>/dev/null || true
    rm -f "$PREFLIGHT_SOCKET"
    return 1
}

# ──────── Main ────────
echo "" > "$DEBUG_LOG"
debug "=== restart.sh started ==="
debug "PID=$$, BOT=$BOT_NAME, CHAT=$CHAT_ID"

# Let the "正在重启..." message get delivered
sleep 2

cd "$SCRIPT_DIR"

# ── Detect mode: dev (has src/) vs production (npm global install) ──
DEV_MODE=false
if [ -d "$SCRIPT_DIR/src" ]; then
    DEV_MODE=true
fi

if $DEV_MODE; then
    # ── Dev mode: build → backup → restart → health check → rollback on failure ──

    debug "dev mode: building..."
    if ! npm run build >> "$DEBUG_LOG" 2>&1; then
        debug "build FAILED, old process unaffected"
        notify "重启失败：构建错误，当前服务不受影响。"
        debug "=== restart.sh done (build failed) ==="
        exit 1
    fi
    debug "build done"

    # Ensure global CLI symlink matches current build
    npm link --silent >> "$DEBUG_LOG" 2>&1 || debug "npm link skipped"
    debug "npm link done"

    # Backup current dist (known-good)
    if [ -d "$DIST_DIR" ]; then
        rm -rf "$BACKUP_DIR"
        cp -r "$DIST_DIR" "$BACKUP_DIR"
        debug "dist backed up to dist.bak"
    fi

    # Preflight: verify new code can start before killing old process
    if ! run_preflight; then
        debug "preflight FAILED, old process unaffected"
        # Rollback dist if we have backup
        if [ -d "$BACKUP_DIR" ]; then
            rm -rf "$DIST_DIR"
            mv "$BACKUP_DIR" "$DIST_DIR"
            debug "dist restored from backup after preflight failure"
        fi
        notify "重启失败：新版本预检不通过，当前服务不受影响。"
        debug "=== restart.sh done (preflight failed) ==="
        exit 1
    fi
    debug "preflight passed, safe to switch"

    stop_service
    start_service

    if check_health; then
        sleep 1
        rm -rf "$BACKUP_DIR"
        notify "重启成功。"
        debug "=== restart.sh done (success) ==="
        exit 0
    fi

    # Failed — rollback to backup
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
else
    # ── Production mode: preflight → restart (no build, no rollback) ──

    debug "production mode: preflight..."
    if ! run_preflight; then
        debug "preflight FAILED, old process unaffected"
        notify "重启失败：预检不通过，当前服务不受影响。"
        debug "=== restart.sh done (preflight failed) ==="
        exit 1
    fi
    debug "preflight passed, restarting..."

    stop_service
    start_service

    if check_health; then
        sleep 1
        notify "重启成功。"
        debug "=== restart.sh done (success) ==="
        exit 0
    fi

    notify "重启失败，请检查日志: $LOG_FILE"
    debug "=== restart.sh done (failed) ==="
    exit 1
fi
