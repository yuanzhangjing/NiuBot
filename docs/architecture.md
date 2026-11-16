# NiuBot 技术架构

> 状态：现行（2026-11）｜以代码为准｜配套：[产品架构](product-architecture.md)、[执行模型](execution-model.md)

NiuBot 是一个**单进程、多 Bot、以 CLI Agent 为执行单元的常驻运行时**。它自己不实现模型推理，只负责：接入 IM、组装上下文、驱动 backend 子进程、管理会话与数据、把结果可靠地送回 IM。

---

## 1. 进程模型

```
一个 Engine 进程
├── config.bots[]                 ← 每个 Bot 一个实例
│   ├── FeishuAdapter             ← IM 适配（当前只有飞书）
│   ├── PersistentTransport       ← inbox / outbox 持久化
│   ├── Pipeline                  ← 队列、上下文、命令、会话、调度入口
│   ├── ApiServer                 ← Bot 级本地 API（api.sock）
│   ├── CronScheduler             ← 独立会话定时任务
│   └── LoopScheduler             ← 主会话循环任务
├── EngineControlServer           ← 引擎级控制（health / identity / shutdown）
├── restart / upgrade launcher    ← 脱离主进程执行的重启与升级
└── bot transfer worker           ← Bot 导入 / 迁移
```

要点：

- **单进程多 Bot**：`config.bots[]` 决定数量，每个 Bot 独立 DB、独立工作目录、可独立指定 backend 与模型。
- **单实例靠独占资源**：PID 文件记录进程；本地 unix socket 是独占的，第二个进程会在 `listen` 阶段拿到 `EADDRINUSE`。代码里没有额外的锁文件。
- **信号处理**：SIGINT/SIGTERM 触发优雅关闭；关闭顺序固定——先停 transport，再停调度器，再 `pipeline.shutdown()` 取消在途回合，最后在有界 deadline 内关库。
- **重启不是自杀**：`/restart` 与自动升级走独立 launcher（`src/restart-launcher.ts`，配套 `restart-compat.ts` / `restart-progress.ts` / `restart-log.ts`），主进程退出后由它拉起新进程，失败可回滚。

入口代码：`src/index.ts`（bootstrap/关闭）、`src/bot-instance.ts`（装配）。

---

## 2. 消息链路

```
飞书事件
  → FeishuAdapter.normalize
  → transport_inbox（落库 + claim，重复事件幂等）
  → Pipeline.handleInbound
  → ChatManager 缓冲合并（默认 1500ms，同 chat 连续消息合成一条）
  → 组装上下文（见 §3）
  → backend.sendMessage（一个回合，等完整结果）
  → ResponseSender（卡片/文本/文件）
  → transport_outbox（pending → sending → sent；失败转 failed/unknown 重试）
  → 飞书发送
```

设计约束：

- **入站至少一次、出站幂等**：inbox 按 `platform_msg_id` 去重；outbox 有明确状态机，`unknown` 表示"发出去了但不确定"，由重试策略处理，不盲目重发。
- **缓冲不是节流**：合并是为了让连续消息作为一轮理解，不是为了省调用。
- **回合制**：一个回合只交付一条最终回复，中间输出不直达用户；需要主动发消息用 `nbt send`。
- **过期消息丢弃**：超过 2 分钟的入站消息不再触发回合，避免重启后一次性回放。

关键文件：`src/im/feishu/adapter.ts`、`src/transport/persistent-transport.ts`、`src/core/queue.ts`、`src/core/pipeline.ts`。

---

## 3. 上下文装配（三层 + speaker 块）

| 层 | 内容 | 构建函数 |
|---|---|---|
| **Static** | 系统规则、Bot 身份、Bot profile / 人格、workspace `AGENTS.md` | `buildStableSystemContext` |
| **Important** | 用户记忆、会话级配置（模型/effort）、Bot 协作身份 | `buildImportantContext` |
| **Speaker** | 当前发言人（群聊多人合并时列全） | `buildSpeakerContext` |
| **Normal** | 活跃任务索引、最近消息续接、归档引用、系统提醒 | `buildNormalContext` / `buildActiveTaskContext` |

Speaker 不是独立一层，是回合内的说话人标注，紧挨 Normal 注入；多人合并消息时会列出全部发言人。

两条恢复提醒硬编码在注入层：

- **新会话首条**：提示按需 `nbt sessions list` / `search`，不要凭记忆猜。
- **compact 之后**：提示规则、身份、记忆可能被摘要，先 `nbt system-rules` / `whoami` / `messages list` 恢复，**不要把摘要当原文**。

分层的目的：Static 稳定可缓存，Normal 每轮变化，Important 在两者之间。上下文自治（新建、压缩、恢复）是产品核心，不是优化项。

关键文件：`src/memory/inject.ts`、`src/system-rules.ts`。

---

## 4. Session 生命周期

```
新建 → active（每轮 resume 同一个 agent session）
     → 触发 compact（上下文压缩）
     → archive（超时/换话题/手动 /new）→ 目录归档 + 原生 transcript 解析
```

- 会话按 `scope` 隔离：私聊按 chat，群聊按 chat（可选按 thread）——见 `src/core/session-scope.ts`。
- 每个 session 记 `agent_session_id`，backend 用它 resume；拿不到 id 时降级为启动命令。
- 归档保留原生 transcript（`src/session-archive/`），`nbt sessions list/search/get` 读取；live transcript 用于 `/status` 展示最近活动。
- 独立任务（cron / `/task`）用新 session，不污染主会话上下文。

---

## 5. Agent Backend 契约

`src/agent/cli-base.ts` 定义 `CliAgentBackend`，backends 只实现差异：

| Backend | 命令 | effort | 备注 |
|---|---|---|---|
| claude | `claude` | ✅ | 参考实现 |
| codex | `codex` | ✅ | |
| traecli | `traecli` | ✅ | |
| opencode | `opencode` | ✅ | |
| pi | `pi` | ✅ | |
| grok | `grok` | ✅ | 瞬时网络错误需要拆包 |
| dsh | `dsh` | ✅ | 会话日志与权限预设和普通 CLI 不同 |
| agy | `agy` | ✅ | Antigravity CLI；消息只能走 `-p`（进程列表可见），会话用 `--conversation` 续接 |
| cursor | `cursor-agent` | — | 不支持 effort 透传 |

契约要点（详见 `src/backends/AGENTS.md`）：

- 起进程、读 stdout 行、解析终态；`error` 之后仍可能有 `end`，必须以失败收尾。
- token 统计是**上下文占用**，不是累计花费。
- session id 尽早拿到，只在真正开场后写入。
- 只发当前轮最后一条用户可见回复；history 优先于拼 stdout。
- 失败路径必须真实：不要用"看起来成功"兜底。

---

## 6. 调度与后台旁路

| 机制 | 位置 | 语义 |
|---|---|---|
| Cron | `src/core/cron.ts` | 独立 session；60s tick；切片 claim + 全局并发池；错过的分钟有 10 分钟补跑窗口 |
| Loop | `src/core/loop.ts` | 复用主会话，按 `--every`/`--cron` 排队触发 |
| Goal | `src/core/goal.ts` | 多轮目标，带结局与轮次，可中断/恢复 |
| Task | `src/cli/task.ts` | 正式任务目录 + README，跨会话注入索引 |
| Watchdog | `pipeline.ts` | 15s 巡检：空闲、compact、异常退出 |
| 群历史同步 | `src/core/group-history.ts` | 补齐 Bot 未在线时的群消息，带游标 |
| 多 Bot 协作 | `src/core/collab-*.ts` | 回合状态机、交棒、幂等恢复 |
| 保活 | `src/platform/keep-awake.ts` | 可选，防休眠 |

---

## 7. 数据模型

单个 SQLite（WAL），当前 40 个 core 迁移 + 2 个 transport 迁移、29 张表，按域分组：

- **对话**：`messages`、`chats`、`users`、`chat_summary`、`thread_history_cursors`
- **会话**：`sessions`、`agent_continuations`、`model_history`
- **记忆**：`user_memory`、`scope_runtime_configs`
- **调度**：`cron_jobs`、`loop_jobs`
- **可靠性**：`transport_inbox`、`transport_outbox`、`runtime_events`、`bot_runtime_state`
- **协作**：`bot_collab_chains`、`bot_permission_warnings`
- **配置/团队**：`settings`、`team_settings`、`team_config_versions/drafts`
- **迁移与运维**：`niubot_component_schema_versions`、`update_notifications`
- **历史遗留**：`worker_*`（Worker 运行时已下线，表保留）

原则：改表只追加迁移，保持向后兼容；不直接读 Bot DB，外部一律走 `nbt`。

---

## 8. 失败与恢复

- **崩溃**：inbox 未确认的消息重放；`status='running'` 的 cron/loop claim 启动时归还。
- **发送不确定**：`DeliveryUncertainError` + outbox `unknown`，不重复发也不静默丢。
- **回合超时**：backend 进程可 kill；关闭阶段有 `inFlightTimeout` 截止，避免永久挂起。
- **上下文丢失**：compact/新会话提醒；规则、身份、记忆、会话都可从 CLI 重新取。
- **升级失败**：restart 快照 + 健康检查 + 回滚。

---

## 9. 扩展点

1. **Backend**：新增 CLI Agent（见 backends 契约）。
2. **Skill**：`skills/` 下的 Markdown 说明，装到工作目录，Agent 按需读取。
3. **CLI**：`nbt` 子命令是给 Agent 和外部进程的统一入口。
4. **本地 API**：Bot 级 `api.sock`（`/send`、`/send-file`、`/schedule`、`/goal/*`、`/wake`、`/collab/turn`），引擎级 control server（health/identity/shutdown）。
5. **IM 适配**：目前只有飞书；`TransportClient` 是抽象边界，但没有第二家实现。

---

## 10. 部署形态

- **dev**：源码目录直接跑（`tsx src/index.ts`），路径含 `src/` 自动判定。
- **production**：npm 包 + `dist/`，`postinstall` 装用户级 launcher；`NIUBOT_ENV` 显式或按路径推断。
- **数据目录**：`~/.niubot/<BotId>/`（DB、profile、session 归档、api.sock）。
- **平台**：macOS / Linux 主路径；Windows 有独立适配（进程、IPC、更新）。

---

## 11. 已知边界（别当成 bug）

- 只有飞书一个 IM 实现；没有 Web 管理台。
- 单机单进程，没有多租户隔离；"多 Bot"是同一用户下的多个身份。
- 不实现通用工作流编排，复杂流程靠 Agent + 任务/调度组合。
- Worker 运行时已下线，`worker_*` 表仅为兼容保留。
- backend 能力差异靠静态声明 + 探测，没有统一的能力矩阵。

---

## 维护约定

代码是唯一事实来源。改动涉及进程模型、消息链路、上下文装配、数据表或调度语义时，同步更新本文；具体执行细节优先看 `docs/execution-model.md`。
