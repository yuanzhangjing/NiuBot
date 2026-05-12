#!/bin/bash
# restart.sh — Safe restart for NiuBot with health check and rollback
# Usage: Called by /restart command with env vars:
#   NIUBOT_BOT_NAME, NIUBOT_CHAT_ID, NIUBOT_API_SOCKET, NIUBOT_HOME
#
# Flow: build package → prepare release → preflight → stop old → start candidate → health check → commit LKG / rollback
set -eo pipefail

# Block agent sessions from running this script directly.
# Agent processes have NIUBOT_AGENT_SESSION set in their environment.
if [ -n "${NIUBOT_AGENT_SESSION:-}" ]; then
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
SCRIPT_DIR_REAL="$(cd "$SCRIPT_DIR" && pwd -P)"
SOURCE_DIR="${NIUBOT_SOURCE_DIR:-$SCRIPT_DIR}"
SOURCE_DIR_REAL="$(cd "$SOURCE_DIR" && pwd -P)"
BOT_NAME="${NIUBOT_BOT_NAME:-NiuBot}"
CHAT_ID="${NIUBOT_RESTART_NOTIFY_CHAT_ID:-}"
if [ -z "${NIUBOT_HOME:-}" ]; then
    echo "Error: NIUBOT_HOME is not set." >&2
    exit 1
fi
export NIUBOT_HOME
SOCKET_PATH="${NIUBOT_API_SOCKET:-$NIUBOT_HOME/$BOT_NAME/api.sock}"
LOG_DIR="$NIUBOT_HOME/logs"
BOT_DIR="$NIUBOT_HOME/$BOT_NAME"
RELEASES_DIR="$BOT_DIR/releases"
PACKAGES_DIR="$BOT_DIR/packages"
RESTART_DIR="$BOT_DIR/restart"
CURRENT_LINK="$BOT_DIR/current"
PREVIOUS_LINK="$BOT_DIR/previous"
LKG_LINK="$BOT_DIR/last-known-good"
mkdir -p "$LOG_DIR" "$RELEASES_DIR" "$PACKAGES_DIR" "$RESTART_DIR"
RELEASES_DIR_REAL="$(cd "$RELEASES_DIR" && pwd -P)"
LOG_FILE="$LOG_DIR/niubot-$(date '+%Y-%m-%d').log"
DEBUG_LOG="$LOG_DIR/restart-debug.log"

# Unset session-specific env vars so they don't leak into the new daemon
# or its agent subprocesses. BOT_NAME / CHAT_ID / SOCKET_PATH are captured
# above before we unset them, so the rest of this script is unaffected.
unset NIUBOT_CHAT_ID NIUBOT_API_SOCKET NIUBOT_RESTART_NOTIFY_CHAT_ID

DIST_DIR="$SOURCE_DIR_REAL/dist"

HEALTH_TIMEOUT=15
HEALTH_INTERVAL=1
PREFLIGHT_TIMEOUT=20
PREFLIGHT_SOCKET="$NIUBOT_HOME/$BOT_NAME/api.sock.preflight"

debug() { echo "[$(date '+%H:%M:%S')] $*" >> "$DEBUG_LOG"; }

resolve_release_link() {
    local link="$1"
    if [ -e "$link" ] || [ -L "$link" ]; then
        (cd "$link" 2>/dev/null && pwd -P) || true
    fi
}

set_release_link() {
    local link="$1"
    local target="$2"
    rm -f "$link"
    ln -s "$target" "$link"
}

release_package_dir() {
    echo "$1/package"
}

notify() {
    if [ -z "$CHAT_ID" ]; then return; fi
    debug "notify: '$1'"
    curl -s --unix-socket "$SOCKET_PATH" \
        -X POST http://localhost/send \
        -H "Content-Type: application/json" \
        -d "{\"chat_id\":\"$CHAT_ID\",\"text\":\"$1\"}" >> "$DEBUG_LOG" 2>&1 || true
}

find_service_pids() {
    ps -eo pid=,command= | while read -r pid command; do
        if [ -z "$pid" ] || [ -z "$command" ]; then
            continue
        fi
        case "$command" in
            *"node dist/index.js"*|*"tsx src/index.ts"*)
                case "$command" in
                    *"pkill"*|*"pgrep"*|*"restart.sh"*) ;;
                    *)
                        local cwd
                        cwd="$(process_cwd "$pid" || true)"
                        if [ "$cwd" = "$SOURCE_DIR_REAL" ] || [ "$cwd" = "$SCRIPT_DIR_REAL" ]; then
                            echo "$pid"
                        elif [[ "$cwd" == "$RELEASES_DIR_REAL"/*/package ]]; then
                            echo "$pid"
                        else
                            debug "skip PID $pid from scan: cwd=${cwd:-unknown}"
                        fi
                        ;;
                esac
                ;;
        esac
    done
}

process_cwd() {
    local pid="$1"
    if [ -e "/proc/$pid/cwd" ]; then
        (cd "/proc/$pid/cwd" 2>/dev/null && pwd -P)
        return
    fi
    if command -v lsof >/dev/null 2>&1; then
        local cwd
        cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"
        if [ -n "$cwd" ]; then
            (cd "$cwd" 2>/dev/null && pwd -P)
        fi
    fi
}

kill_service_pids() {
    local signal="$1"
    local pids
    pids="$(find_service_pids || true)"
    if [ -z "$pids" ]; then
        return 1
    fi
    echo "$pids" | while read -r pid; do
        if [ -n "$pid" ]; then
            debug "killing PID $pid (from process scan, signal=$signal)"
            kill "-$signal" "$pid" 2>/dev/null || true
        fi
    done
    return 0
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

    # 兜底：扫描真实服务 PID。不要用 pkill -f；pkill 的 argv 本身可能匹配模式并中断脚本。
    if [ -z "$target_pid" ]; then
        debug "no PID file, scanning service processes"
        kill_service_pids TERM || debug "no matching service processes found"
    fi

    # 等待进程退出（最多 10s）
    local wait=0
    while [ "$wait" -lt 10 ]; do
        local still_alive=false
        if [ -n "$target_pid" ] && kill -0 "$target_pid" 2>/dev/null; then
            still_alive=true
        elif [ -z "$target_pid" ]; then
            if [ -n "$(find_service_pids || true)" ]; then
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
        if [ -n "$(find_service_pids || true)" ]; then
            debug "force killing scanned service processes"
            kill_service_pids KILL || true
            sleep 1
        fi
    fi
    debug "process stopped"
}

start_service() {
    local package_dir="${1:-$SCRIPT_DIR_REAL}"
    debug "starting new process from $package_dir..."
    cd "$package_dir"
    NIUBOT_SOURCE_DIR="$SOURCE_DIR_REAL" NIUBOT_LOG_LEVEL="${NIUBOT_LOG_LEVEL:-info}" nohup node dist/index.js >> "$LOG_FILE" 2>&1 &
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
    local package_dir="${1:-$SCRIPT_DIR_REAL}"
    debug "preflight: starting new code with --preflight from $package_dir..."
    rm -f "$PREFLIGHT_SOCKET"

    # Run preflight in background, capture PID
    (cd "$package_dir" && NIUBOT_SOURCE_DIR="$SOURCE_DIR_REAL" NIUBOT_LOG_LEVEL="${NIUBOT_LOG_LEVEL:-info}" node dist/index.js --preflight >> "$LOG_FILE" 2>&1) &
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

bootstrap_last_known_good() {
    if [ -n "$(resolve_release_link "$LKG_LINK")" ]; then
        return 0
    fi
    if [ ! -d "$DIST_DIR" ]; then
        debug "no last-known-good and no dist to bootstrap"
        return 0
    fi

    local release_dir="$RELEASES_DIR/bootstrap-$(date '+%Y%m%d-%H%M%S')"
    local package_dir
    package_dir="$(release_package_dir "$release_dir")"
    mkdir -p "$package_dir"
    cp -R "$DIST_DIR" "$package_dir/dist"
    cp "$SOURCE_DIR_REAL/package.json" "$package_dir/package.json"
    if [ -d "$SOURCE_DIR_REAL/node_modules" ]; then
        ln -s "$SOURCE_DIR_REAL/node_modules" "$package_dir/node_modules"
    fi

    set_release_link "$CURRENT_LINK" "$release_dir"
    set_release_link "$LKG_LINK" "$release_dir"
    debug "bootstrapped last-known-good from current dist release=$release_dir"
}

build_candidate_release() {
    cd "$SOURCE_DIR_REAL"

    debug "dev mode: building..."
    if ! npm run build >> "$DEBUG_LOG" 2>&1; then
        debug "build FAILED, old process unaffected"
        return 1
    fi
    debug "build done"

    debug "pack check..."
    if ! npm run pack:check >> "$DEBUG_LOG" 2>&1; then
        debug "pack check FAILED, old process unaffected"
        return 1
    fi
    debug "pack check done"

    npm link --silent >> "$DEBUG_LOG" 2>&1 || debug "npm link skipped"
    debug "npm link done"

    local version
    local sha
    local release_id
    local release_dir
    local package_dir
    version="$(node -p "require('./package.json').version")"
    sha="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
    release_id="$(date '+%Y%m%d-%H%M%S')-${version}-${sha}"
    release_dir="$RELEASES_DIR/$release_id"
    package_dir="$(release_package_dir "$release_dir")"
    mkdir -p "$package_dir"

    debug "packing candidate release=$release_id"
    local pack_file
    pack_file="$(npm pack --pack-destination "$PACKAGES_DIR" 2>> "$DEBUG_LOG" | tail -n 1)"
    local pack_path="$PACKAGES_DIR/$pack_file"
    if [ ! -f "$pack_path" ]; then
        debug "npm pack FAILED: package not found path=$pack_path"
        return 1
    fi
    tar -xzf "$pack_path" -C "$package_dir" --strip-components=1

    debug "installing production dependencies for candidate..."
    if ! (cd "$package_dir" && npm install --omit=dev --no-audit --no-fund >> "$DEBUG_LOG" 2>&1); then
        debug "candidate dependency install FAILED"
        return 1
    fi
    debug "candidate release ready package_dir=$package_dir"

    echo "$release_dir"
}

cleanup_old_releases() {
    local current_release
    local previous_release
    local lkg_release
    current_release="$(resolve_release_link "$CURRENT_LINK")"
    previous_release="$(resolve_release_link "$PREVIOUS_LINK")"
    lkg_release="$(resolve_release_link "$LKG_LINK")"

    local kept=0
    find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d | sort -r | while read -r release_dir; do
        if [ "$release_dir" = "$current_release" ] || [ "$release_dir" = "$previous_release" ] || [ "$release_dir" = "$lkg_release" ]; then
            continue
        fi
        kept=$((kept + 1))
        if [ "$kept" -le 3 ]; then
            continue
        fi
        debug "removing old release $release_dir"
        rm -rf "$release_dir"
    done

    find "$PACKAGES_DIR" -mindepth 1 -maxdepth 1 -type f -name "*.tgz" | sort -r | tail -n +6 | while read -r package_file; do
        debug "removing old package $package_file"
        rm -f "$package_file"
    done
}

# ──────── Main ────────
echo "" > "$DEBUG_LOG"
debug "=== restart.sh started ==="
debug "PID=$$, BOT=$BOT_NAME, CHAT=$CHAT_ID"

# Let the "正在重启..." message get delivered
sleep 2

cd "$SOURCE_DIR_REAL"

# ── Detect mode: dev source available vs packaged runtime only ──
DEV_MODE=false
if [ -d "$SOURCE_DIR_REAL/src" ]; then
    DEV_MODE=true
fi

if $DEV_MODE; then
    # ── Dev mode: build package → release → preflight → switch → commit LKG / rollback ──

    bootstrap_last_known_good

    if ! candidate_release="$(build_candidate_release)"; then
        notify "重启失败：构建或打包错误，当前服务不受影响。"
        debug "=== restart.sh done (build/package failed) ==="
        exit 1
    fi
    candidate_package_dir="$(release_package_dir "$candidate_release")"

    # Preflight: verify new code can start before killing old process
    if ! run_preflight "$candidate_package_dir"; then
        debug "preflight FAILED, old process unaffected"
        notify "重启失败：新版本预检不通过，当前服务不受影响。"
        debug "=== restart.sh done (preflight failed) ==="
        exit 1
    fi
    debug "preflight passed, safe to switch"

    previous_release="$(resolve_release_link "$LKG_LINK")"
    if [ -n "$previous_release" ]; then
        set_release_link "$PREVIOUS_LINK" "$previous_release"
    fi
    set_release_link "$CURRENT_LINK" "$candidate_release"
    debug "current release switched candidate=$candidate_release previous=${previous_release:-none}"

    stop_service
    start_service "$candidate_package_dir"

    if check_health; then
        debug "candidate health check passed"
        sleep 1
        set_release_link "$LKG_LINK" "$candidate_release"
        debug "last-known-good updated release=$candidate_release"
        cleanup_old_releases
        notify "重启成功。"
        debug "=== restart.sh done (success) ==="
        exit 0
    fi

    # Failed — rollback to last-known-good
    debug "new version failed, rolling back..."
    stop_service

    rollback_release="$(resolve_release_link "$LKG_LINK")"
    if [ -n "$rollback_release" ]; then
        rollback_package_dir="$(release_package_dir "$rollback_release")"
        set_release_link "$CURRENT_LINK" "$rollback_release"
        debug "current release restored from last-known-good release=$rollback_release"

        start_service "$rollback_package_dir"
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
        debug "no last-known-good to rollback to"
        notify "重启失败，无 last-known-good 可回滚，请检查日志: $LOG_FILE"
        debug "=== restart.sh done (no last-known-good) ==="
        exit 1
    fi
else
    # ── Production mode: preflight → restart (no build, no rollback) ──

    debug "production mode: preflight..."
    if ! run_preflight "$SCRIPT_DIR_REAL"; then
        debug "preflight FAILED, old process unaffected"
        notify "重启失败：预检不通过，当前服务不受影响。"
        debug "=== restart.sh done (preflight failed) ==="
        exit 1
    fi
    debug "preflight passed, restarting..."

    stop_service
    start_service "$SCRIPT_DIR_REAL"

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
