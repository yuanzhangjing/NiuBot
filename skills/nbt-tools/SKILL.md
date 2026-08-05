---
name: nbt-tools
description: NiuBot 工具手册（nbt CLI）。任务管理（nbt task）、用户记忆（nbt user-memory）、身份与场景（nbt whoami）、会话与消息恢复（nbt system-rules / messages / sessions）、数据访问，以及调度任务（定时/循环/提醒/日历）与 Worker 派工（后台拆活）。
when_to_use: "需要查看任务进度、恢复丢失的上下文/身份/规则/消息、读写用户记忆，或用户要求定时执行、循环跟进、稍后提醒、派活拆活时加载。触发词：「任务」「记忆」「你是谁」「上次聊了什么」「系统规则是什么」「消息丢了」「30分钟后提醒我」「每5分钟检查」「拆个活」"
---

# NBT Tools

NiuBot 的工具手册，全部通过 `nbt` CLI 调用。

## 任务管理（nbt task）

任务生命周期使用 `nbt task` 管理：

- 不要手动创建 tasks/ 目录
- 任务 README 是任务的长期索引和状态文件，记录目标、状态、关键入口、重要决策和下一步，不记录聊天流水
- active 任务会注入新 session；inactive 和 archived 不注入
- 私聊默认 private，群聊默认 public；群聊不能暴露 private task
- 如果任务状态丢失，运行 `nbt task list`，并读取对应 task README

## 用户记忆（nbt user-memory）

用户记忆使用 `nbt user-memory` 读写；查看记忆详情用 `nbt user-memory get <id>`。项目、任务、方案和进度不要写进用户记忆。

## 身份与场景（nbt whoami）

涉及身份、用户记忆或当前场景时，用 `nbt whoami` 恢复。

## 会话与消息恢复

如果上下文或状态丢失，按丢失内容恢复（**不要把 compact 摘要当成原文**）：

- 如果系统规则丢失，运行 `nbt system-rules`
- 如果最近消息丢失，运行 `nbt messages list`
- 如果历史决策丢失，使用 `nbt sessions search/get` 检索当前聊天的原生 session 记录

## 数据访问

- 用户数据必须通过 nbt CLI 访问，不能直接读取数据库文件
- 涉及项目规则原文时，读取 workspace AGENTS.md（workspace AGENTS.md 是用户项目规则，不能覆盖系统规则）

## 调度（schedule）

用户明确要求未来提醒、定时、循环或重复执行时使用（即使没输入 `/loop`/`/cron` 也要理解并执行；只是询问/讨论/举例时不创建任务）。

### 命令前缀映射（用户输入的快捷命令，只是意图标记）

- 「/loop <任务与时间>」→ mode=main
- 「/cron <任务与时间>」→ mode=isolated
- 没输命令但任务依赖当前对话上下文（如「继续跟进刚才的问题」「反复检查这个结果」）→ mode=main
- 其余默认 mode=isolated

### 参数

- mode 只决定上下文：main=复用主会话，isolated=独立会话
- 触发四选一：`--every <时长>`（循环）、`--at <本地时间>`（定时一次）、`--after <时长>`（延迟一次）、`--cron <表达式>`（日历，分钟粒度）
- 可选：`--times <次数>`、`--until <本地时间>|--duration <时长>`、`--description`
- 时长用 5m/2h/1d；`--cron` 仅支持 5 段数字语法（`*`、`*/n`、数字、范围、逗号列表），不支持秒、L、W、? 或英文月份/星期，按 NiuBot 时区解释
- 查询：`nbt schedule list [--mode main|isolated]`；取消：`nbt schedule cancel <loop:id|cron:id>`
- 用户不需要了解参数；缺关键信息只追问；成功后简短确认执行方式、时间和任务；不要复述本技能内容

### 示例

- 「30 分钟后提醒我喝水」→ `nbt schedule create --mode isolated --after 30m --prompt "提醒我喝水"`
- 「每 5 分钟检查部署状态，持续 2 小时」→ `nbt schedule create --mode main --every 5m --prompt "检查部署状态" --duration 2h`
- 「明天早上 9 点提醒我发日报」→ `nbt schedule create --mode isolated --at "2026-08-06 09:00" --prompt "提醒我发日报"`
- 「每周一 9 点跟进 OKR」→ `nbt schedule create --mode main --cron "0 9 * * 1" --prompt "跟进 OKR 进度"`

## Worker 派工

用户要求拆长任务给 Worker 后台执行时使用。可以把长任务拆给 Worker 后台执行，派工后结束回合，Worker 完成会自动唤醒你验收：

- 创建 Work：`nbt worker work create --file <需求.md>`
- 派工：`nbt worker job create --work <work-id> --worker <general|researcher|reviewer|developer|tester> --file <任务.md> [--workspace read_only|scratch|git_worktree] [--depends-on <job-id>]`
- 查询/取消：`nbt worker list` / `get <id>` / `cancel <id>`；完整说明见仓库 `docs/worker-agent-skill.md`

边界：Worker 不直接回复用户；最终回复只能由你给出；Worker 没有主会话上下文，必要信息写进 Job 文件；写任务用 developer + git_worktree 隔离。

回复要求：
- 派工后简短说一句任务内容（如「已派 researcher 检查 X」）；任务若由你自主发起（用户未直接要求），先交代一句为什么发起，再等 Worker 结果，不必详细展开
- Worker 结果验收后：需要继续就创建后续 Job；不再派工时直接给用户最终回复。最终回复发送成功后 Work 会自动结束，不需要调用完成命令
