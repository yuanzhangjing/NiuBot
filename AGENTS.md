# NiuBot Engine — 开发指南

NiuBot 是一个 AI 人格运行时：有记忆、有性格、能自主管理上下文，通过 IM 和人沟通。
核心差异化：**上下文自治** — 用户不需要管理 session，系统自主决策何时新建、压缩、切换、恢复。

`AGENTS.md` 是当前项目的源文件。`CLAUDE.md` 只是指向它的软链接，后续统一改这一个文件。

## 目录结构

```
src/
├── core/        # 核心引擎（pipeline, queue, routing, cron）
├── agent/       # Agent backend 抽象和公共类型
├── backends/    # 内置 backend（claude / codex / traecli）
├── im/          # IM 平台适配（feishu）+ 消息渲染（render.ts）
├── memory/      # 上下文注入（inject）+ 记忆管理（user-memory, chat-summary）
├── database/    # SQLite schema + migrations
├── cli/         # nbt CLI 工具（messages, contacts, task, cron, send）
└── index.ts     # 入口
```

## 开发约定

### 构建和测试
```bash
npm run build        # tsc 编译
npx tsc --noEmit     # 类型检查（不生成文件）
```

### 发版规范
```bash
npm run release -- patch
```

- 以 npm 为准，不再创建 GitHub Release 包。
- 发版统一走 `npm run release -- <patch|minor|major>`。
- 不要手动执行零散的 `npm version`、`npm publish`、手工打 tag、单独 push tag，除非你就是在修发版脚本本身。
- 发版脚本会负责：
  - 检查 git worktree 必须干净
  - 执行 `npm run release:check`
  - 创建 npm 版本和对应的 `vX.Y.Z` git tag
  - 发布到 npm
  - 推送当前分支和 tags（`--follow-tags`）
  - 发布后核验 npm 上的版本

### 重启服务
修改代码后需要重启才能生效。使用安全重启脚本：
```bash
NIUBOT_HOME=~/.niubot bash restart.sh
```
流程：build → backup dist → stop → start → health check → rollback on failure

### 代码规范
- TypeScript strict mode
- 日志用 `createLogger`，不用 `console.log`
- DB 操作用 prepared statements
- 新增 DB 字段走 migration（`src/database/schema.ts`）
- 保持 IM 卡片、footer、命令输出格式一致，避免同类功能各写一套样式

### 关键架构
- **Pipeline**（`src/core/pipeline.ts`）：消息入口 → 存 DB → 队列缓冲（3s）→ flush（platformTs 排序 + YAML 合并）→ 路由决策 → session 管理 → agent 调用 → IM 发送
- **消息渲染**（`src/im/render.ts`）：统一 YAML 格式 — 独立消息纯文本，回复 `- msg: + quoted:`，转发 `- forward: + messages:`，多条合并为 YAML 列表
- **三层上下文注入**：Static（AGENTS.md）→ Important（system prompt: 场景+记忆）→ Normal（user prompt 前缀: 摘要+归档+recall）
- **Session 生命周期**：new → active（每条消息 --resume）→ archive（归档摘要）；进程重启 recover（DB 读 agent_session_id → --resume）
- **Built-in backends**（`src/backends/*.ts`）：Claude、Codex、Trae CLI 的内置适配；公共抽象在 `src/agent/`
- **内置命令**：三层分发 — builtin switch → shell exec（admin）→ forward to agent

## 任务管理

项目进展优先记录在 issue、PR 或公开文档中。不要把个人工作空间路径、私有任务目录或未公开项目资料写进仓库文件。
