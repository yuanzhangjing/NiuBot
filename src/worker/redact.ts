/**
 * 出站消息保护：主 Agent 回复发送给用户前，强制剥离内部 Worker 标签内容。
 *
 * 不依赖 LLM 自觉（prompt 指令可能被忽略），而是运行时过滤：
 * 任何 <worker-*> / <job-*> 内部区段都不会到达用户。
 */

/** 剥离完整内部区段和残留裸标签。 */
export function stripInternalWorkerTags(text: string): string {
  return text
    .replace(/<worker-skill>[\s\S]*?<\/worker-skill>/g, "")
    .replace(/<worker-continuation>[\s\S]*?<\/worker-continuation>/g, "")
    .replace(/<worker-result[^>]*>[\s\S]*?<\/worker-result>/g, "")
    .replace(/<worker-role>[\s\S]*?<\/worker-role>/g, "")
    .replace(/<job-target>[\s\S]*?<\/job-target>/g, "")
    .replace(/<\/?(?:worker|job)-[a-z-]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
