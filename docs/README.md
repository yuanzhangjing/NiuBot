# NiuBot 文档索引

这里放仓库级的执行模型、设计方案和调研记录。任务的长期状态放在工作区的 `tasks/*/README.md`，不要在这里复制任务进度流水。

## 当前文档

| 文档 | 状态 | 用途 | 关联任务 |
|---|---|---|---|
| [执行模型](execution-model.md) | 现行 | 主会话、独立任务、进度、重启和发布的实际行为 | [niubot-engine](<../../../tasks/niubot-engine/README.md>) |
| [多 Bot 协作回合方案](bot-collab-loop-plan.md) | 现行方案 | 协作回合、交棒、恢复和幂等设计 | [bot-collab-loop](<../../../tasks/bot-collab-loop/README.md>) |
| [上下文恢复优化方案](context-recovery-optimization-plan.md) | 已实现方案 | system rules、session、speaker 和 workspace 规则注入设计 | [niubot-engine](<../../../tasks/niubot-engine/README.md>) |
| [Worker Runtime 设计](<../../../tasks/NiuBot 内部 Worker/worker-runtime-design.md>) | 已收口方案 | Worker 的 Job、取消、恢复和工作区隔离 | [NiuBot 内部 Worker](<../../../tasks/NiuBot 内部 Worker/README.md>) |
| [Windows 原生支持设计](<../../../tasks/NiuBot Windows 适配/windows-native-node-first-design.md>) | 已收口方案 | Windows 安装、进程、IPC、更新和 backend 验收 | [NiuBot Windows 适配](<../../../tasks/NiuBot Windows 适配/README.md>) |

## 历史或暂停记录

| 文档 | 状态 | 说明 |
|---|---|---|
| [飞书群聊 Bot 互叫](feishu-bot-to-bot.md) | 历史方案 | 普通 Bot 互叫和 at 规则；协作回合以新方案为准 |
| [长任务进展汇报调研](progress-reporting-research.md) | 暂停 | 只保留调研结果，统一进展协议尚未实施 |
| [运行时架构重构方案](<../../../tasks/niubot-engine/runtime-pipeline-refactor.md>) | 历史方案 | 代码已完成，具体现状以执行模型和代码为准 |

## 维护规则

- 新设计先放对应任务目录；只有会被代码维护者反复查阅的仓库级方案才放这里。
- 文档顶部写清日期和状态；完成后保留文档，不删除历史决策。
- 任务状态、验收结果和下一步只在任务 README 维护，避免两处内容漂移。
