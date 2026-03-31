#!/bin/bash
pkill -f "tsx src/index.ts" 2>/dev/null
sleep 1
cd "$(dirname "$0")"
NIUBOT_LOG_LEVEL=${NIUBOT_LOG_LEVEL:-debug} npm run dev
