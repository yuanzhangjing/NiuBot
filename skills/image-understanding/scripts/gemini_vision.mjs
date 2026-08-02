#!/usr/bin/env node
// Gemini 视觉分析（跨平台：Node 运行时有保证，不依赖 bash/curl）
// 用法: node gemini_vision.mjs <图片路径> [提示词]
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const [img, ...rest] = process.argv.slice(2);
// 提示词 = 剩余参数 join（多词不用引号也完整），空则用默认
const prompt = (rest.join(" ") || "请详细描述这张图片的内容，包括所有文字、数字和视觉元素").trim();

if (!img || !existsSync(img)) {
  console.error(`错误: 图片不存在: ${img}`);
  process.exit(1);
}

// API Key 不内置：优先技能目录 scripts/.env，其次环境变量 GEMINI_API_KEY
const envFile = path.join(scriptDir, ".env");
let key = existsSync(envFile)
  ? readFileSync(envFile, "utf8").match(/^GEMINI_API_KEY=(.+)$/m)?.[1]?.trim()
  : undefined;
key = key ?? process.env.GEMINI_API_KEY;
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
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
};
const mime = MIME_BY_EXT[path.extname(img).toLowerCase()];
if (!mime) {
  console.error(`错误: 不支持的图片格式: ${img}（支持 png/jpg/webp/gif/bmp/heic/tif/svg/pdf）`);
  process.exit(1);
}
const b64 = readFileSync(img).toString("base64");

let res;
try {
  res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: b64 } }] }],
      }),
      // 网络黑洞保护：30s 超时（连接静默丢弃时避免永久挂起）
      signal: AbortSignal.timeout(30_000),
    },
  );
} catch (err) {
  console.error(`错误: 请求失败（网络问题或超时）: ${err.message ?? err}`);
  process.exit(1);
}
const data = await res.json().catch(() => null);
if (!res.ok || !data) {
  const apiError = data?.error?.message ?? `HTTP ${res.status}`;
  console.error(`错误: Gemini API 调用失败: ${apiError}`);
  process.exit(1);
}
console.log(data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "(无结果)");
