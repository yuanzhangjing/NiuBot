# NiuBot

AI Persona Runtime — 让 AI agent 以独立人格驻扎在 IM 中，有记忆、有性格、能自主管理上下文。

## 让 Coding Agent 帮你安装

NiuBot 提供了 [INSTALL.md](./INSTALL.md)，专为 coding agent 编写的安装手册。直接把下面这段话丢给你的 Claude Code / Codex：

> 帮我安装和配置 NiuBot。按照 https://github.com/yuanzhangjing/NiuBot/blob/main/INSTALL.md 的步骤操作，需要我手动做的地方告诉我。

## 手动安装

### 方式一：npm 全局安装

```bash
npm install -g niubot
```

### 方式二：从 GitHub Release 安装

```bash
# 直接安装（需要 repo 访问权限）
npm install -g https://github.com/yuanzhangjing/NiuBot/releases/download/v0.1.0/niubot-0.1.0.tgz
```

或手动下载 [Release 页面](https://github.com/yuanzhangjing/NiuBot/releases) 的 `.tgz` 文件后：

```bash
npm install -g ./niubot-0.1.0.tgz
```

### 验证

```bash
niubot version
# niubot v0.1.0
```

### 快速开始

```bash
# 1. 初始化配置
niubot init

# 2. 配置飞书凭据（按 init 输出的提示操作）
#    编辑 ~/.niubot/config.yaml，填入 appId 和 appSecret

# 3. 启动
niubot start
```

## 服务管理

```bash
niubot start            # 启动
niubot stop             # 停止
niubot status           # 查看状态
niubot start --restart  # 重启
```

## 前置要求

- Node.js >= 20
- 飞书企业自建应用（需开通 Bot 能力）
- Agent backend：`claude` CLI 或 `codex` CLI

## 自定义 Backend 插件

NiuBot 支持自定义 agent backend，无需修改引擎代码。详见 [INSTALL.md](./INSTALL.md#custom-backend-plugin) 中的插件开发说明。

## License

Apache-2.0
