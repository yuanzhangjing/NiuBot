/**
 * 把 MessageNode 树渲染成给 agent 看的标签结构。
 * 叶子 → <msg>，转发 → <forward>，引用 → <quoted>。
 */
import type { MessageNode } from "./types.js";

export function escapeXmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeXmlAttr(s: string): string {
  return escapeXmlText(s).replace(/"/g, "&quot;");
}

export function isStructuredImPayload(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith("<msg") || t.startsWith("<forward") || t.startsWith("<quoted");
}

/** 当前这条用户消息。 */
export function renderMsg(speaker: string, content: string): string {
  return wrapTag("msg", speaker, escapeXmlText(content));
}

/** 被回复的那条。 */
export function renderQuotedText(speaker: string, content: string): string {
  return wrapTag("quoted", speaker, escapeXmlText(content));
}

/** 合并转发根节点。 */
export function renderForward(speaker: string, children: MessageNode[]): string {
  return wrapTag("forward", speaker, renderMessageNodes(children));
}

/**
 * 渲染 MessageNode 列表。
 * depth 保留给旧调用方，标签不靠缩进表达结构。
 */
export function renderMessageNodes(nodes: MessageNode[], _depth = 0): string {
  return nodes.map((node) => renderMessageNode(node)).join("\n");
}

function renderMessageNode(node: MessageNode): string {
  if (node.contentType === "forward" && node.children) {
    const parts: string[] = [];
    if (node.quoted) parts.push(renderQuotedNode(node.quoted));
    parts.push(renderMessageNodes(node.children));
    return wrapTag("forward", node.sender, parts.join("\n"));
  }
  const content = escapeXmlText(node.content ?? `[${node.contentType}]`);
  if (node.quoted) {
    return wrapTag("msg", node.sender, `${content}\n${renderQuotedNode(node.quoted)}`);
  }
  return wrapTag("msg", node.sender, content);
}

function renderQuotedNode(node: MessageNode): string {
  if (node.contentType === "forward" && node.children) {
    return wrapTag("quoted", undefined, renderMessageNode(node));
  }
  const content = escapeXmlText(node.content ?? `[${node.contentType}]`);
  if (node.quoted) {
    return wrapTag("quoted", node.sender, `${content}\n${renderQuotedNode(node.quoted)}`);
  }
  return wrapTag("quoted", node.sender, content);
}

function wrapTag(tag: string, speaker: string | undefined, inner: string): string {
  const attr = speaker?.trim() ? ` speaker="${escapeXmlAttr(speaker.trim())}"` : "";
  if (!inner.includes("\n")) return `<${tag}${attr}>${inner}</${tag}>`;
  return `<${tag}${attr}>\n${inner}\n</${tag}>`;
}
