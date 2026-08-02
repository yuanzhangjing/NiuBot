#!/usr/bin/env node
// Gemini 视觉分析（跨平台：Node 运行时有保证，不依赖 bash/curl）
// 用法: node gemini_vision.mjs <图片路径> [提示词]
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const [img, ...rest] = process.argv.slice(2);
const prompt = rest[0] ?? "请详细描述这张图片的内容，包括所有文字、数字和视觉元素";

if (!img || !existsSync(img)) {
  console.error(`错误: 图片不存在: ${img}`);
  process.exit(1);
}

// API Key 不内置：优先技能目录 scripts/.env，其次环境变量 GEMINI_API_KEY
let key = process.env.GEMINI_API_KEY;
const envFile = path.join(scriptDir, ".env");
if (existsSync(envFile)) {
  const match = readFileSync(envFile, "utf8").match(/^GEMINI_API_KEY=(.+)$/m);
  if (match) key = match[1].trim();
}
if (!key) {
  console.error(`错误: 未配置 GEMINI_API_KEY（写入 ${envFile} 或设置环境变量）`);
  process.exit(1);
}

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".pdf": "application/pdf",
};
const mime = MIME_BY_EXT[path.extname(img).toLowerCase()] ?? "image/png";
const b64 = readFileSync(img).toString("base64");

const res = await fetch(
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent",
  {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: b64 } }] }],
    }),
  },
);
const data = await res.json();
console.log(data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "(无结果)");
