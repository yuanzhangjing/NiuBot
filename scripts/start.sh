#!/bin/sh
# Legacy development entry.
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export NIUBOT_HOME="${NIUBOT_HOME:-$HOME/.niubot-dev}"
exec "$SCRIPT_DIR/start.sh" --restart "$@"
