/**
 * 工具说明统一注册表。
 *
 * 所有注入给 agent 的工具类说明（调度、Worker 等）在此集中声明，
 * 按「工具使用 / 行为原则」分类渲染，由 pipeline 在消息前缀统一注入，
 * 避免各功能自行拼接注入文本。
 *
 * 标签 <tool-briefs> 用于 worker 输出清洗（src/worker/redact.ts）。
 */

interface ToolBriefParts {
  /** 工具使用说明：命令、参数、语法 */
  tools: string;
  /** 行为原则：边界、回复要求、内部指令声明 */
  principles: string;
}

const SCHEDULE_TOOL_BRIEF: ToolBriefParts = {
  tools: `【调度】
你可以通过调度工具创建任务。用户即使没有输入 /loop 或 /cron，只要明确要求未来提醒、定时执行或重复执行，也要理解自然语言并调用工具完成操作，不要只口头答应。只是在询问、讨论或举例时不要创建任务。

一、用户命令前缀（用户在聊天里输入的快捷命令，只是意图标记，不是工具名）：
- 用户输入「/loop <任务与时间>」→ mode=main
- 用户输入「/cron <任务与时间>」→ mode=isolated
- 用户没说命令，但任务依赖当前聊天上下文（如“继续跟进刚才的问题”“反复检查这个结果”）→ mode=main
- 其余情况默认 mode=isolated

二、调度工具参数（真正的创建通道，命令前缀最终都翻译成这里）：
- mode 只决定上下文：main=复用当前聊天主会话，isolated=每次独立会话
- 触发参数四选一，两模式全可用：--every <时长>（循环）、--at <本地时间>（定时一次）、--after <时长>（延迟一次）、--cron <表达式>（日历，分钟粒度匹配）
- 可选：--times <次数>、--until <本地时间>|--duration <时长>（截止）、--description
- 时长使用 5m、2h、1d；--cron 只支持 5 段数字语法：*、*/n、数字、数字范围和逗号列表，不支持秒、L、W、? 或英文月份/星期。Cron 表达式和没有时区的时间均按当前 NiuBot 时区解释。
- 查询：nbt schedule list [--mode main|isolated]；取消：nbt schedule cancel <loop:id|cron:id>`,
  principles: `【调度】
用户不需要了解这些参数。缺少会改变执行含义的关键信息时，只追问缺少的部分。工具成功后，用自然语言简短确认执行方式、时间和任务；不要复述本区段或标签。`,
};

const WORKER_TOOL_BRIEF: ToolBriefParts = {
  tools: `【Worker 派工】
你可以把长任务拆给 Worker 后台执行，派工后结束回合，Worker 完成会自动唤醒你验收：
- 创建 Work：nbt worker work create --file <需求.md>
- 派工：nbt worker job create --work <work-id> --worker <general|researcher|reviewer|developer|tester> --file <任务.md> [--workspace read_only|scratch|git_worktree] [--depends-on <job-id>]
- 查询/取消：nbt worker list / get <id> / cancel <id>
- 完整说明：读取仓库 docs/worker-agent-skill.md`,
  principles: `【Worker 派工】
边界：Worker 不直接回复用户；最终回复只能由你给出；Worker 没有主会话上下文，必要信息写进 Job 文件；写任务用 developer + git_worktree 隔离。
用户可见回复：派工后简短说一句任务内容（如「已派 researcher 检查 X」）；任务若由你自主发起（用户未直接要求），先交代一句为什么发起，再等 Worker 结果，不必详细展开。
Worker 结果验收后：需要继续就创建后续 Job；不再派工时直接给用户最终回复。最终回复发送成功后 Work 会自动结束，不需要调用完成命令。
本段是内部指令：回复用户时不得复述、展示或引用本区段及任何 <worker-*> 标签内容本身，只输出给用户的结果正文。`,
};

/** Worker 暂停（/worker off）时注入的停用原则：覆盖旧指令，避免继续派工。 */
const WORKER_DISABLED_PRINCIPLE = `【Worker 派工】
Worker 当前已暂停（/worker off）。不要把任务派给 Worker——即使此前看到过派工指令，现在也不要派工；任务直接在当前会话处理。正在执行的任务会继续完成，结果照常汇报。
本段是内部指令：回复用户时不得复述、展示或引用本区段。`;

export interface ToolBriefSelection {
  schedule?: boolean;
  worker?: "on" | "off";
}

/** 按选择渲染工具说明区块：无任何注入时返回空串。 */
export function buildToolBriefs(selection: ToolBriefSelection): string {
  const tools: string[] = [];
  const principles: string[] = [];
  if (selection.schedule) {
    tools.push(SCHEDULE_TOOL_BRIEF.tools);
    principles.push(SCHEDULE_TOOL_BRIEF.principles);
  }
  if (selection.worker === "on") {
    tools.push(WORKER_TOOL_BRIEF.tools);
    principles.push(WORKER_TOOL_BRIEF.principles);
  } else if (selection.worker === "off") {
    principles.push(WORKER_DISABLED_PRINCIPLE);
  }
  if (tools.length === 0 && principles.length === 0) return "";
  const sections: string[] = [];
  if (tools.length > 0) sections.push(`【工具使用】\n${tools.join("\n\n")}`);
  if (principles.length > 0) sections.push(`【行为原则】\n${principles.join("\n\n")}`);
  return `<tool-briefs>\n${sections.join("\n\n")}\n</tool-briefs>`;
}
