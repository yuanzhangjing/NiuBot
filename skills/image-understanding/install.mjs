#!/usr/bin/env node
// image-understanding 安装器（幂等，跨平台 Node 脚本）：
// 检查 GEMINI_API_KEY 是否已配置，缺失时输出引导（NiuBot 无头服务不能交互，
// 提示通过日志呈现，用户把 key 写到 scripts/.env 即可）。
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const skillDir = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(skillDir, "scripts", ".env");

const key = process.env.GEMINI_API_KEY
  ?? (existsSync(envFile) ? readFileSync(envFile, "utf8").match(/^GEMINI_API_KEY=(.+)$/m)?.[1] : undefined);

if (!key) {
  console.log(`[image-understanding] GEMINI_API_KEY 未配置。请写入：${envFile}`);
  console.log("[image-understanding] 格式：GEMINI_API_KEY=你的key（示例见 SKILL.md）");
}
