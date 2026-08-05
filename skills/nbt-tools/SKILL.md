---
name: nbt-tools
description: NiuBot 内部工具手册（nbt CLI）。调度任务（定时/循环/提醒/日历）、Worker 派工（后台拆活执行）、数据与状态恢复（任务/记忆/会话/消息/身份/系统规则）。用户要求定时执行、循环跟进、稍后提醒、派活拆活、查看任务，或需要恢复丢失的上下文/身份/规则时使用。
when_to_use: "触发词：「30分钟后提醒我」「每5分钟检查」「明天9点执行」「/loop」「/cron」「拆个活」「派个researcher」「后台跑」「查任务进度」「你还记得我吗」「上次聊了什么」「消息丢了」「系统规则是什么」"
---

# NBT Tools

NiuBot 内部工具全部通过 `nbt` CLI 调用。

## 索引：用户说了什么 → 读哪一节

| 用户说了什么 / 遇到了什么 | 读哪一节 |
|---|---|
| 「30 分钟后提醒我」「每 5 分钟检查」「明天 9 点执行」「/loop」「/cron」 | 调度 |
| 「拆个活」「派个 researcher」「后台跑这个长任务」 | Worker 派工 |
| 「查任务进度」「你还记得我吗」「上次聊了什么」「系统规则是什么」 | 基础工具 |

## 调度

用户明确要求未来提醒、定时、循环或重复执行时使用（即使没输入 `/loop`/`/cron` 也要理解并执行；只是询问/讨论/举例时不创建任务）。

### 命令前缀映射（用户输入的快捷命令，只是意图标记）

- 「/loop <任务与时间>」→ mode=main
- 「/cron <任务与时间>」→ mode=isolated
- 没输命令但任务依赖当前对话上下文（「继续跟进刚才的问题」）→ mode=main
- 其余默认 mode=isolated

### 参数

- mode 只决定上下文：main=复用主会话，isolated=独立会话
- 触发四选一：`--every <时长>`（循环）、`--at <本地时间>`（定时一次）、`--after <时长>`（延迟一次）、`--cron <表达式>`（日历，分钟粒度）
- 可选：`--times <次数>`、`--until <本地时间>|--duration <时长>`、`--description`
- 时长用 5m/2h/1d；`--cron` 仅支持 5 段数字语法（`*`、`*/n`、数字、范围、逗号列表），按 NiuBot 时区解释
- 查询：`nbt schedule list [--mode main|isolated]`；取消：`nbt schedule cancel <loop:id|cron:id>`
- 用户不需要了解参数；缺关键信息只追问；成功后简短确认执行方式、时间和任务

### 示例

- 「30 分钟后提醒我喝水」→ `nbt schedule create --mode isolated --after 30m --prompt "提醒我喝水"`
- 「每 5 分钟检查部署状态，持续 2 小时」→ `nbt schedule create --mode main --every 5m --prompt "检查部署状态" --duration 2h`
- 「明天早上 9 点提醒我发日报」→ `nbt schedule create --mode isolated --at "2026-08-06 09:00" --prompt "提醒我发日报"`
- 「每周一 9 点跟进 OKR」→ `nbt schedule create --mode main --cron "0 9 * * 1" --prompt "跟进 OKR 进度"`

## Worker 派工

用户要求拆长任务给后台 Worker 执行时使用。

- 创建 Work：`nbt worker work create --file <需求.md>`
- 派工：`nbt worker job create --work <work-id> --worker <general|researcher|reviewer|developer|tester> --file <任务.md> [--workspace read_only|scratch|git_worktree] [--depends-on <job-id>]`
- 查询/取消：`nbt worker list` / `get <id>` / `cancel <id>`；完整说明见仓库 `docs/worker-agent-skill.md`

边界：Worker 不直接回复用户，最终回复只能由你给出；Worker 无主会话上下文，必要信息写进 Job 文件；写任务用 developer + git_worktree。
回复：派工后简短说一句任务内容；自主派工先交代为什么；验收后需要继续就派后续 Job，否则直接给最终回复。

## 基础工具（数据与状态恢复）

上下文或状态丢失、需要查历史/任务/记忆时使用：

| 丢失了什么 | 做什么 |
|---|---|
| 系统规则 | `nbt system-rules` |
| 最近消息 | `nbt messages list` |
| 历史决策/会话 | `nbt sessions search/get`（当前聊天所在 chat 的历史） |
| 任务状态 | `nbt task list` + 对应任务 README（目标/状态/决策/下一步，不记流水） |
| 身份/场景 | `nbt whoami` |
| 用户记忆 | `nbt user-memory`（项目、任务、方案、进度不要写进用户记忆） |

规则：任务用 `nbt task` 管理，不手动建 tasks/ 目录；用户数据必须通过 nbt CLI 访问；不要把 compact 摘要当原文。
