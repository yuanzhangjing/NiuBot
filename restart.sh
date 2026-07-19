#!/bin/sh
# Unix compatibility entry. The restart implementation lives in Node.js.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "${NODE_BINARY:-node}" "$SCRIPT_DIR/dist/restart-compat.js" "$@"
