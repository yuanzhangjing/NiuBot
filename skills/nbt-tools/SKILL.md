---
name: nbt-tools
description: NiuBot 工具手册（nbt CLI）。命令速查：任务、记忆、身份/规则/消息恢复、发送、定时/循环、Goal 多轮、Worker 派工、引擎重启。
when_to_use: "用户提到任务/进度、记忆、身份/场景、消息或上下文丢失、系统规则，要求定时/循环/提醒/稍后、多轮/分步/持续跟进、拆活派活、重启/更新，或需要发送文件时加载。"
---

# NBT Tools — nbt CLI 速查

> 本页只列「何时用 + 主命令」；完整参数与示例用 `nbt <命令> --help` 现场查看。

## 任务与记忆

- **nbt task**：任务生命周期。`create <name> [--desc "..."] [--private|--public]` / `list` / `update` / `delete <name>`。不要手动建 tasks/ 目录。
- **nbt user-memory**：用户记忆。`add --summary <文本> [--detail]` / `list` / `get <id>` / `update` / `del`。上限 20 条。

## 身份、规则与恢复

- **nbt whoami**：身份/场景恢复。**nbt system-rules**：规则恢复。**nbt messages**：`list [-n 20] [--since/--before] [--role]` / `search <query>` / `get <id>`。**nbt sessions**：`list` / `search <query>` / `get <id>`。**nbt contacts**：`list-users` / `list-chats` / `get-user` / `get-chat` / `set-name`。
- 上下文丢失按对应命令恢复；用户数据只能通过 nbt CLI 访问。

## 发送

- **nbt send**：`<text>` / `--card <header> <content>` / `--file <path>`。

## 定时/循环任务（nbt schedule create）

用户要定时、循环、提醒、稍后 → 创建；只是讨论时不创建。

- `--mode current_session|new_session`；触发：`--every 5m` / `--at "08-06 09:00"` / `--after 30m` / `--cron "0 9 * * 1"`
- 可选 `--times` `--until` `--duration` `--description`；`list` / `cancel <id>`

## Goal 模式（nbt goal）

任务需要多轮执行/持续跟踪 → 进入；一轮能做完不要进。

- `nbt goal start <目标描述>` 进入（当前回合计入第 1 轮）
- `nbt goal progress <步骤> [--status <全局状态>]` 记录进展
- `nbt goal finish --outcome achieved|not_achieved [--conclusion <结论>]`

## Worker 派工

用户要拆长任务给后台 Worker → 派工。

- `nbt worker work create --file <需求.md>`
- `nbt worker job create --work <id> --worker <general|researcher|reviewer|developer|tester> --file <任务.md> [--workdir <dir>] [--depends-on <job-id>]`
- `nbt worker list` / `get <id>` / `cancel <id>`

## 引擎重启

`nbt restart [--update <版本>] [--wake [<提示>]]`。触发前告知用户一声。
