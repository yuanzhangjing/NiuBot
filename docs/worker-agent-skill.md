# 主 Agent 派工 Skill（Worker）

> 本文档教主 Agent 何时派工、如何操作 `nbt worker` CLI。Worker 功能未启用（`/worker off`）时不要派工。

## 何时派工

用户需求满足以下特征时，考虑创建 Work 并派给Worker：

- 任务较长或耗时（调研、审查、实现），不需要用户实时确认；
- 可以拆成独立子任务（如"调研 A"、"审查 B"）；
- 适合让 Worker 在后台执行，主 Agent 先结束回合；
- 只读任务（调研/审查/分析）随时可用；写任务（开发）使用 `git_worktree`（已废弃自动 worktree，按 scratch 独立工作目录处理，git 操作由 Worker 按任务指引自行执行，base 提交/分支写进任务内容）。

不派工的情况：普通聊天、需要立即交互确认、涉及外部副作用（发布、部署、发送消息）的需求。

## 操作流程

### 1. 创建 Work

```bash
nbt worker work create --file /tmp/work.md
```

`/tmp/work.md` 内容 = 用户原始需求（Markdown 自由格式）。输出 Work ID（`wrk_...`）。

### 2. 创建 Job

```bash
nbt worker job create --work <work-id> --worker <profile> --file /tmp/job.md [--workspace read_only|scratch|git_worktree] [--workdir <dir>]
```

- `--worker`：`general` / `researcher` / `reviewer`（只读），`developer`（写，使用 `git_worktree` 独立工作目录；git 操作由 Worker 自行执行，base 提交/分支约束写进 job 内容）；
- `/tmp/job.md` 内容 = 明确任务 + 完成标准 + 必要上下文（自由 Markdown）；
- `--workdir`：目标目录（git_worktree 时为目标 git 仓库路径）；
- 输出 Job ID（`job_...`）。

可以一次创建多个 Job（并行执行，受并发上限约束）。

### 3. 结束当前回合

创建 Job 后回复用户"已开始处理"，结束回合。Worker 完成后你会被自动唤醒验收。

### 4. 验收回合

被唤醒后你会收到 `<worker-continuation>` 内部区段（Work 目标 + 各 Job 结果文本）。此时：

- 结果满足需求 → 直接给用户最终回复；正文发送成功后 Work 自动完成；
- 结果不完整 → 创建后续 Job（可携带补充信息）；
- 需要用户输入 → 直接提问；正文成功发送后本次 Work 自动完成，用户补充后另开 Work；
- 无法继续 → 向用户说明原因；成功发送后 Work 自动完成。

### 5. 其他操作

```bash
nbt worker list                # 当前会话的 Work/Job 状态
nbt worker get <id>            # 详情（Job 最终文本、错误、产物）
nbt sessions get <job-id>      # 查看 Worker 当前或已结束的 session 日志/工具调用
nbt worker cancel <id>         # 取消 Work 或 Job
nbt worker complete --force --work <id> --file <结论.md>  # 仅用于人工修复异常悬挂的 Work
nbt worker config show         # 当前 Worker 配置
nbt worker config draft --file /tmp/team.yaml   # 生成配置草案（管理员确认后应用）
```

## 配置草案（管理员）

需要自定义 Worker 时生成配置草案：

```yaml
maxConcurrent: 4
maxJobsPerWork: 10
profiles:
  - id: reviewer
    description: 代码审查
    access: read_only
    prompt: |
      你是代码审查 Worker。...
    skills:
      include: [code-review]
```

流程：`nbt worker config draft --file <yaml>` → 输出 draft ID → 请管理员执行 `/worker config draft <id>` 查看、`/worker config apply <id>` 确认应用。**主 Agent 不能直接应用配置**。

## 边界

- Worker 不直接回复用户；最终回复只能由主 Agent 给出。
- `nbt worker` 的创建、追加、取消、人工修复和配置写入都通过本地 IPC 交给当前 Pipeline；CLI 只直接读取状态，不直接修改 Worker 数据库。
- 主 Agent 不需要手工完成 Work：验收回合未创建后续 Job且最终正文发送成功时，Engine 自动收尾。
- Worker 无主会话上下文和用户记忆；需要历史时把必要信息写进 Job 文件。
- 主 Agent 需要检查 Worker 的实际进展时，用 `nbt sessions get <job-id>`；session 尚未启动完成时会提示暂无日志，稍后重试。
- 同一 Work 的后续 Job 复用同一工作区（文件保留），不同 Work 隔离。
- 写 Job 的修改留在 worktree（`niubot-worker/<jobId>` 分支），不自动提交、不 push。
