# 内置 Backend 开发契约

新增或修改 `src/backends/*` 时读这份。  
`CliAgentBackend` 只包了「起进程 → 传 prompt → 解析输出」。能上线的 backend 还必须满足下面整份契约；缺一项就会在真机一轮轮踩坑。

参考实现：`claude.ts`、`pi.ts`、`cursor-agent.ts`、`grok.ts`。

## 注册清单（缺一不可）

1. `src/backends/<name>.ts` + `<name>.test.ts`
2. `src/config.ts` → `AGENT_REGISTRY`（aliases、command、versionArgs）
3. `src/index.ts` → `BUILTIN_BACKEND_PATHS` 动态 import
4. `src/user-cli.ts` 无 backend 时的安装提示
5. 支持 effort 时：`pipeline.ts` 的 `EFFORT_SUPPORTED_BACKENDS`
6. stable context 测试：`builtin-stable-context.test.ts`
7. capability 数量测试：`backend-capability.test.ts`
8. session 归档：`session-archive/native-transcript.ts` + `reader.ts` + 测试

## 必实现能力

### 1. 会话与 resume

| 要求 | 说明 |
|---|---|
| 首轮能拿到 agent session id | 越早越好：流式首事件 / 预分配 `--session-id` / 首条 JSON |
| `agentSessionId` 语义 | **仅在 CLI 真正开场后**写入；预分配 id 用单独字段（如 `clientSessionId`），否则失败首轮会被当成已开场 |
| 后续轮 resume | 有 id 后必须走 resume/continue，不能重复 create |
| 崩溃半开场 | 若本地 session 目录/文件已存在，下一轮必须 resume，不能再 create 同 id |
| 进程重启 recover | pipeline 会把 DB 里的 `agent_session_id` 塞进 `SessionConfig.agentSessionId` |

### 2. 用户可见回复（最容易错）

| 要求 | 说明 |
|---|---|
| 只发**当前轮最后一条**面向用户的 assistant 文本 | 不能把 tool 前的旁白、流式碎片拼成一条 |
| 优先读原生 session 文件 | stdout 终态字段经常是「整轮拼接」（cursor `result`、grok `text`） |
| 终态事件与失败 | `error` 之后可能还有 `end`/`result`；有 error 必须 `failed`，不能当成功回复 |
| `turnCompleted` | 只有**回合**终态才算完成（`result` / `agent_end` / `turn.completed` / grok **本轮** `turn_started` 之后的 `turn_ended`）。grok 本进程 stdout `end` 仍可收摊；上一轮残留的结束标记、上一句回答、以及别人进程的 `end` 不能当本轮完成 |

### 3. Token 与 footer

| 要求 | 说明 |
|---|---|
| `contextTokens` = **当前上下文占用** | 不是本轮 spend / 累计 cache 计费 |
| 有官方「窗口占用」字段就用它 | 如 grok `signals.json` 的 `contextTokensUsed` |
| 不要用含大额 cache 的 total 直接当占用 | 脚注会在几十 k 和几百万之间跳 |
| `contextWindow` | 有就填，footer 可展示 |
| `compactCount` | 一次 compact 只 +1（end/boundary 计一次，不要 start+end 各算一次） |

### 4. System / stable context

| 要求 | 说明 |
|---|---|
| `needsStableUserPrefix()` | 能 append system/rules → `false`，并在 `buildInput` 自行交付 |
| 不能 append 时 | `true`，pipeline 前缀进首条 user |
| `needsCompactRecoveryReminder()` | workspace rules 已含恢复段（cursor）→ `false`；否则默认 `true` |
| 敏感内容 | `argsForLog` 必须 redact 消息、system prompt、rules 等 |

### 5. 模型与 effort

| 要求 | 说明 |
|---|---|
| `--model` / 等价参数 | `SessionConfig.model` 有值才传 |
| effort | CLI 支持则透传；并加入 `EFFORT_SUPPORTED_BACKENDS` |
| `validateModel` / `isProbeError` | probe 失败应识别「模型不存在」，不要误杀其它错误 |
| probe 副作用 | 尽量别污染用户真实 session 目录（临时 home/cwd） |

### 6. Watchdog 与 `/status`

基类会把 **stdout 每一行**先塞进 `activity.recentLines`（环形 3 条）。流式 text 碎片会污染 `/status`。

| 要求 | 说明 |
|---|---|
| `getExecHooks` | `onLine` 尽早抓 session id；`isComplete` 识别终态以便提前 resolve |
| `refreshActivity` | 从**原生 session 文件**刷最近日志，覆盖 stdout 碎片 |
| 最近日志来源 | 优先 message/history jsonl 最后几行原文；展示层已有 `ERROR_DISPLAY_MAX_LEN` 截断 |
| `probeSessionFileMtime` | 长任务无 stdout 时靠文件 mtime 证明还活着 |
| `probeSessionLastLine` | 可选；与 cursor 对齐时实现 |
| `compacting` | 识别 compact 起止；**不要**被后续 text/tool 行误清掉（见 `cli-base` 对 `auto_compact_*` 的处理） |
| `executingTool` | 有工具进行中时标 true，避免 idle 误杀 |

### 7. 归档

| 要求 | 说明 |
|---|---|
| `loadSessionTranscript` | 读原生 history/jsonl |
| 未开场 | 抛 `AgentSessionNotStartedError`（归档会 discarded，不是 archive_failed） |
| transcript 解析 | 用户 / assistant / tool_call / tool_result 字段与真实文件对齐，用真数据对过再写 |

## 接入顺序（建议）

1. **先读 CLI 真文档 + 本机跑一轮**，确认 stdout 格式、session 目录、history 文件名  
2. 实现 `buildInput` / `parseOutput` 最小闭环（含 resume）  
3. 接 last-message（history 优先）  
4. 接 session id 时机 + 文件路径 + `probeSessionFileMtime`  
5. 接 token / compact  
6. 接 `refreshActivity` 状态日志  
7. 接 transcript 归档  
8. 注册 registry / index / effort / 测试  
9. **真机**：`/agent <name>` → 多轮对话 → `/status` → 看 footer token → compact 若可触发 → `/model` `/effort` → 重启后 resume  

不要只靠单测：stdout fixture 容易和真实 CLI 漂移。

## 单测最低覆盖

- 新会话参数（含 system/rules、model、effort）
- resume 参数
- 解析成功路径（text、sessionId、tokens）
- 无终态 → incomplete
- error / error+终态 → failed
- last-message 优先于拼接 stdout
- history 与 stdout 不一致时的兜底
- `argsForLog` 脱敏
- `refreshActivity` 覆盖 stdout 碎片
- 目录已存在时 create→resume

## 已知 CLI 差异（不是漏实现）

- 有的 CLI 只能 `-p` 传消息（进程列表可见），有的走 stdin  
- session 目录命名各家不同（realpath、slug、encodeURIComponent）  
- 终态事件名不同：`result` / `agent_end` / `end` / `turn.completed`  
- token 字段有的是窗口占用，有的是计费 total——以「占用」为准  

## 反模式

- 只实现 `parseOutput` 读 stdout 终态 `text`/`result`，不读 history  
- 用 spend `total_tokens`（含大 cache）当 footer 上下文  
- 等进程退出才第一次知道 session id  
- 依赖基类默认 `recentLines`（stdout 原样）当 `/status` 日志  
- 预分配 id 直接写进 `agentSessionId`，失败首轮被当成已开场  
- 对照另一个 backend 抄完就发版，不经真机多轮 + `/status` + 重启 resume  
