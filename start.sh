#!/bin/sh
# Unix development compatibility entry. Service management lives in Node.js.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DO_BUILD=1
FOREGROUND=0
RESTART=0

for arg in "$@"; do
  case "$arg" in
    --no-build) DO_BUILD=0 ;;
    --foreground) FOREGROUND=1 ;;
    --restart) RESTART=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

if [ "$DO_BUILD" -eq 1 ]; then
  (cd "$SCRIPT_DIR" && npm run build)
fi

if [ "$FOREGROUND" -eq 1 ]; then
  exec "${NODE_BINARY:-node}" "$SCRIPT_DIR/dist/index.js"
fi

if [ "$RESTART" -eq 1 ]; then
  exec "${NODE_BINARY:-node}" "$SCRIPT_DIR/dist/user-cli.js" start --restart
fi
exec "${NODE_BINARY:-node}" "$SCRIPT_DIR/dist/user-cli.js" start
