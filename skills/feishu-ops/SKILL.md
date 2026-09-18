---
name: feishu-ops
description: 飞书操作统一入口：用 `nbt feishu <lark-cli 参数>` 以当前 Bot 身份执行官方 lark-cli，具体命令读官方 lark-* 技能；用户要求用其本人身份时加 --as user。遇到飞书链接或任何飞书操作时使用；不要手拼 Open API、不要绕过 nbt feishu 直接调 lark-cli、不要用第三方 feishu-cli 替代。
---

# feishu-ops —— 飞书操作：身份 + 路由

## 用法

- 所有飞书操作走 `nbt feishu <参数...>`：nbt 会自动确保 lark-cli 可用、当前 Bot 的身份就绪，然后以该身份执行。官方技能/文档里的 `lark-cli <X>` 一律写成 `nbt feishu <X>`。
- 命令细节读官方技能：`lark-shared`（底座：身份、输出契约、风险规则）、`lark-doc`、`lark-wiki`、`lark-sheets`、`lark-base`、`lark-drive`、`lark-im`、`lark-task`、`lark-calendar` 等；也可以现场 `nbt feishu <域> --help`。

## 身份

- **默认 = 当前 Bot（应用身份）**：不需要配置凭据，不要读取或回显 appSecret；不要用 `--profile` 指向其他 Bot。
- **用户身份是显式路径**：用户要求以其本人身份操作个人资源（私有文档、日历、邮箱等）时加 `--as user`；前提是该用户本人完成过一次交互式授权（`nbt feishu auth login`，需要用户配合，Bot 不能代办）。未登录时会返回 `identity: user` / `available: false`，把登录指引交给用户。
- 身份与权限的完整规则（缺 scope、文档无权限、高风险写确认等）见官方 `lark-shared` 技能。
