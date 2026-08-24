# 长任务进展汇报——调研现状与方案（Pending）

> 状态：**PENDING**（方案已调研，未实施，需求暂停）
> 日期：2026-08
> 相关：`docs/execution-model.md`（执行模型现状）

## 1. 需求

长任务（主 Agent 多轮 subagent 循环）执行期间，用户希望看到
中间进展汇报，而不是干等最终结果。

用户期望的形态：**在任务进行中、某个 turn 时，检测到进度慢 → 往该次模型调用
注入一段 prompt 提醒模型汇报进展**（不是常驻规则、不是机械卡片）。

## 2. 现状（已确认）

| 场景 | 用户感知 | 机制 |
|---|---|---|
| 主 Agent 长任务 | ✅ 有粗粒度 | watchdog：每小时「任务还在运行」卡片、10/30 分钟无输出提醒、活动恢复提醒 |
| subagent 中间输出 | ❌ 不送达 | Auto Delivery 回合结束才发最终回复 |
| 主 Agent 回合内 | ✅ 可主动 | `nbt send` CLI（回合内显式调用是唯一主动发送路径） |

## 3. 注入通道调研（各 backend）

目标能力：**运行中（turn 中途）向模型注入提示**。

### 3.1 Claude Code（默认 backend）——✅ 能力确认

hooks 完整事件列表（官方文档）：

| 事件 | 触发 | 注入 Prompt？ | 注入位置 |
|---|---|---|---|
| `SessionStart` / `Setup` | 会话开始 | ✅（JSON/纯文本 stdout） | 对话开头 |
| `UserPromptSubmit` / `UserPromptExpansion` | 每轮用户消息 | ✅（JSON/纯文本 stdout） | prompt 旁 |
| `PreToolUse` | 每次工具调用前 | ✅（JSON only） | 工具结果旁 |
| `PostToolUse` / `PostToolUseFailure` / `PostToolBatch` | 工具调用后 | ✅（JSON） | 工具结果旁 |
| `Stop` / `SubagentStop` | turn 末尾 | ✅（JSON，对话继续） | turn 末尾 |
| `PreCompact` | 压缩前 | ❌ | — |
| `Notification` 等异步事件 | 各种 | ❌ | — |

**注入格式**（JSON，exit 0）：
```json
{"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": "提示内容"}}
```
- **本机实测验证通过**：PreToolUse JSON 注入，agent 明确感知到注入内容
- 纯文本 stdout 只对 `UserPromptSubmit` / `SessionStart` 生效，其他事件必须 JSON

### 3.2 Codex CLI——✅ 文档确认（实测待调试）

- hooks 系统：`~/.codex/hooks.json` 或项目 `.codex/hooks.json`，
  结构 `{"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [...]}]}}`
- **注入机制与 Claude 相同**：`hookSpecificOutput.additionalContext`（JSON）
- 官方文档确认能力；本机实测未复现（exec 模式 hook 未触发/超时），
  不影响能力存在的结论——实施前需补一次交互模式验证
- 需要 `features.codex_hooks = true`（版本 ≥0.117）

### 3.3 其他 backend

| Backend | 注入能力 | 备注 |
|---|---|---|
| opencode | ❓ 仅 plugin 系统，无 hooks 接口 | 未验证 plugin 是否含 hook 能力 |
| pi | ❌ 无 hooks | 仅回合开始 `--append-system-prompt` |
| cursor / traecli | ❓ | 本机未安装，未验证 |

## 4. 方案选项（已讨论）

1. **hooks 注入（推荐方向）**：PreToolUse hook 检测会话运行时长超阈值 →
   JSON 注入 `additionalContext`（"任务已运行 X 分钟，请用 nbt send 简短汇报进展"）
   → 下一次模型请求 agent 收到并汇报。
   - 覆盖 backend：claude ✅、codex ⚠️（待实测）、其余降级
2. **UserPromptSubmit 注入**：回合开始时注入规则（整回合生效）——效果接近常驻规则，
   非"运行中按需"
3. **机制卡片兜底**：watchdog 检测主 Agent 运行超时 → 发「⏳ 仍在执行」卡片
4. **架构级**：backend 分段执行（turn-based 交互，NiuBot 控制轮次）——
   任意 turn 边界注入，但改动架构级，暂不立项

## 5. 决策状态

- **需求状态：PENDING**（用户 2026-08 决定先不做）
- 未来启动时的入口：
  1. 补 codex hooks 交互模式实测
  2. hook 脚本（progress-reminder）：时间戳记录 + 阈值判断 + JSON 注入 + 防重复
  3. NiuBot 侧：spawn CLI 时把 hook 配置带进会话（`--settings` 参数 / managed settings）
  4. 覆盖范围：claude + codex；无 hooks 的 backend 保持"完成即交付"

## 6. 参考

- Claude Code hooks 文档：https://code.claude.com/docs/en/hooks
- Codex hooks 文档：https://developers.openai.com/codex/hooks
- 执行模型：`docs/execution-model.md`
