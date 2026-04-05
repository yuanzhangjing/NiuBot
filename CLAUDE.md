# NiuBot Engine — 开发指南

NiuBot 是一个 AI 人格运行时：有记忆、有性格、能自主管理上下文，通过 IM 和人沟通。
核心差异化：**上下文自治** — 用户不需要管理 session，系统自主决策何时新建、压缩、切换、恢复。

## 目录结构

```
src/
├── core/        # 核心引擎（pipeline, routing, prompts）
├── agent/       # Agent backend（claude-cli）
├── im/          # IM 平台适配（feishu）
├── memory/      # 记忆注入（context builder）
├── database/    # SQLite schema + migrations
└── index.ts     # 入口
```

## 开发约定

### 构建和测试
```bash
npm run build        # tsc 编译
npx tsc --noEmit     # 类型检查（不生成文件）
```

### 重启服务
修改代码后需要重启才能生效。使用安全重启脚本：
```bash
NIUBOT_BOT_NAME=NiuBot NIUBOT_HOME=~/.niubot bash restart.sh
```
流程：build → backup dist → stop → start → health check → rollback on failure

### 代码规范
- TypeScript strict mode
- 日志用 `createLogger`，不用 `console.log`
- DB 操作用 prepared statements
- 新增 DB 字段走 migration（`src/database/schema.ts`）
- 对齐 cc-connect 的实现风格（飞书卡片、footer 格式、命令输出格式等）

### 关键架构
- **Pipeline**（`src/core/pipeline.ts`）：消息入口 → 队列 → 路由决策 → session 管理 → agent 调用 → IM 发送
- **三层上下文注入**：Static（AGENTS.md）→ Important（system prompt: 场景+记忆）→ Normal（user prompt 前缀: 摘要+归档+recall）
- **Session 生命周期**：new → active（每条消息 --resume）→ archive（归档摘要）；进程重启 recover（DB 读 agent_session_id → --resume）
- **内置命令**：三层分发 — builtin switch → shell exec（admin）→ forward to agent

### 对齐参考
NiuBot 的能力和实现风格对齐 cc-connect（Go 版本），代码在 `/Users/yuanmouren/workspace/cc-connect/`。
关键对齐点：飞书卡片格式、footer 信息、命令输出格式、restart 流程、context 注入架构。

## 任务管理

进展和设计文档统一在工作空间的 task 中管理：
- 任务目录：`../../tasks/niubot-engine/`
- 进展跟踪：`../../tasks/niubot-engine/README.md`（Bug / Todo / In Progress / Done 分区）
- 设计文档：同目录下的 `.md` 文件

开发完成后及时更新 README.md 中对应条目的状态。
