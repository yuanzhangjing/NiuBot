---
name: nbt-tools
description: NiuBot 内部工具（nbt CLI）。调度任务（定时/循环/提醒/日历，含 /loop /cron 命令）、Worker 派工（拆长任务后台执行）、数据与状态恢复（任务、用户记忆、消息、会话、身份、系统规则）。当用户要求定时执行、循环跟进、稍后提醒、派活拆活、查看任务、恢复丢失的上下文或记忆时加载。
---

# NBT Tools

NiuBot 的内部工具全部通过 `nbt` CLI 访问。按用途分三组：调度、Worker 派工、数据与状态恢复。

## 何时使用

- **调度**：用户明确要求未来提醒、定时执行、循环跟进或重复执行
- **Worker 派工**：用户要求把长任务拆给后台 Worker 执行
- **基础工具**：需要查看任务、读写用户记忆、恢复丢失的上下文/身份/规则

## 调度（schedule）

用户即使没有输入 `/loop` 或 `/cron`，只要明确要求未来提醒、定时执行或重复执行，也要理解自然语言并调用工具完成操作，不要只口头答应。只是在询问、讨论或举例时不要创建任务。

### 用户命令前缀（用户在聊天里输入的快捷命令，只是意图标记，不是工具名）

- 用户输入「/loop <任务与时间>」→ mode=main
- 用户输入「/cron <任务与时间>」→ mode=isolated
- 用户没说命令，但任务依赖当前聊天上下文（如「继续跟进刚才的问题」「反复检查这个结果」）→ mode=main
- 其余情况默认 mode=isolated

### 调度工具参数

- mode 只决定上下文：main=复用当前聊天主会话，isolated=每次独立会话
- 触发参数四选一，两模式全可用：`--every <时长>`（循环）、`--at <本地时间>`（定时一次）、`--after <时长>`（延迟一次）、`--cron <表达式>`（日历，分钟粒度匹配）
- 可选：`--times <次数>`、`--until <本地时间>|--duration <时长>`（截止）、`--description`
- 时长使用 5m、2h、1d；`--cron` 只支持 5 段数字语法：`*`、`*/n`、数字、数字范围和逗号列表，不支持秒、L、W、? 或英文月份/星期。Cron 表达式和没有时区的时间均按当前 NiuBot 时区解释
- 查询：`nbt schedule list [--mode main|isolated]`；取消：`nbt schedule cancel <loop:id|cron:id>`
- 用户不需要了解这些参数。缺少会改变执行含义的关键信息时，只追问缺少的部分。工具成功后，用自然语言简短确认执行方式、时间和任务

## Worker 派工

可以把长任务拆给 Worker 后台执行，派工后结束回合，Worker 完成会自动唤醒验收：

- 创建 Work：`nbt worker work create --file <需求.md>`
- 派工：`nbt worker job create --work <work-id> --worker <general|researcher|reviewer|developer|tester> --file <任务.md> [--workspace read_only|scratch|git_worktree] [--depends-on <job-id>]`
- 查询/取消：`nbt worker list` / `nbt worker get <id>` / `nbt worker cancel <id>`
- 完整说明：读取仓库 `docs/worker-agent-skill.md`

### 边界

- Worker 不直接回复用户；最终回复只能由你给出
- Worker 没有主会话上下文，必要信息写进 Job 文件
- 写任务用 developer + git_worktree 隔离

### 用户可见回复

- 派工后简短说一句任务内容（如「已派 researcher 检查 X」）
- 任务若由你自主发起（用户未直接要求），先交代一句为什么发起，再等 Worker 结果，不必详细展开
- Worker 结果验收后：需要继续就创建后续 Job；不再派工时直接给用户最终回复。最终回复发送成功后 Work 会自动结束，不需要调用完成命令

## 基础工具（数据与状态恢复）

上下文或状态丢失时的恢复命令：

- **任务**：任务生命周期用 `nbt task` 管理。任务状态丢失时运行 `nbt task list`，并读取对应任务 README（README 记录目标、状态、关键入口、重要决策和下一步，不记录聊天流水）。不要手动创建 tasks/ 目录
- **用户记忆**：用 `nbt user-memory` 读写用户记忆；项目、任务、方案和进度不要写进用户记忆
- **身份/场景**：涉及身份、用户记忆或当前场景时，用 `nbt whoami` 恢复
- **系统规则**：系统规则丢失时运行 `nbt system-rules`
- **最近消息**：最近消息丢失时运行 `nbt messages list`
- **历史会话**：历史决策丢失时用 `nbt sessions search/get` 检索当前聊天的原生 session 记录；不要把 compact 摘要当成原文
- **数据访问**：用户数据必须通过 nbt CLI 访问，不能直接读取数据库文件
