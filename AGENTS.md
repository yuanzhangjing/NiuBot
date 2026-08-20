# NiuBot Engine — Agent 开发指南

NiuBot 是 AI 人格运行时：有记忆、有性格、能自主管理上下文，通过 IM 和人沟通。  
核心差异化：**上下文自治**——用户不需要管 session，系统自己决定新建、压缩、切换、恢复。

`AGENTS.md` 是本仓库规则源文件。`CLAUDE.md` 是指向它的软链接；只改这一份。

| 文档 | 用途 |
|---|---|
| 本文件 | 整体架构、开发/测试/发版、质量门槛 |
| [`src/backends/AGENTS.md`](src/backends/AGENTS.md) | 新增/修改内置 Backend 的完整契约 |

---

## 仓库与目录

```
src/
├── core/           # Pipeline、队列、运行态、Goal/Loop/Cron、footer
├── agent/          # Backend 抽象、cli-base、capability
├── backends/       # 内置 CLI backend（claude/pi/cursor/grok/…）
├── im/             # 飞书适配 + 消息渲染
├── memory/         # 用户记忆与上下文注入
├── database/       # SQLite schema + migrations
├── session-archive/# 原生 transcript 解析与归档
├── worker/         # 内部 Worker 运行时
├── transport/      # 持久化 inbox/outbox
├── platform/       # 跨平台进程/路径/IPC/防休眠等
├── cli/            # nbt 子命令实现
├── local-api/      # Engine 本地 API
├── user-cli.ts     # niubot / nbt 用户入口
└── index.ts        # Engine 入口
```

运行数据默认在 `~/.niubot/<BotName>/`（DB、profile、session 归档、api.sock）。  
CLI 侧工具：`nbt`（消息/记忆/任务/发送/重启/Goal…）。

---

## 关键怎么串起来

1. **IM 入站** → transport 落库 → Pipeline 收消息  
2. **缓冲合并**（默认约 1.5s）→ 按时间排序 → 渲染成 agent 输入  
3. **Session**：有则 resume，无则新建；stable context 按 backend 能力注入  
4. **Backend 子进程**跑一轮 → 解析终态 → 取**用户可见回复**  
5. **出站**：卡片/文本发回 IM；footer 带 session 短 id、token、compact、模型  
6. **旁路**：watchdog（idle/compact）、`/status`（activity + 最近日志）、归档、Worker/Goal/Loop  

### 关键模块

- **Pipeline**（`core/pipeline.ts`）：消息总控、内置命令、session、agent 调用、发送  
- **CliAgentBackend**（`agent/cli-base.ts`）：起进程、stdout 行、activity、cancel  
- **Backends**（`backends/*.ts`）：各 CLI 参数、解析、session 文件、token/compact  
- **Render**（`im/render.ts`）：YAML 消息格式（独立 / 引用 / 转发 / 合并）  
- **三层上下文**：Static（workspace AGENTS.md）→ Important（system：身份/规则/记忆）→ Normal（任务、最近消息、归档引用）  
- **Session 生命周期**：new → active（每轮 resume）→ archive；Engine 重启后 DB recover + resume  

### 内置命令分发

1. Pipeline 内置 switch（`/agent` `/model` `/effort` `/status` `/restart`…）  
2. admin shell  
3. 其余转给 agent  

---

## 开发约定

### 构建与测试

```bash
npm test                 # 全量单测（发版门槛）
npm run build            # 编译 dist/
npx tsc --noEmit         # 只类型检查
npm run release:check    # test + build + pack:check + pack:smoke
```

改 backend / pipeline 至少要：

1. 相关单测绿  
2. 真机：`/agent <name>` 多轮、`/status`、footer token、重启后 resume  
3. 需要生效时 `nbt restart`（或源码目录安全重启流程）  

### 代码规范

- TypeScript strict  
- 日志用 `createLogger`，不要 `console.log`  
- DB 用 prepared statements；改表走 migration（只追加，保持兼容）  
- IM 卡片、footer、命令回执格式保持一致  
- 用户数据经 `nbt` 访问，不要直接读 Bot DB 文件  

### 改动范围

- 只改任务需要的代码；不顺手大重构  
- 测试与实现一起交；不要只交「看起来能跑」的解析逻辑  
- 注释只写非显而易见的约束，不写过程流水账  

---

## 发版

```bash
npm run release -- patch   # 或 minor / major
```

- **必须**走上述命令；不要手搓 `npm version` / `npm publish` / 单独打 tag  
- worktree 必须干净  
- 脚本会跑 `release:check`，再 version + tag，再 `git push --follow-tags`  
- npm 发布由 GitHub Actions `Publish` 承接：先跑与 CI 相同的 OS/Node 矩阵，**全部绿了才 `npm publish`**  
- 打 `v*` tag 不再单独跑一遍 CI，避免和发包抢跑  
- 是否发版听用户/负责人明确指令；默认不擅自发版  

发版后本机若要吃正式包：等 registry 出包再 `/update`。dev 源码重启用的是本地 build，与 npm 版本不是一回事。

### 重启

```bash
nbt restart
# 或源码侧安全重启（build → 快照 → 健康检查 → 失败回滚）
```

改 Engine / backend 代码后必须重启才进正在跑的进程。

### 运行环境 `NIUBOT_ENV`

- 显式：`dev` | `production`  
- 未声明时：路径含 `node_modules` → production；源码含 `src/` → dev；兜底 production  
- **仅 dev** 的 release 安装可走 `--prefer-offline`；生产更新始终拉最新依赖  
- 旧 `NIUBOT_RUNTIME_MODE` 只保留读取兼容  

---

## 新增 / 修改 Backend

**先读 [`src/backends/AGENTS.md`](src/backends/AGENTS.md)。**

那里是完整契约，摘要：

1. 注册：registry、index 动态加载、CLI 提示、effort 集合、归档解析、相关测试  
2. 会话：尽早拿到 session id；`agentSessionId` 只在真正开场后写入；resume / 半开场目录  
3. 回复：只发当前轮最后一条用户可见 assistant；history 优先于拼接 stdout  
4. Token：上下文**占用**，不是 spend/cache 累计  
5. Watchdog / `/status`：用原生 session 文件刷最近日志，盖住 stdout 碎片  
6. 失败：`error` 后仍可能有 `end`/`result`，必须 `failed`  
7. 真机验收：多轮、`/status`、footer、compact（若有）、重启 resume  

`CliAgentBackend` 不够用时不要猜——按契约打勾，再对照 claude/pi/cursor/grok 的参考实现。

---

## 质量门槛（上线前）

| 层级 | 要求 |
|---|---|
| 单测 | 相关文件 + 全量 `npm test` 绿 |
| 构建 | `npm run build` / pack:check 绿 |
| 契约 | Backend 变更过一遍 `src/backends/AGENTS.md` |
| 真机 | 主路径 + `/status` + token 观感 + 失败路径至少各一次 |
| 审查 | 正确性 / 失败路径 / 敏感信息脱敏；有明确阻塞项先修再发 |
| 发版 | 仅在明确授权后 `npm run release -- <bump>` |

已知可接受边界要写进 PR/结论（例如某 CLI 只能 `-p` 传消息、进程列表可见）。

---

## 任务与协作

- 正式任务用 `nbt task`；进度写在任务 README（目标、状态、入口、决策、下一步），不写聊天流水  
- 用户记忆用 `nbt user-memory`（人相关偏好）；项目进度不要塞记忆  
- 发文件 / 卡片：`nbt send`  
- 多轮交付用 Goal（`nbt goal start/progress/finish`）；长任务可拆 Worker  

不要把个人本机绝对路径、私有未公开资料写进仓库文档。

---

## 反模式

- 只解析 stdout 终态字段就当 backend 完成  
- 用计费 `total_tokens` 当 footer 上下文占用  
- 不跑真机、只靠 fixture 发版  
- 发版手搓 version/tag/publish  
- 改完代码不重启就断言「线上已生效」  
- 大段无关重构混进功能提交  
