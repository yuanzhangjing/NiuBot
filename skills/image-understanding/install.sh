#!/bin/bash
# image-understanding 安装器（幂等）：
# 检查 GEMINI_API_KEY 是否已配置，缺失时输出引导（NiuBot 无头服务不能交互，
# 提示通过日志呈现，用户把 key 写到 scripts/.env 即可）。
set -e
cd "$(dirname "$0")"

ENV_FILE="scripts/.env"

if [ -f "$ENV_FILE" ] && grep -q '^GEMINI_API_KEY=.\+' "$ENV_FILE"; then
  exit 0
fi

echo "[image-understanding] GEMINI_API_KEY 未配置。请把 key 写入：$(pwd)/$ENV_FILE"
echo "[image-understanding] 格式：GEMINI_API_KEY=你的key（示例见 SKILL.md）"
exit 0
