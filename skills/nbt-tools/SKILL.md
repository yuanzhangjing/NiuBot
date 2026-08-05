---
name: nbt-tools
description: NiuBot 内部工具手册（nbt CLI）。调度任务（定时/循环/提醒/日历，含 /loop /cron 命令）、Worker 派工（拆长任务后台执行）、数据与状态恢复（任务/记忆/会话/消息/身份/系统规则）。当用户要求定时执行、循环跟进、稍后提醒、派活拆活、查看任务、或需要恢复丢失的上下文/身份/规则时加载。
---

# NBT Tools

NiuBot 内部工具的完整手册，全部通过 `nbt` CLI 调用。

## 什么时候读哪一章

| 用户说了什么 / 遇到了什么 | 读哪一章 |
|---|---|
| 「30 分钟后提醒我」「每 5 分钟检查」「明天 9 点执行」「/loop」「/cron」 | [调度](#调度schedule) |
| 「拆个活」「派个 researcher」「后台跑这个长任务」 | [Worker 派工](#worker-派工) |
| 「查一下任务进度」「我之前的任务呢」 | [基础工具·任务](#基础工具数据与状态恢复) |
| 「你还记得我吗」「现在是什么场景」 | [基础工具·身份](#基础工具数据与状态恢复) |
| 「你忘记规则了」「系统规则是什么」 | [基础工具·系统规则](#基础工具数据与状态恢复) |
| 「上次聊了什么」「查一下历史」「消息丢了」 | [基础工具·会话与消息](#基础工具数据与状态恢复) |

## 调度（schedule）

### 什么时候用

用户明确要求未来提醒、定时执行、循环跟进或重复执行时。即使没有输入 `/loop` 或 `/cron`，只要意图是「未来某时/定期/循环」，就调用本组工具，不要只口头答应。只是询问、讨论或举例时不要创建任务。

### 命令前缀映射（用户在聊天里输入的快捷命令，只是意图标记，不是工具名）

- 用户输入「/loop <任务与时间>」→ mode=main
- 用户输入「/cron <任务与时间>」→ mode=isolated
- 用户没说命令，但任务依赖当前聊天上下文（如「继续跟进刚才的问题」「反复检查这个结果」）→ mode=main
- 其余情况默认 mode=isolated

### 工具参数

- mode 只决定上下文：main=复用当前聊天主会话，isolated=每次独立会话
- 触发参数四选一，两模式全可用：
  - `--every <时长>`：循环执行
  - `--at <本地时间>`：定时执行一次
  - `--after <时长>`：延迟多久后执行一次
  - `--cron <表达式>`：日历表达式（分钟粒度匹配）
- 可选：`--times <次数>`（最多执行次数）、`--until <本地时间>|--duration <时长>`（截止）、`--description`
- 时长用 5m、2h、1d；`--cron` 只支持 5 段数字语法（`*`、`*/n`、数字、数字范围和逗号列表），不支持秒、L、W、? 或英文月份/星期；表达式和没有时区的时间均按当前 NiuBot 时区解释
- 查询：`nbt schedule list [--mode main|isolated]`；取消：`nbt schedule cancel <loop:id|cron:id>`
- 用户不需要了解这些参数。缺少会改变执行含义的关键信息时，只追问缺少的部分。工具成功后，用自然语言简短确认执行方式、时间和任务

### 示例（用户话术 → 命令）

- 「30 分钟后提醒我喝水」→ `nbt schedule create --mode isolated --after 30m --prompt "提醒我喝水"`
- 「每 5 分钟检查部署状态，持续 2 小时」→ `nbt schedule create --mode main --every 5m --prompt "检查部署状态" --duration 2h`
- 「明天早上 9 点提醒我发日报」→ `nbt schedule create --mode isolated --at "2026-08-06 09:00" --prompt "提醒我发日报"`
- 「每周一 9 点跟进一下 OKR」→ `nbt schedule create --mode main --cron "0 9 * * 1" --prompt "跟进 OKR 进度"`
- 「/loop 每 5 分钟检查这个状态」（回复某条消息）→ `nbt schedule create --mode main --every 5m --prompt "检查这个状态"`

## Worker 派工

### 什么时候用

用户要求把长任务拆给后台 Worker 执行（如「拆个活」「派个研究员」「后台调研」），或需要并行/异步处理复杂任务时。

### 命令

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

### 什么时候用

上下文或状态丢失（压缩后、新会话、重启后）、需要查历史/任务/记忆时。

### 恢复映射（丢了什么 → 读什么）

| 丢失了什么 | 做什么 |
|---|---|
| 系统规则 | `nbt system-rules` |
| 最近消息 | `nbt messages list` |
| 历史决策/会话 | `nbt sessions search/get`（检索当前聊天所在 chat 的历史） |
| 任务状态 | `nbt task list`，并读取对应任务 README（记录目标、状态、关键入口、决策、下一步；不记录聊天流水） |
| 身份/场景 | `nbt whoami` |
| 用户记忆 | `nbt user-memory`（读写用户记忆；项目、任务、方案和进度不要写进用户记忆） |

### 规则

- 任务生命周期用 `nbt task` 管理，不要手动创建 tasks/ 目录
- 用户数据必须通过 nbt CLI 访问，不能直接读取数据库文件
- 不要把 compact 摘要当成原文——丢失时用上面的命令恢复
