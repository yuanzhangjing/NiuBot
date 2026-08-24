# NiuBot 执行模型：当前现状（2026-08）

本文记录 NiuBot 当前执行模型。派工 Worker 已于 2026-08 下线，不再出现在主流程中。

## 1. 执行单元

主 Agent 会话（backend CLI 进程）是唯一执行单元。用户消息或内部事件到达后，
Pipeline 组装上下文并调用 backend，一个回合交付一条最终回复。

## 2. 消息流

```
用户消息 → 入队（buffer 合并）→ flush → process(chatId, mergedText, messages)
  → 组装上下文（Static/Important/Normal + 会话状态）
  → backend.sendMessage（一次调用，等完整响应）
  → ResponseSender.sendCard / sendText
  → 回合结束
```

关键文件：`src/core/pipeline.ts`。

## 3. 独立任务

定时任务（Cron）和临时任务（/task）使用独立 session 执行，不占用主会话上下文；
结果通过卡片发送到来源会话。Loop 和 Goal 复用主会话上下文，属于同一 chat 的
连续回合。

## 4. 中间进度

- 回合内中间输出不送达用户；最终回复由 Auto Delivery 在回合结束发送。
- 回合内可显式调用 `nbt send` 主动发送消息。
- 主 Agent 长任务由 watchdog 提供粗粒度运行状态提醒。

## 5. 重启与发布

Engine 重启走独立 restart worker，自动升级走独立 upgrade worker；Bot 导入/迁移
也使用独立 detached worker。这些都是基础设施进程，与派工 Worker 无关，保留。

## 6. 相关代码位置

- `src/core/pipeline.ts`：主会话处理、Loop、Goal、Cron 独立任务
- `src/core/queue.ts` / `chat-manager.ts`：消息队列与运行状态
- `src/cli/send.ts`：回合内主动发送
- `src/restart-worker.ts`：重启与升级 worker
- `src/bot-transfer-worker.ts`：Bot 导入/迁移 worker
