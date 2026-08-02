---
name: image-understanding
description: 图片视觉理解（Gemini API）。后端不支持多模态时补"看"的能力——理解内容、整理表格、回答图片相关问题。
---

# Image Understanding

用 Google Gemini API 分析图片。当会话模型不支持视觉输入时，用这个技能补上"看"的能力——不只是认字，还能理解内容、整理表格、回答图片相关问题。

## 何时使用

- 收到图片，需要知道图片内容
- 截图、票据、表格、图表、照片的文字提取和内容理解
- 需要语义理解（整理表格、概括场景、回答问题）
- 用户明确要求"看懂"图片

## 用法

```bash
# 基本用法（默认提示词：详细描述图片）
bash skills/image-understanding/scripts/gemini_vision.sh <图片路径>

# 指定提示词（提示词决定注意力，问什么答什么）
bash skills/image-understanding/scripts/gemini_vision.sh <图片路径> "请提取图中所有文字"
bash skills/image-understanding/scripts/gemini_vision.sh <图片路径> "图里有几个指示牌？各自写了什么"

# 一次看多张图
bash skills/image-understanding/scripts/gemini_vision.sh <图片路径1> "描述这张图" <图片路径2> "描述这张图"
```

## 返回值

Gemini 返回的文本（可能包含 Markdown 表格）。失败时输出错误信息。

## 配置

- **API Key 走环境变量**：在 `~/.niubot/.env` 写 `GEMINI_API_KEY=xxx`（NiuBot 启动时 dotenv 加载，Agent 会话子进程自动继承）
- 技能目录是纯只读的（每次启动从包内重建），**不要把 key 放技能目录里**
- 免费额度有限，调用频繁时注意限流
- 模型：`gemini-flash-latest`（免费层）

## 限制

- 单图最大约 12MB（base64 后更大）
- 需要联网
- 不返回坐标信息（纯语义理解）

## 与 ocr 的关系

- `image-understanding`：云端语义理解（主力，需要 key）
- `ocr`：本地纯文字提取（兜底，离线可用）
