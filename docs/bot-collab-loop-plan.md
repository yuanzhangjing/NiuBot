# 多 Bot 协作回合 Loop 方案

状态：显式协议实现中；已完成三独立 Pipeline 端到端模拟，待真实飞书多设备验收

关联任务：`bot-collab-loop`

## 1. 目标

让多个运行在不同设备上的 Bot，在同一个飞书群聊话题中按顺序讨论：一次只运行一个 Bot；它完成报告后由 Engine 交给下一棒；下一台设备可以从飞书消息链恢复这次讨论，不依赖另一台设备的内存或本地数据库。

用户看到的效果是：

```text
用户启动 → Bot A 报告 → Bot B review → Bot C review → 结束
```

当前最直接的两个问题是：

1. 同一条消息同时 @ 多个 Bot 时，多个 Bot 一起抢答。
2. Bot 需要自己记得写 at，漏写后下一台设备不会被唤醒。

本方案只处理“回合路由和交棒”。消息是否进入 Agent 上下文由独立的 `unseen messages` 机制处理。

## 2. 当前基线

当前工作树已经有一组未提交的群聊 at 改动，方案以它为基础，不覆盖这些改动：

- `src/core/pipeline.ts` 在群聊入站时识别有序的 Bot mention，只让第一个被 @ 的 Bot 进入 Agent；其他 Bot 的消息走 `storeMessageOnly`，不触发 Agent。
- `src/im/mentions.ts` 能把短号、唯一显示名转换为飞书真实 at；当前还保留了窄范围的漏写 at 补充逻辑。
- `src/memory/inject.ts` 给群聊 Agent 加了“交棒时要 at 对方”的提示。
- 数据库仍有 `messages.agent_seen` 和 `markMessagesAgentSeen`，但旧的通用 unseen 查询和注入逻辑已经移除。
- `src/core/loop.ts` 是定时/循环任务的状态机，不是群聊协作回合；不直接复用它作为跨设备协作状态。
- `AgentBackend` 现有可选的 `supportsCollabTurns()` 能力标记；CLI backend 通过当前回合令牌和 `nbt collab turn` 提交结构化动作，Pipeline 只接受活动回合中的一次动作。

现有首个 at 过滤只能解决“谁先开始”，不能保证后续回合，也不能防止 Agent 忘记交棒。因此需要在 Pipeline 中增加一个真正的、按话题串行推进的协作回合。

## 3. 范围和非目标

### 3.1 本任务范围

- 多 Bot 协作的明确启动。
- 每个 `chat + thread` 只有一个当前执行 Bot。
- Engine 维护当前回合的本地投影，并从话题消息链恢复。
- Agent 用结构化动作表达交棒或结束。
- Engine 生成真实 at，并把报告和 at 作为一条消息发送。
- 重复事件、重启、设备离线、发送不确定和用户中断的处理。
- 文本、卡片、回复等已有出站路径保持同一个交棒入口。

### 3.2 不在本任务范围

- `unseen messages` 的通用上下文注入。它可以另开任务恢复，不能用来判断回合目标。
- 普通群聊每条消息都自动启动多 Bot 讨论。
- 通过自然语言判断“这句话是不是在叫某个 Bot”。
- Bot 身份去重、跨群同名处理等独立问题。
- 改造 Goal/定时 Loop 的已有语义。
- 同一话题同时运行多条独立协作链。第一版一个话题只有一个活动协作。

## 4. 设计原则

### 4.1 路由和上下文分离

`at` 或 Engine 的回合状态只决定“谁执行”。`unseen messages`、话题历史和当前报告决定“Agent 能看到什么”。

一个没有被 @ 的消息可以存储并在后续回合进入上下文，但不能因此启动 Agent。

### 4.2 Engine 决定回合，Agent 只提供结果

Agent 不负责拼真实 at，不负责维护轮次，也不负责发送第二条消息。它只提供：

- 面向用户的报告文本；
- 一个结构化回合动作：交给哪个参与者，或结束。

Engine 校验动作后，完成发送、状态推进和重试。

### 4.3 消息链是跨设备事实，协议必须可见

不同设备不共享 NiuBot 内存和 SQLite 文件。第一版把同一话题中的飞书消息链作为跨设备事实：

- 话题/根消息确定 scope；
- 初始消息的有序 Bot at 确定参与者和起始顺序；
- 每次交棒/结束消息都 @ 全部参与 Bot，真实 at 的第一个 Bot 是唯一执行者；
- 每条协作消息末尾都有一行简短、可见的协议；
- 平台消息 ID 用于去重和恢复；
- 本地数据库只保存已收到的消息和当前投影。

单话题单协作限制仍然存在，但不能假定所有 Bot 都恰好收到前序消息。全员 @ 让每台设备有同一条状态事件；可见尾部让 Engine 能校验链号和轮次后恢复投影，不需要共享数据库、共享 baton 或中心锁。

普通消息超过两分钟会被当作过期消息丢弃；协作启动和协议消息例外，但不是直接放行。Engine 必须先同步该话题历史，确认这条消息仍是当前协作链最后一个有效触发点，才允许对应 Bot 执行。若历史已经有更新的启动或结束消息，只同步本地投影，不重启旧协作。

## 5. 协作生命周期

### 5.1 启动

用户在群聊话题中明确 @ 两个或以上已知 Bot，并按希望的顺序排列：

```text
用户：@U3(NiuBot) @U4(CowBot) 请先分析，再互相 review
```

所有被 @ 的设备都建立同一份本地投影；只有第一个 Bot 运行 Agent：

```text
scope: chat + thread
participants: [NiuBot, CowBot]
current: NiuBot
turn: 1
status: running
```

其他 Bot 只保存消息，不启动 Agent。启动条件只看结构化 mention 列表，不读正文语义。

### 5.2 单轮

当前 Bot 的 Agent 收到：

- 当前用户消息；
- 普通 session 需要的身份和规则；
- 当前话题可用的历史上下文；
- 仅在协作 session 中启用的回合动作能力。

它完成工作后必须产生一个且只有一个回合动作：

```ts
type CollabTurnDecision =
  | { action: "handoff"; to: string }
  | { action: "finish" };
```

`to` 使用稳定的 Bot 用户 ID，不使用显示名。Engine 要求目标必须属于本次参与者列表，且不能是当前 Bot。

### 5.3 交棒

Agent 选择：

```ts
collab_turn({ action: "handoff", to: "U4" })
```

这个动作不发送消息。Engine 等 Agent 回合完成后：

1. 取本轮最后一段面向用户的报告。
2. 把目标 Bot 放在真实飞书 at 列表第一位，再补齐其余所有参与 Bot。
3. 把报告、完整 at 列表和协议尾部合并成一条出站消息。
4. 记录当前出站消息的 platform message ID。
5. 将本地投影推进到下一轮。

用户看到的结果类似：

```text
NiuBot：分析报告……
@U4(CowBot) @U3(NiuBot) @U5(SheepBot)
〔协作 #7F3A91D2 · 第 2 回合〕
```

所有设备收到同一条真实 at；只有列表第一位 CowBot 的 Engine 执行。其余 Bot 更新本地投影，因此随后收到 `finish` 时也能确定地结束。Agent 不需要自己写 at，也不会出现报告先发、补丁 at 后发的时序问题。

### 5.4 结束

Agent 选择：

```ts
collab_turn({ action: "finish" })
```

Engine 发送当前报告，真实 @ 启动协作的提问者和全部参与 Bot，并追加完成协议；没有第一执行者。所有设备都把本地协作投影标为 `finished`，且没有任何 Bot 进入 Agent。

```text
NiuBot：结论……
@提问者
@U3(NiuBot) @U4(CowBot) @U5(SheepBot)
〔协作 #7F3A91D2 · 第 2 回合 · 完成〕
```

下一次用户重新用多 Bot at 启动时，建立新的协作投影。

### 5.5 用户中断

以下情况优先于继续交棒：

- 用户发送 `/stop`：取消当前 Bot，协作标记为 stopped。
- 用户明确开始新的多 Bot 请求：结束旧投影，按新消息创建新的协作。
- 用户只 @ 一个 Bot：按普通单 Bot 触发处理，不自动拉其他 Bot 进来。

普通用户补充消息不改变当前目标，但在协作仍为 `running` 时要投递给所有参与 Bot。当前执行者把消息放进自己的协作队列，其他 Bot 只保存为下一回合上下文；不根据远端 Agent 是否正在执行来决定是否投递。

## 6. 工具和消息协议

### 6.1 工具结论

需要一个统一的内部回合动作，但不需要三个独立工具，也不需要用户手动执行 `finish` 命令：

```text
collab_turn(action=handoff, to=bot)
collab_turn(action=finish)
```

工具的职责只有“提交本轮决定”。发送、真实 at、状态推进和重试都由 Engine 完成。

当前实现没有改造各 backend 的原生工具注册接口。CLI backend 使用环境变量中的当前回合令牌调用 `nbt collab turn`，本地 API 把动作写入活动 Pipeline 回合；测试型或原生适配层也可以直接返回 `AgentResponse.collabDecision`。不能提供该能力的 backend 不进入协作 loop，不退回自然语言猜测。

命令入口为：

```text
nbt collab turn --action handoff --to <目标稳定平台 ID>
nbt collab turn --action finish
```

命令只提交动作，不发送消息。API 和 Pipeline 会校验 scope、session、run、令牌、当前 Bot、参与者和重复提交。

回合动作还需要绑定当前 Engine 回合和 session，避免旧 Agent、普通 session 或手动执行的命令修改别的协作。

### 6.2 可见协议尾部

每个 Engine 生成的协作消息都追加：

```text
〔协作 #<链号> · 第 <轮次> 回合〕
〔协作 #<链号> · 第 <轮次> 回合 · 完成〕
```

链号由启动消息的平台消息 ID 稳定推导，短号只供展示和匹配；轮次从 1 开始。协议不展示稳定 Bot ID：参与者由同一条消息中的真实 at 表达，顺序中的第一位是唯一执行者；完成消息没有执行者。

协议由 Engine 注入，Agent 文本里出现的伪造协议会被剥除。入站要同时校验链号、轮次、前一执行者和参与者集合，才会推进状态。它既是用户可读的进度提示，也是跨设备的状态事件；不是给 Agent 的自由文本指令。

### 6.3 缺少动作时的行为

协作回合中，Agent 没有提交动作、提交多个互相冲突的动作，或提交非法目标时：

- 不发送报告，不自动猜测“交棒还是结束”；
- 记录明确错误和当前回合；
- 在同一 Agent session 内要求补交结构化动作；
- 重试失败时保持协作 `blocked`，等待用户干预或 `/stop`。

这样“忘记 at”不会静默变成一条无法继续的普通报告。

## 7. 跨设备恢复

### 7.1 正常交棒

U3 和 U4 分别运行在设备 A、B：

```text
设备 A：U3 Agent
  → Engine 取 handoff(to=U4)
  → 飞书发送报告 + @全体参与者 + 可见协议（@U4 排第一）

设备 B：U4 Engine
  → 收到同一条全员 @ 协议消息，发现自己排第一
  → 校验消息来源和话题
  → 从本地消息/飞书话题历史恢复上下文
  → U4 Agent 执行一轮
```

两台设备不需要直接通信，也不需要共享数据库。

### 7.2 设备重启或离线

- 入站事件由现有持久化 inbox 去重和重试。
- Bot 重启后先恢复本地话题消息和 session，再处理待执行的目标消息。
- 本地没有启动消息或前序报告时，只对带协议尾部的消息按 `thread_id` 补取飞书话题历史；历史补取失败则不伪造协作状态，也不额外发送干扰消息。
- 已经处理过的平台消息 ID 不再次启动 Agent。
- 出站使用现有持久化 outbox；发送结果不确定时不立即再发第二条，等待既有重试/确认路径。

### 7.3 不使用共享 claim

同一协作链中，下一目标由协议消息第一个真实 at 唯一确定。所有其他参与者仍收到消息并更新投影，不通过跨设备 claim 争抢。因此不新增磁盘锁、共享 baton 或超时让位机制。

同一 scope 的本地消息仍复用现有队列，保证单个 Engine 内不会并发运行同一话题的两个 Agent 回合。

## 8. 状态模型和幂等

当前实现使用数据库迁移 v39 的 `bot_collab_chains` 协作投影表，字段至少包括：

```text
scope_key
participants_json
current_bot_id
turn
status: running | finished | stopped | blocked
start_platform_msg_id
last_platform_msg_id
updated_at
```

它不是跨设备的唯一事实，只用于：

- 当前进程快速判断目标；
- 重启后恢复最近状态；
- 记录 blocked/finished 供 `/status` 和日志排查。

跨设备恢复仍必须能在本地投影缺失时从话题消息链重建。

幂等要求：

- 入站以平台消息 ID 去重。
- 同一 `scope + platform message ID` 只能产生一次 Agent 回合。
- 同一 Agent 回合只能提交一个有效动作。
- 出站成功后保存平台消息 ID；重复事件不能再发同一报告。
- 旧消息、非当前目标消息和参与者外目标全部只存储不执行；观察者仍会处理有效协议以同步状态。

## 9. 安全、权限和隐私

- 参与者只来自当前群聊中已识别的 Bot 平台身份，不信任正文里的名字。
- 回合动作使用稳定 Bot ID，不使用可变显示名。
- 协作状态限定在 `chat + thread`，不能跨群或跨话题复用。
- 动作能力只注入活动协作回合，并绑定当前 session/回合；普通 Agent 不能调用它修改协作。
- 日志只记录 run/scope、轮次、目标和结果，不记录凭证或完整报告正文。
- 不把内部状态、能力令牌或平台敏感信息写进用户可见消息、任务 README 或 prompt。

## 10. 模块实施拆解

### 阶段 1：协议模型和基线测试（已实现）

目标：先定义动作、状态和不变量，不改变普通对话。

涉及：

- 新增协作协议模块或放在 `src/core/` 的独立文件。
- `src/agent/types.ts` 增加 backend 能力边界或结构化动作类型。
- `src/core/pipeline.test.ts` 增加启动、单轮和非法动作测试。

验收：已由 `src/core/collab-loop.test.ts` 和 Pipeline 测试覆盖；动作只有 `handoff`/`finish` 两类，非法目标、重复动作、缺少动作都有明确结果。

### 阶段 2：Agent 动作接入（已实现）

目标：让各 backend 能提交同一种动作，Engine 不解析自然语言。

涉及：

- `src/agent/` 的能力接口。
- 各支持 backend 的工具/结构化输出适配和测试。
- 失败时的 capability 检查和错误提示。

验收：`nbt collab turn` 经本地 API 写入活动回合；能力不支持时协作停在 `blocked`，不会退回普通 Agent 回合。

### 阶段 3：Pipeline 回合推进（已实现）

目标：接上首个 at、当前目标、Engine 生成 at 和结束状态。

涉及：

- `src/core/pipeline.ts`、`src/core/queue.ts`
- `src/im/mentions.ts` 的真实 at 转换入口
- `src/core/response-sender.ts` 或出站调用边界
- 必要的数据库投影和迁移

验收：两 Bot、三 Bot、错误目标、finish、单 Bot 普通消息和现有 at 回归已通过；Engine 每轮只发送一条消息，@ 全部参与 Bot，并把唯一执行者排在第一位。

### 阶段 4：跨设备恢复和故障路径（代码和自动化测试已实现）

目标：验证消息总线真的能支撑设备分离。

涉及：

- 飞书话题历史读取和当前历史同步入口。
- inbox/outbox 重试与消息 ID 幂等。
- session 恢复、重启和 `/stop`。

验收：本地已覆盖消息链恢复、历史获取失败、重复事件、旧回合替换、队列隔离、发送失败和投影竞争；设备 B/设备 A 的真实飞书验收仍待执行。

### 阶段 5：独立恢复 unseen messages

目标：单独恢复 Agent 未见消息的上下文注入，不把它作为回合状态来源。

涉及：

- `messages.agent_seen` 查询和标记。
- 同一 chat/thread 的上下文边界。
- `src/memory/inject.ts` 和相关测试。

验收：未触发消息可以在后续 Agent 回合中作为只读上下文出现，但不会单独启动 Agent，也不会改变当前回合目标。

## 11. 测试矩阵

### 协议和单元测试

- handoff/finish 解析和校验。
- 当前 Bot、参与者外 Bot、重复目标、空目标。
- 缺少动作、多个动作、动作提交后 Agent 失败。
- 消息链重建参与者和当前目标。

### Pipeline 回归

- 多 Bot 初始消息只运行第一个。
- 两 Bot、三 Bot 串行交棒。
- Engine 自动生成真实 at，Agent 文本中没有 at 也能交棒。
- finish 广播给所有参与 Bot，但不触发任何 Agent。
- 单 Bot 群聊、普通 at、卡片、文本、回复路径不变。
- `/stop`、用户新启动、运行中用户消息和取消。

### 分布式和故障测试

- 三个独立 Pipeline/数据库模拟三台设备：A → B → finish，观察者 C 全程同步但不执行。
- 目标设备先收到历史后收到 at，或只收到 at 后补历史。
- 重复入站、乱序入站、进程重启、目标离线。
- 出站成功前崩溃、成功后崩溃、delivery uncertain。
- 同一话题没有两条协作同时运行。

### 分层验证

1. 定向协议、Pipeline、transport 测试。
2. 全量 `npm test`。
3. `npx tsc --noEmit`、`npm run build`。
4. `npm run pack:check`、`npm run pack:smoke` 或项目等价打包检查。
5. 两个真实飞书 Bot、两台设备、一个话题完成至少两轮和一次 finish。
6. 重启一个 Bot 后继续同一话题，确认没有重复回复和错误抢话。

### 已完成的自动化验证

2026-08-30 在当前工作树执行：

- 定向协作回归：9 个测试文件，342 项通过、1 项跳过。
- 全量 `npm test`：118 个测试文件，1284 项通过、3 项跳过。
- `npx tsc --noEmit`、`npm run build`：通过。
- `npm run pack:check`：296 个发布文件检查通过，无 `.map` 和 `src/` 文件。
- `npm run pack:smoke`：安装包冒烟通过，确认两个 home 共用未提交产物，legacy runtime 可接管并保留 current-only state。

尚未完成的是两个真实飞书 Bot、两台设备、同一话题的至少两轮交棒、`finish`、重启/离线恢复验收。

## 12. 兼容、发布和回滚

- 未进入协作 loop 的消息继续走现有 Pipeline 行为。
- 旧版 Bot 不理解内部动作时，不能把普通文本误当成协作回合；当前版本应在能力协商失败时停止协作并记录原因。
- 数据迁移只追加字段/表，支持重复启动和中断重入。
- 新功能先在功能分支和真实测试群验证，不覆盖工作树已有改动。
- 回滚代码后，历史协作消息只作为普通群消息处理，不删除消息和用户数据。
- 不在本任务中提交、合并、发布或重启生产实例；这些动作另行按授权执行。

## 13. 方案审查结论

本方案保留了最少的两个协议点：

1. Agent 必须提交一个结构化回合动作，避免 Engine 猜语义。
2. Engine 统一生成真实 at，避免 Agent 忘记或写错对象。

其余内容继续使用现有话题消息、消息 ID、队列、inbox/outbox 和 session 机制。只引入 Engine 注入的简短可见尾部；没有共享锁或额外发送通道。

`unseen messages` 后续可以单独恢复：它改善“下一棒能看到什么”，但不参与“下一棒是谁”。
