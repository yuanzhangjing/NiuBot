#!/bin/bash
# Gemini 视觉分析工具
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 用法: ./gemini_vision.sh <图片路径> [提示词]
set -e
IMG="$1"
PROMPT="${2:-请详细描述这张图片的内容，包括所有文字、数字和视觉元素}"

[ -f "$IMG" ] || { echo "错误: 图片不存在: $IMG"; exit 1; }

MIME=$(file -b --mime-type "$IMG" | sed 's/x-//')
B64=$(base64 -i "$IMG")
# API Key 不内置：优先 .env（本地配置，gitignore 排除），其次环境变量 GEMINI_API_KEY
if [ -f .env ]; then
  KEY=$(grep '^GEMINI_API_KEY=' .env | head -1 | cut -d= -f2-)
else
  KEY="${GEMINI_API_KEY:-}"
fi
if [ -z "$KEY" ]; then
  echo "错误: 未配置 GEMINI_API_KEY（skills/image-understanding/scripts/.env 或环境变量）" >&2
  exit 1
fi

curl -s "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent" \
  -H 'Content-Type: application/json' \
  -H "X-goog-api-key: $KEY" \
  -d "{\"contents\":[{\"parts\":[{\"text\":$(echo "$PROMPT" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')},{\"inline_data\":{\"mime_type\":\"$MIME\",\"data\":\"$B64\"}}]}]}" \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('candidates',[{}])[0].get('content',{}).get('parts',[{}])[0].get('text','(无结果)'))"
