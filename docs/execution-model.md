# NiuBot 执行模型：Worker 与非 Worker 现状梳理

本文梳理 NiuBot 当前（2026-08）的两种执行模式——**主 Agent（非 Worker）**与
**Worker 派工**——的现状，基于代码事实，不包含设计展望。

## 1. 总览

| 维度 | 主 Agent（非 Worker） | Worker 派工 |
|---|---|---|
| 执行单元 | 主 Agent 会话（backend CLI 进程） | 独立 Worker 会话（同一 backend） |
| 触发 | 用户消息 / 事件到达 | Scheduler 认领 Job |
| 回合 | 消息驱动，单回合单回复 | Job 生命周期 + Continuation 唤醒验收 |
| 中间进度 | **不送达用户**（见 §2.3） | 验收回合逐批送达 / 可静默（见 §3.4） |
| 持久性 | 会话内存态（重启可恢复 resume） | DB 状态机（Job/Work/Continuation 持久） |
| 管理入口 | 无（对话即用） | `nbt worker` CLI + `/worker` 命令 |

## 2. 主 Agent（非 Worker）模式

### 2.1 消息流（`src/core/pipeline.ts` process）

```
用户消息 → 入队（buffer 合并）→ flush → process(chatId, mergedText, messages)
  → 组装上下文（三层注入：Static/Important/Normal + worker-skill 区段）
  → backend.sendMessage（一次调用，等完整响应）
  → responseSender.sendCard / sendText（发一条回复）
  → 回合结束
```

关键代码：`pipeline.ts` process 中 `backend.sendMessage` →
`this.responseSender.sendCard(...)`（约 3340 行）。

### 2.2 回复发送（Auto Delivery）

- 回合结束时 pipeline 发**一条**最终回复（sendCard 优先，footer 带 session 信息）
- 中间输出（agent 处理流中的过程文本）**不会送达用户**
- 例外：回合内可显式调用 `nbt send`（CLI 工具，`src/cli/send.ts`）主动发消息——
  这是唯一"回合内主动发送"的路径

### 2.3 subagent（Claude Code 层）

- 主 Agent 可派 subagent（Agent 工具），结果经 task-notification 回到主 Agent 上下文
- **NiuBot 不感知 subagent**：其完成不触发 NiuBot 回合，中间进度不送达用户
- 长任务（多轮 subagent 循环）对用户表现为"一条消息发出后长时间等待，最终收到
  一条结果"

### 2.4 局限

- 回合内无中间进度送达（除非显式调 `nbt send`）
- 长回合期间用户消息排队（抢占只让未开始的 Continuation 让位，不打断执行中回合）
- subagent 生命周期绑定主会话进程，不持久

## 3. Worker 派工模式

### 3.1 链路（`src/worker/`）

```
主 Agent 派工（nbt worker work/job create）
  → Job 入队（queued，DB 持久）
  → Scheduler tick（默认 5s）认领（queued → running，CAS + 并发上限）
  → WorkerRuntime 执行（独立 backend 会话，workdir/workspace 策略）
  → Job 终态（completed/failed/...）
  → 生成 Continuation（DB 持久）
  → Scheduler 投递 → 主 Agent 验收回合（process 处理 continuationIds）
```

关键代码：`scheduler.ts` tick / `runtime.ts` runJob /
`pipeline.ts` enqueueWorkerContinuations + buildWorkerContinuationPrompt。

### 3.2 唤醒与验收

- Job 完成 → Continuation（pending）→ Scheduler 按 chat 分组投递
- 主 Agent 被唤醒处理验收回合（输入 = 内部事件区段，非用户发言）
- 验收回合结束 = 一条真实回复送达用户

### 3.3 回复引用

- 验收回合回复引用"触发消息"（创建 Work 的用户消息平台 ID，链路传递：
  `worker_works.trigger_msg_platform_id` → Continuation → pipeline）
- 合并验收（多 Work 同批）触发消息不同时不引用（避免错挂）

### 3.4 交付策略（多 Job Work）

- **中间静默**（`silentContinuationTurn`，pipeline.ts 约 3049 行）：Work 还有未终态
  Job 时，该批验收回合**不向用户发送**（结果进上下文，标记完成）
- 单 Job Work / 最终批次：正常交付
- 效果：多 Job Work 用户只收到"派工确认 + 最终结论"两条

### 3.5 持久性与恢复

- Job/Work/Continuation 全 DB 持久：重启后 Scheduler 恢复非终态 Job
  （running → interrupted 重新调度）；claimed 超时重置重新投递
- Worker 会话独立于主会话，主 Agent 离线不影响 Worker 执行

## 4. 关键对比：中间进度

| 场景 | 用户能收到中间进度吗 | 机制 |
|---|---|---|
| 主 Agent 长任务（subagent 循环） | ❌ 只有最终一条 | Auto Delivery 回合结束才发 |
| 主 Agent 回合内显式 nbt send | ✅ 可 | 主动调发送工具 |
| Worker 多 Job 中间批次 | ❌ 静默（设计） | silentContinuationTurn |
| Worker 单 Job / 最终批次 | ✅ | 验收回合 = 一条回复 |
| Worker 每轮验收（循环派工） | ✅ 每轮一条 | Continuation 每轮唤醒 |

## 5. 现状已知边界

1. **中间进度非机制保证**：主 Agent 长任务的进度汇报依赖"回合内显式 nbt send"
   或 Worker 验收回合；subagent 模式的中间输出不送达
2. **多 Job 静默是硬规则**：Work 未完成时中间批次一律静默（不做"重要 Job 发进度"
   的配置化）
3. **subagent 不持久**：绑定主会话进程，服务重启即失
4. **长回合阻塞**：主 Agent 长任务期间用户消息排队

## 6. 相关代码位置

- `src/core/pipeline.ts`：process（回合）、Auto Delivery 发送、Continuation 投递/验收、
  silentContinuationTurn、buildWorkerContinuationPrompt
- `src/worker/scheduler.ts`：tick、认领、Continuation 投递、依赖传播
- `src/worker/runtime.ts`：Job 执行、backend 解析、产物收集、installer
- `src/worker/job-service.ts` / `store.ts`：状态机、DB 持久
- `src/platform/skills-install.ts`：内置技能安装（同步策略）
- `src/cli/send.ts`：回合内主动发送工具
