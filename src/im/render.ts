/**
 * 统一消息渲染工具 — YAML 风格格式。
 * 被 adapter（merge_forward 内部渲染）和 pipeline（顶层消息格式化）共用。
 */
import type { MessageNode } from "./types.js";

/** 转义 YAML msg 值中的双引号、换行、反斜杠，保持单行格式 */
export function escapeYamlContent(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/**
 * 统一渲染 MessageNode 列表为 YAML 风格文本。
 * 规则：
 *   - 叶子消息 → - msg: "sender: content"
 *   - 转发组   → - forward: sender + messages 列表
 *   - 引用     → quoted 字段（同结构）
 */
export function renderMessageNodes(nodes: MessageNode[], depth: number): string {
  const lines: string[] = [];
  const indent = "  ".repeat(depth);

  for (const node of nodes) {
    if (lines.length > 0) lines.push("");

    if (node.contentType === "forward" && node.children) {
      // 转发组
      lines.push(`${indent}- forward: ${node.sender}`);
      if (node.quoted) {
        renderQuoted(node.quoted, depth + 1, lines);
      }
      lines.push(`${indent}  messages:`);
      lines.push(renderMessageNodes(node.children, depth + 2));
    } else {
      // 叶子消息
      const content = node.content ?? `[${node.contentType}]`;
      lines.push(`${indent}- msg: "${escapeYamlContent(node.sender)}: ${escapeYamlContent(content)}"`);
      if (node.quoted) {
        renderQuoted(node.quoted, depth + 1, lines);
      }
    }
  }

  return lines.join("\n");
}

/** 渲染 quoted 字段 */
function renderQuoted(node: MessageNode, depth: number, lines: string[]): void {
  const indent = "  ".repeat(depth);
  if (node.contentType === "forward" && node.children) {
    lines.push(`${indent}quoted:`);
    lines.push(`${indent}  forward: ${node.sender}`);
    lines.push(`${indent}  messages:`);
    lines.push(renderMessageNodes(node.children, depth + 2));
  } else {
    const sender = node.sender ? `${escapeYamlContent(node.sender)}: ` : "";
    const content = escapeYamlContent(node.content ?? `[${node.contentType}]`);
    lines.push(`${indent}quoted:`);
    lines.push(`${indent}  msg: "${sender}${content}"`);
  }
}
