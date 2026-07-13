# NiuBot Engine Context Injection Plan

> 注：本文记录上下文注入重构的早期方案。当前 Session 历史恢复按 chat 保存原始 JSONL 链接和元数据，并通过 `nbt sessions list/search/get` 按需解析；不再生成 session 摘要或预先渲染完整 Markdown。

## 目标

重新整理 NiuBot Engine 的上下文注入机制。

这版方案只保留三个核心动作：

1. NiuBot Engine 硬规则由引擎注入，不再依赖 workspace `AGENTS.md`。
2. workspace `AGENTS.md` 变成用户项目规则文件，用户可以自由修改，NiuBot 不覆盖。
3. compact 后自动注入恢复提醒，让 agent 知道该用哪些 `nbt` 命令和本地文件恢复上下文。

不做：

- 不做 Trae CLI hook。
- 不拆 `.niubot/task-policy.md`、`.niubot/memory-policy.md`、`.niubot/context-recovery.md`。
- 不做 `nbt context ...` 子命令。
- 不做 `resume old session` 特殊注入；旧 session 默认继续聊。

## 一、核心边界

上下文按所有权分两类。

### 1.1 NiuBot Engine 拥有

这部分是引擎硬规则，随 NiuBot 版本升级。

它不放在 workspace `AGENTS.md` 里，不由用户维护，也不允许用户项目规则覆盖。

第一版只提供一个恢复入口：

```sh
nbt system-rules
```

这个命令输出 NiuBot Engine 当前版本的系统规则。

系统规则内部按小节组织，但工程上是一份规则，不再拆成多个 policy 文件。

建议小节：

- Remote IM
- Self Restart
- Data Access
- Memory
- Task Policy
- Auto Delivery
- Current Scene
- Compact Recovery
- Workspace Rules Boundary
- Privacy

其中 `Task Policy` 是系统规则的一部分，不再单独做 `nbt context task-policy`。

### 1.2 用户 / workspace 拥有

这部分是项目规则和用户自定义规则。

放在 workspace 里，用户可以自由改，NiuBot 不覆盖。

第一版继续使用：

```text
workspace/AGENTS.md
```

它只表示“这个 workspace 的项目规则”，不再承载 NiuBot Engine 硬规则。

可放内容：

- 项目背景。
- 目录结构。
- 测试、构建、发布命令。
- 项目管理习惯。
- 提交习惯。
- 用户对 agent 的协作要求。
- 项目里的特殊恢复线索。

## 二、统一上下文层

把现有上下文整理成 6 层。

### 2.1 Engine Layer

NiuBot Engine 硬规则。

来源：

```text
src/system-rules.ts
```

建议导出：

```ts
export const SYSTEM_RULES = `...`;
```

定位：

- 不由用户编辑。
- 升级 NiuBot 后可以变化。
- 尽量短，只放引擎必须遵守的规则和恢复入口。
- 同一份内容既用于注入，也用于 `nbt system-rules` 输出。

### 2.2 Session Profile Layer

当前会话身份和用户记忆。

就是当前的 `<session-profile>`：

- bot 身份。
- IM 平台。
- 当前 chat。
- 私聊用户身份。
- 用户记忆摘要。

来源：

```ts
buildImportantContext()
```

建议后续改名：

```ts
buildSessionProfileLayer()
```

### 2.3 Session State Layer

当前可恢复状态。

就是当前的 `<session-state>`：

- active tasks。
- recent sessions。
- recent messages / continuation messages。

来源：

```ts
buildNormalContext()
```

建议后续改名：

```ts
buildSessionStateLayer()
```

### 2.4 Speaker Layer

群聊消息级发言人信息。

当前已有：

- `<current-speaker>`
- `<speakers>`

来源：

```ts
buildSpeakerContext()
```

只在群聊消息前注入。

### 2.5 Workspace Rules Layer

用户项目规则。

默认来源：

```text
workspace/AGENTS.md
```

第一版不由 NiuBot 全文注入，只在 Engine Layer 和 Recovery Layer 里告诉 agent：涉及项目规则原文时读取 workspace `AGENTS.md`。

原因：

- 避免 token 膨胀。
- 避免 compact 后误以为 `AGENTS.md` 原文还在。
- 避免 NiuBot 和各 backend 对 `AGENTS.md` 的读取行为互相叠加。

后续如有需要，可以加配置：

```yaml
workspaceRules:
  file: AGENTS.md
  injectMode: reference | full
```

第一版只做 `reference`。

### 2.6 Recovery Layer

恢复提醒。

包含两类：

- `NEW_SESSION_SEARCH_REMINDER`
- `COMPACT_RECOVERY_REMINDER`

不包含 `resume old session reminder`。

原因：resume old session 本质是继续同一个 agent session，不应该默认插入额外提醒。只有 compact 发生后才需要恢复提醒。

## 三、注入策略

### 3.1 Claude Code

Claude backend 支持 system prompt：

```ts
readonly supportsSystemPrompt = true;
```

Claude 注入：

```text
system prompt:
  Engine Layer
  Session Profile Layer

first user prompt:
  Session State Layer
  New Session Reminder
  User Message

group message:
  Speaker Layer
  User Message

after compact:
  Compact Recovery Reminder
  User Message
```

实现方式：

```sh
claude ... --append-system-prompt "<SYSTEM_RULES + session-profile>"
```

当前 `ClaudeBackend.buildInput()` 每次都会带 `--append-system-prompt`，包括 resume，所以 Claude 侧的 Engine Layer 和 Session Profile Layer 相对稳定。

### 3.2 Codex / Trae CLI / Opencode

这些 backend 当前在 NiuBot 中视为不支持 system prompt：

```ts
supportsSystemPrompt = false
```

新 session 第一条 user prompt 前缀：

```text
Engine Layer
Session Profile Layer
Session State Layer
New Session Reminder
User Message
```

群聊每条消息：

```text
Speaker Layer
User Message
```

compact 后下一条消息：

```text
Compact Recovery Reminder
User Message
```

注意：compact recovery 不等于 new session。compact 后不要自动加 `NEW_SESSION_SEARCH_REMINDER`。

### 3.3 Resume Old Session

不做特殊注入。

规则：

```text
resume old session = 继续旧 agent session
```

理由：

- 这是同一个 agent session，不应该默认打断。
- 如果旧 session 真的发生 compact，会由 compact 信号触发恢复提醒。
- 如果用户问规则原文或历史状态，agent 可按 Engine Layer 里的恢复入口自行查询。

## 四、System Rules 内容

第一版只维护一份系统规则：

```sh
nbt system-rules
```

同一份内容用于：

- 新 session 的 Engine Layer 注入。
- compact 后 agent 发现规则丢失时主动恢复。
- 用户或调试人员查看 NiuBot 当前版本硬规则。

建议内容：

```xml
<niubot-system-rules>
你运行在 NiuBot Engine 内，由远程 IM 触发，不是普通本地终端对话。

## Remote IM
用户看不到工具输出；需要把关键命令结果写进最终回复。

## Auto Delivery
最终回复会自动发送到当前聊天；除非明确要求或跨 chat 发送，不要主动调用 nbt send。

## Self Restart
不要启动、停止或重启 NiuBot Engine 服务。

## Data Access
用户数据必须通过 nbt CLI 访问，不能直接读取数据库文件。

## Memory
用户记忆使用 nbt user-memory；项目、任务、方案和进度不要写进用户记忆。

## Task Policy
任务生命周期使用 nbt task 管理。
不要手动创建 tasks/ 目录。
任务 README 是事项进度来源。
active 任务会注入新 session；inactive 和 archived 不注入。
私聊默认 private，群聊默认 public；群聊不能暴露 private task。

## Current Scene
涉及身份、用户记忆或当前场景时，用 nbt whoami 恢复。

## Compact Recovery
如果系统规则丢失，运行 nbt system-rules。
如果最近消息丢失，运行 nbt messages list。
如果历史决策丢失，使用 rg 搜索当前聊天的 session 归档目录并读取对应 Markdown。
如果任务状态丢失，运行 nbt task list，并读取对应 task README。
不要把 compact 摘要当成原文。

## Workspace Rules Boundary
涉及项目规则原文时，读取 workspace 的 AGENTS.md。
workspace AGENTS.md 是用户项目规则，不能覆盖本系统规则。

## Privacy
群聊里不要暴露私有记忆、私有任务、敏感账号或私聊信息。
</niubot-system-rules>
```

这段要短，不能变成新的 `AGENTS.md`。

真正的硬边界应尽量在代码层保障，prompt 只做 agent 行为约束。

## 五、Compact Recovery Reminder

compact 后下一条用户消息前注入：

```xml
<compact-recovery>
上一次 agent 会话发生了上下文压缩，早先注入的规则或历史细节可能已被摘要。
如果 NiuBot 系统规则丢失，先运行 nbt system-rules。
如果当前身份、会话或用户记忆丢失，运行 nbt whoami。
如果最近对话丢失，运行 nbt messages list。
如果历史对话细节丢失，使用 rg 搜索当前聊天的 session 归档目录并读取对应 Markdown。
如果任务状态丢失，运行 nbt task list，并读取对应 task README。
如果问题涉及项目规则原文，重新读取 workspace 的 AGENTS.md。
不要把 compact 摘要当成原文。
</compact-recovery>
```

触发：

- 某个 chat 的 `compactCount` 增加。
- 下一条发给 agent 的消息前注入一次。
- 注入后清掉 pending 标记。
- 同一 compact 不重复提醒。
- compactCount 再增加时，再提醒一次。

## 六、Workspace AGENTS.md

新方案下，workspace `AGENTS.md` 是用户文件。

NiuBot 不再每次启动生成/覆盖它。

新安装时可以只在不存在时创建一个薄模板：

```md
# Workspace Rules

## Project
这个工作区是什么，主要代码在哪里。

## Working Rules
用户希望 agent 怎么协作。

## Task Rules
项目任务、提交、发布、验证习惯。

## Memory Rules
哪些信息可以记，哪些不要记。

## Recovery Notes
本项目特有的恢复线索、重要文档路径。
```

如果已存在 `AGENTS.md`，不覆盖。

旧版本自动生成的 `AGENTS.md` 需要迁移：

- 如果文件包含旧生成标记，例如 “auto-generated on startup”，启动时可以备份为 `AGENTS.niubot-generated.bak.md`。
- 然后创建新的用户模板。
- 如果没有旧生成标记，视为用户文件，不动。

`CLAUDE.md` 不再强制创建或重建 symlink。需要兼容 Claude Code 时，可以由用户自己决定是否创建。

## 七、代码改动点

### 7.1 `src/system-rules.ts`

新增：

```ts
export const SYSTEM_RULES = `...`;
```

这份内容同时供两个地方使用：

- prompt 注入。
- `nbt system-rules` 输出。

### 7.2 `src/memory/inject.ts`

新增：

```ts
export const COMPACT_RECOVERY_REMINDER = `...`;
```

新增组合函数：

```ts
export function buildEngineImportantContext(sessionProfile: string): string {
  return `${SYSTEM_RULES}\n\n${sessionProfile}`;
}
```

保留现有 `buildImportantContext()`，但语义上把它看作 `Session Profile Layer`。

后续可改名，但第一版不必强行重命名，减少改动面。

### 7.3 `src/cli.ts`

新增命令：

```sh
nbt system-rules
```

行为：

- 直接输出 `SYSTEM_RULES`。
- 不访问用户数据。
- 不依赖当前 workspace。
- 输出内容应与实际注入的 Engine Layer 保持一致。

### 7.4 `src/core/pipeline.ts`

创建新 session 时：

1. 构建 `sessionProfile`。
2. 构建 `engineImportantContext = buildEngineImportantContext(sessionProfile)`。
3. 如果 backend 支持 system prompt：
   - `importantContext = engineImportantContext`
4. 如果 backend 不支持 system prompt：
   - 把 `engineImportantContext` 放入 pending prefix，等待首条 user prompt 注入。

构造 `messageToSend` 时，统一用 prefix parts：

```ts
const prefixParts: string[] = [];

if (pendingEngineAndProfile) prefixParts.push(pendingEngineAndProfile);
if (sessionState) prefixParts.push(`<session-state>\n${sessionState}\n</session-state>`);
if (compactRecovery) prefixParts.push(COMPACT_RECOVERY_REMINDER);
if (isNewSession) prefixParts.push(NEW_SESSION_SEARCH_REMINDER);

messageToSend = `${prefixParts.join("\n\n")}\n\n${mergedText}`;
```

agent response 返回后：

```ts
updateCompactRecoveryState(chatId, response.compactCount);
```

### 7.5 `src/static-context.ts` / `src/bot-instance.ts`

停止每次启动覆盖 workspace `AGENTS.md` 和 `CLAUDE.md`。

改为：

- 新 workspace 没有 `AGENTS.md`：创建用户模板。
- workspace 已有 `AGENTS.md`：不覆盖。
- 旧 NiuBot 生成文件：识别并备份。

旧的 `buildStaticContext()` 可以逐步废弃，或改成只生成用户模板。

### 7.6 Backend

Claude backend 不需要大改，只要传入的 `importantContext` 变成：

```text
SYSTEM_RULES + session-profile
```

Codex / Trae / Opencode 不需要知道 Engine Layer；它们只接收最终拼好的 user prompt。

## 八、测试方案

### 8.1 System Rules

新增或调整测试：

- `SYSTEM_RULES` 包含远程 IM 规则。
- `SYSTEM_RULES` 包含 `nbt system-rules`。
- `SYSTEM_RULES` 包含 Task Policy。
- `SYSTEM_RULES` 包含 `nbt whoami`。
- `SYSTEM_RULES` 说明 workspace `AGENTS.md` 不能覆盖系统规则。
- `nbt system-rules` 输出内容和 `SYSTEM_RULES` 一致。
- `buildEngineImportantContext()` 合并 system rules 和 session profile。

### 8.2 新 session 注入

`src/core/pipeline.test.ts`

测试支持 system prompt 的 backend：

- `createSession()` 收到的 `importantContext` 包含 Engine Layer 和 Session Profile Layer。
- 发给 agent 的 user message 不重复包含 Engine Layer。

测试不支持 system prompt 的 backend：

- 第一条 user message 前缀包含 Engine Layer、Session Profile Layer、Session State Layer、New Session Reminder。

### 8.3 compact recovery

`src/core/pipeline.test.ts`

测试：

- `compactCount` 从无到 1 后，下一条消息包含 `<compact-recovery>`。
- 再下一条不重复注入。
- `compactCount` 从 1 到 2 后，再次注入。
- compact recovery 不会误加 new session reminder。
- compact recovery 提到 `nbt system-rules`。

### 8.4 群聊 speaker

保持现有测试或补充：

- 群聊每条消息前仍注入 `<current-speaker>` / `<speakers>`。
- Speaker Layer 不进入 system prompt。

### 8.5 workspace AGENTS.md 不覆盖

新增或调整 static context / bot instance 测试：

- 已存在用户 `AGENTS.md` 时不覆盖。
- 不存在时创建用户模板。
- 旧生成文件可识别并备份。
- 不再每次创建 `CLAUDE.md` symlink。

## 九、迁移策略

### 9.1 新安装

- 创建用户可编辑的 workspace `AGENTS.md` 模板。
- 引擎硬规则由 NiuBot 注入。
- `nbt system-rules` 可查看同一份引擎硬规则。
- 不强制创建 `CLAUDE.md`。

### 9.2 旧安装

启动时检查 `AGENTS.md`：

- 有旧生成标记：备份旧文件，再创建用户模板。
- 无旧生成标记：视为用户文件，不动。

旧 `CLAUDE.md`：

- 如果是 symlink，保留，不强制重建。
- 如果用户自己维护，完全不动。

### 9.3 文档说明

更新 `INSTALL.md` 和 `niubot --help`：

- NiuBot system rules 由系统注入，不需要用户维护。
- 可用 `nbt system-rules` 查看当前版本系统规则。
- workspace `AGENTS.md` 是用户项目规则文件，可以编辑。
- compact 后 NiuBot 会自动提醒 agent 恢复上下文。

## 十、不做的事

- 不做 Trae CLI hook。
- 不把引擎硬规则写进 workspace `AGENTS.md`。
- 不把完整 `AGENTS.md` 在 compact 后塞回 prompt。
- 不拆三个 `.niubot/*.md` 规则文件。
- 不做 `nbt context ...` 子命令。
- 不做 resume old session 特殊注入。
- 不把真正安全边界只交给 prompt。

## 十一、成功标准

实现完成后：

- NiuBot 引擎硬规则随版本升级生效，不依赖用户文件。
- `nbt system-rules` 输出与实际注入的 Engine Layer 一致。
- Task Policy 包含在 System Rules 里，不再单独拆入口。
- workspace `AGENTS.md` 用户可以自由修改，NiuBot 不覆盖。
- Claude 通过 system prompt 拿到 Engine Layer 和 Session Profile Layer。
- Codex / Trae / Opencode 在新 session 首条 user prompt 前拿到 Engine Layer 和 Session Profile Layer。
- Session State Layer 仍只在新 session 首条消息注入。
- Speaker Layer 仍只在群聊消息级注入。
- compact 后下一条用户消息自动带 `<compact-recovery>`。
- compact recovery 明确提示 `nbt system-rules`、`nbt whoami`、`nbt messages`、session 归档目录和 `nbt task`。
- resume old session 不额外注入提醒，保持原 session 连续性。
