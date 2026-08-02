---
name: ocr
description: 系统原生 OCR（macOS Vision / Windows.Media.Ocr）。零依赖、离线、纯文字提取。后端不支持多模态或需要确定性文字提取时使用。
---

# OCR

调用操作系统自带的 OCR 引擎提取图片文字。零安装、零依赖、离线可用、不产生费用。

## 何时使用

- 收到图片，只需要提取里面的**文字**（不需要理解语义）
- 无网络 / 视觉 API 不可用时的兜底
- 需要快速、确定性的文字提取

## 用法

### macOS（Vision 框架）

```bash
xcrun swift .claude/skills/ocr/scripts/macos_ocr.swift <图片路径>
```

输出格式：`[置信度] 文字`，每行一个识别结果。支持中英文。

### Windows（Windows.Media.Ocr）

```powershell
powershell -ExecutionPolicy Bypass -File .claude/skills/ocr/scripts/windows_ocr.ps1 <图片路径>
```

输出格式：`[行号] 文字`。需要系统装有对应语言包（中文版系统自带）。

## 返回值

纯文本行列表（带行号/置信度），**没有语义理解**，不做内容组织。

## 限制

- 只识别文字，不理解图片内容、不整理表格
- 需要语义理解时用 `image-understanding` 技能
