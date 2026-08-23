# 飞书群聊 Bot 互叫

日期：2026-08-22  
范围：NiuBot Engine（飞书适配器 + 出站发送 + 群聊注入）  
状态：已落地。最终回复走卡片 at；CowBot 需同步更新才能测回程纯文本/卡片互叫

## 背景

飞书群里多个应用机器人无法靠「拉成员列表」发现彼此，默认也不会把 Bot 发出的消息推给其他 Bot。本方案让 NiuBot 在群聊里能：

1. 认出其他 Bot
2. 用飞书真正的 at 点名，叫醒对方
3. 被其他 Bot at 时正常入站、跑 Agent
4. 由 Agent 决定还要不要继续叫对方；引擎只在极端轮次切断

2026-08-22 在群 C4（Zhangjing Yuan）用 NiuBot 与 CowBot 验证；2026-08-23 补测卡片 at：

- 纯文本 `<at user_id>` + 权限 `im:message.group_at_msg.include_bot:readonly`，能叫醒
- 卡片富文本 `<at id=ou_xxx></at>` 同样写入 `mentions` 并能叫醒对方 Bot
- 卡片 markdown 里的字面 `@U4(Name)`、人员组件，不是飞书 at，不推事件
- Bot 只回复不 at，对方收不到事件
- 人只回复不 at，可以叫醒 NiuBot（现有 `isReplyToBot`）；Bot 回复不走这条

## 目标

- Agent 在回复或 `nbt send` 里写 `@U4(CowBot)` / `@U4`，引擎转成飞书 `<at>` 并投递
- 最终回复默认仍走卡片；卡片 markdown 里写成 `<at id>`，`nbt send` 文本仍用 `<at user_id>`
- 入站 `sender_type=app` 记 `is_bot`，群聊 speaker 标成 Bot 而不是「用户」
- 叫谁、停不停，由 Agent 决定；引擎不自动 at
- 保险丝按**连续 Bot 触发回合**计数，阈值偏大，只防跑飞

## 非目标

- 不申请、不依赖「获取群组中用户和机器人消息」(`im:message.group_msg.include_bot:read`)
- 不解群聊 `nbt contacts` 限制
- 不做同进程伪造 `im.message.receive_v1`（跨应用 Bot 用不上）
- 不把 Bot 回复（无 at）当成 at
- 不改其他引擎（CowBot 等）；单边改 NiuBot 只能保证我方发出去的 at 是对的

## 飞书约束（实现必须遵守）

| 行为 | 结果 |
| --- | --- |
| `GET /im/v1/chats/{id}/members` | 不返回机器人 |
| `GET /im/v1/chats/{id}` | 只有 `bot_count`，无名单 |
| 人 @ Bot | 推 `im.message.receive_v1` |
| Bot 纯文本 `<at user_id>` 另一个 Bot（双方都开了 include_bot） | 推事件 |
| Bot 卡片富文本 `<at id>` 另一个 Bot | 推事件 |
| 卡片里的字面 `@名字` / 人员组件 | 不推 |
| Bot 回复另一条消息、不 at | 不推 |
| 拉群历史 `GET /im/v1/messages` | 能看到消息，**不是**事件通道 |

每个参与互叫的应用都要开通并**发布版本**：

`im:message.group_at_msg.include_bot:readonly`  
（获取群组中其他机器人和用户@当前机器人的消息）

NiuBot 开通示例：

https://open.feishu.cn/app/cli_a94929a79639dbb4/auth?q=im:message.group_at_msg.include_bot:readonly&op_from=openapi&token_type=tenant

## 现状（代码）

- 群聊触发：`botMentioned` 或回复本 Bot 的消息（`pipeline.ts`）。适配器里 `mention.isBot` **只表示 at 的是自己**。
- `users.is_bot` 字段在，入站几乎不写。`ensureUser(..., "bot_sender")` 的 `bot_sender` 是**名字来源优先级**，不是 Bot 身份。
- 群聊用 `<current-speaker>` 区分说话人（已能看到 `U4(CowBot)`），文案写死「用户：」。
- 入站会把飞书 mention 收成 `@U4(CowBot)`。
- 最终回复走 `ResponseSender.sendFinalResponse`，默认卡片。
- `nbt send` 走 `Pipeline.sendToChat` / `sendCardToChat`，文本可透传原始 `<at>`，但**不会**把 `@U4` 转成 at，也不过保险丝。
- 出站没有短号 → `<at user_id>` 转换。

## 设计

### 1. 入站：标记 Bot

飞书事件 `sender.sender_type === "app"` 时：

- `NormalizedMessage` 增加 `senderIsBot: boolean`（默认 false）
- `ensureUser` 写入或更新 `users.is_bot = 1`
- `platform_id` 仍用 `sender_id.open_id`（C4 实测 CowBot 入站是 `U4`，open_id 可用）

第一期不根据「别人 mention 了某个 ou_」猜测它是 Bot。对方自己发过言再标最准。人同时 @ 我和它时，短号已经在用户表里，出站转换不依赖 `is_bot`。

`MentionInfo.isBot` 继续表示「at 的是本 Bot」，给 `botMentioned` 用。不要和「这个用户是不是 Bot」混在一个字段里。

### 2. 群聊 speaker

`SpeakerInfo` 增加 `isBot`。

- Bot：`Bot：U4(CowBot)`
- 人：保持 `用户：U2(Zen)（admin）`
- Bot 不注入该 user 的 user-memory（避免把人的记忆规则套到机器人上）

### 3. 出站：短号转 at

所有发给飞书的**文本**经过同一层 `rewriteOutboundMentions(chatId, text)`：

识别：

- `@U4(CowBot)`
- `@U4`（大小写不敏感，内部 id 是 `u4`）

不识别：

- 未登记的 `@名字`（当普通字）
- 已经是 `<at user_id="ou_...">` 的片段（原样保留，保险丝仍要扫）

转换：查 `users.id` → `platform_id`，写成：

```text
<at user_id="{platform_id}">{displayName}</at>
```

`displayName` 用用户表 `name`，没有则用短号。

`@所有人` / `@all` 不在本方案范围（现有逻辑保持）。

### 4. 最终回复走卡片，at 写进 markdown

出站先把短号转成 `<at user_id>`。发卡片时再收成官方 `<at id="{platform_id}"></at>`。

- 最终回复 / `nbt send --card` / watchdog 卡片：保持卡片
- `nbt send` 文本、系统通知：仍是文本 `<at user_id>`
- 含完整飞书 at 标签的内容不降级成文件（文件叫不醒对方）；卡片 API 失败则用原文走文本，不换成「发送失败」提示。最终回复、`nbt send --card`、watchdog 卡片同一条降级。
- 字面 `@U4(Name)` 不算 at，必须经过转换

对人、不 at 其他 Bot 的回复，路径不变。

### 5. `nbt send` 与最终回复走同一套

统一收口在 Pipeline 出站，而不是只改 Agent 最终卡片：

| 入口 | 现状 | 改后 |
| --- | --- | --- |
| 回合最终回复 `sendFinalResponse` | 默认卡片 | 先 rewrite；卡片内转成 `<at id>` |
| `nbt send` → `sendToChat` | 原文透传 | 先 rewrite + 保险丝，再 sendText/sendReply |
| `nbt send --card` → `sendCardToChat` | 卡片 | 先 rewrite，仍发卡片 |
| 系统通知 / watchdog 等 | 文本或卡片 | 同样走 rewrite（通常无短号，等价于原样） |

Agent 不必为了 at 去调 `nbt send`。`nbt send` 不能用来绕过转换和保险丝。

### 6. Agent 决策，引擎不自动 at

本回合即使由其他 Bot at 触发，引擎**也不**自动给对方加 at。

想让对方收到，Agent 在正文或 `nbt send` 里写 `@U4(CowBot)`。写了才转、才叫醒；不写就只是群可见回复，对方事件通道听不见。

这是正常 break：事情说完不再 at。

### 7. 群聊注入

只在群聊注入，不写进 bot profile。

**互叫规则**（可放在 `buildImportantContext` 或 speaker 旁的短块）：

- 叫其他 Bot 用 `@U4(CowBot)` 这种短号；引擎会转成飞书 at 放进卡片发出
- 不要手写 `ou_` / `<at user_id>`（写了也能过，但不作为用法）
- 想让对方 Bot 收到这一句，必须 at 它；说完就不要 at
- 人在群里能看见所有消息，不必为了「让人看见」去 at 人
- 不要为了打招呼无意义互 at

**本群见过的 Bot**：`users.is_bot=1` 且在本群消息里出现过（发送者或被 at）。格式示例：

```text
本群 Bot：U3(NiuBot)、U4(CowBot)
```

没有名单时短号转换仍然有效，只是 Agent 不知道还能叫谁。

### 8. 保险丝（按轮次，阈值偏大）

只统计**本群、连续被 Bot 触发并实际跑了 Agent 的回合**。

- 入站 `senderIsBot === true` 且本回合跑了 Agent：`bot_turn_count += 1`
- 入站是人（含人回复我不 at）：`bot_turn_count = 0`
- 默认上限 **20**（配置项，可调）
- 达到上限：本回合仍生成并发送回复，但**剥掉所有其他 Bot 的 at**（自动转换的和原文 `<at>` 都剥），群里可见；并加一行「互叫已停，需要人接手。」
- `/stop`、人 @，都按人回合清零
- 不按时间窗衰减；连续 20 轮 Bot 互叫才断
- 计数存在进程内即可，重启清零可接受（保险丝不是主协议）

剥 at 后不再把 `@U4` 转成飞书 at，避免 Agent 手写短号绕过。

## 关键决策

1. **不自动 at**：叫醒对方是 Agent 的明确动作，不是引擎隐含协议。
2. **`nbt send` 与最终回复同一套**：否则 Agent 用工具就能绕过转换和保险丝。
3. **卡片和文本都能投递正规 at**：最终回复保持卡片观感；`nbt send` 文本路径不变。
4. **保险丝按连续 Bot 回合、默认 20**：只防跑飞，不替模型结束对话。
5. **`is_bot` 以 `sender_type=app` 为准**：不靠猜 mention。
6. **发现靠人 at 介绍 + 对方发过言**：不拉群成员列表。

## 涉及文件（预计）

- `src/transport/types.ts` — `senderIsBot`
- `src/im/feishu/adapter.ts` — 解析 `sender_type`
- `src/database/schema.ts` — `ensureUser` / 标记 `is_bot`
- `src/core/pipeline.ts` — 入站记账、出站收口、保险丝计数
- `src/core/response-sender.ts` — 允许按 rewrite 结果走文本
- `src/memory/inject.ts` — speaker 文案、群聊 Bot 名单与互叫规则
- `INSTALL.md` — include_bot 权限与发布版本
- 对应测试：adapter / pipeline / inject / send

建议把「短号扫描 + at 转换 + 是否含其他 Bot at + 剥 at」做成纯函数，方便单测，不要散落在 send 各处。

## 测试要点

- `@U4(CowBot)` / `@U4` / `@u4` 转成正确 `<at>`
- 已是 `<at user_id>` / `<at id>` 的文本不重复包一层
- 含其他 Bot at 的最终回复仍走 card，markdown 为 `<at id>`
- `nbt send` 短号会被转换；`--card` 仍发卡片
- 人触发回合默认仍是卡片
- `sender_type=app` → `is_bot=1`，speaker 为 `Bot：U4(...)`
- 连续 20 轮 Bot 触发后第 21 轮剥 at，群消息仍发出
- 人插进来后计数清零，可以再互叫
- 保险丝开启时 `nbt send '<at user_id=对方>...'` 也会被剥

## 文档与权限

`INSTALL.md` 增加：若要在群里和其它应用机器人互 at，为每个应用开通 `im:message.group_at_msg.include_bot:readonly` 并发布版本。不开则只有人 @ 能叫醒 Bot。

## 仍可后置

- 对方尚未发过言时，能否从 mention 标 `is_bot`（飞书 mention 不带可靠的 bot 标记）
- 事件只有 `app_id`、没有 bot `open_id` 时的用户映射（第一期若缺 open_id 则打 warn 并跳过该条，保持现状）
- 其他引擎（CowBot）对等改造；不对等时，对方漏 at 或发卡片，链仍会断
- 保险丝是否做成配置文件项以外的 IM 命令（第一期代码常量或 bot 配置即可）

## 落地顺序

1. 入站 `senderIsBot` + `is_bot` + speaker 文案
2. 出站纯函数：短号转换、检测其他 Bot at、剥 at
3. 接到 `sendToChat` / `sendCardToChat` / 最终回复
4. 群聊注入规则与 Bot 名单
5. 回合计数保险丝
6. INSTALL 补权限说明
