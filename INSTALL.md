# NiuBot Installation Guide

This guide is for **coding agents** (Claude Code, Codex, etc.) to follow when helping a user install NiuBot. Each step has concrete commands, expected output, and decision branches.

Human users: run `niubot init` and follow the prompts. You don't need to read this.

---

## Prerequisites

- Node.js >= 18
- A Feishu (Lark) enterprise account with permission to create apps

## Step 1: Install NiuBot

```bash
npm install -g @yuanzhangjing/niubot@latest
```

The installed command is still `niubot`.

Verify:
```bash
niubot version
# Expected: niubot v0.x.x
```

## Step 2: Select Agent Backend

NiuBot ships with built-in backends. Pick one whose CLI is installed:

| Backend | CLI command |
|---------|-------------|
| `claude` | `claude` (Claude Code) |
| `codex` | `codex` (OpenAI Codex) |
| `traecli` | `traecli` (Trae CLI) |
| `opencode` | `opencode` |
| `cursor` | `cursor-agent` (Cursor Agent CLI) |
| `pi` | `pi` (Pi coding agent) |

Check availability:

```bash
claude --version
codex --version
traecli --version
opencode --version
cursor-agent --version
pi --version
```

If at least one is available, note which one the user wants (e.g. `claude`). Before writing config, also ask whether they want a separate `liteModel` for cheaper background tasks. Proceed to [Step 2.1](#step-21-generate-config).

If none are available, tell the user to install one first.

#### Pi backend

Pi uses its own native config under `~/.pi/agent/`:

| File | Purpose |
|------|---------|
| `auth.json` | API keys (`/login` or manual) — **primary key source** |
| `models.json` | Custom providers/endpoints/models (no `apiKey` unless you manage env yourself) |
| `settings.json` | `defaultProvider`, `defaultModel`, `defaultThinkingLevel` |

NiuBot does **not** inject `~/.niubot/.env.deepseek-bak` or auto-edit Pi files. Configure Pi once, then set `backend: pi` in NiuBot. Provider, default model, and thinking level come from Pi `settings.json`; NiuBot only passes `--model` when you set `model` / `liteModel` in NiuBot config.

Example DeepSeek via Anthropic-compatible API:

```json
// ~/.pi/agent/auth.json
{
  "anthropic": { "type": "api_key", "key": "your-api-key" }
}
```

```json
// ~/.pi/agent/models.json
{
  "providers": {
    "anthropic": {
      "baseUrl": "https://api.deepseek.com/anthropic",
      "api": "anthropic-messages",
      "models": [
        {
          "id": "deepseek-v4-pro",
          "reasoning": true
        },
        {
          "id": "deepseek-v4-flash",
          "reasoning": true
        }
      ]
    }
  }
}
```

Do **not** put `"apiKey": "$ANTHROPIC_API_KEY"` here unless that env var is always set — otherwise Pi may hang waiting for a key. Use `auth.json` instead.

```json
// ~/.pi/agent/settings.json
{
  "defaultProvider": "anthropic",
  "defaultModel": "deepseek-v4-pro",
  "defaultThinkingLevel": "xhigh"
}
```

`defaultThinkingLevel` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. NiuBot does not pass `--thinking`; change this file to adjust thinking depth.

Install Pi CLI:

```bash
npm install -g @earendil-works/pi-coding-agent
pi --version
```

### Step 2.1: Generate Config

Create the config directory and files:

```bash
mkdir -p ~/.niubot
```

Write `~/.niubot/config.yaml`:

Before filling the config, ask the user the following questions **one at a time** (each answer affects the next question's defaults — do NOT combine them into a single prompt):

**Ask 1 — Bot ID**: default `NiuBot`. Immutable after setup — determines data directory and default workspace path. Wait for answer before proceeding.

**Ask 2 — Working directory**: default `~/niubot-workspace/<Bot ID from Ask 1>`. Show the computed default, ask if they want a different path.

**Ask 3 — Model** (optional): main model for conversations. Skip to use the CLI's default.

**Ask 4 — Lite model** (optional): cheaper model for background tasks. Recommended defaults:
- `claude`: `haiku`
- `codex`: `gpt-5.4-mini`
- `traecli`: `Gemini-3-Flash-Preview`
- `opencode`: `opencode-go/deepseek-v4-flash`
- `cursor`: `composer-2.5-fast`
- `pi`: `deepseek-v4-flash`

Example `config.yaml`:

```yaml
bots:
  - id: NiuBot
    backend: claude
    appId: ""
    appSecret: ""
    # model: ""
    # liteModel: ""
    # workingDirectory: ~/niubot-workspace/<id>
```

Config fields:
- `id`: Unique bot identifier (immutable). Determines data directory (`~/.niubot/<id>/`) and default workspace (`~/niubot-workspace/<id>/`). **Do not change after setup.**
- `backend`: Agent backend to use (required). One of: `claude`, `codex`, `traecli`, `opencode`, `cursor`, `pi`.
- `model`: Main model for conversations. Omit to use the CLI's default.
- `liteModel`: Cheaper model for background tasks (archive summaries). Omit = same as main model.
  Recommended examples for built-in backends:
  - `claude`: `haiku`
  - `codex`: `gpt-5.4-mini`
  - `traecli`: `Gemini-3-Flash-Preview`
- `workingDirectory`: Where the agent runs. Default: `~/niubot-workspace/<id>`.

Optional restart source directory for local development:

```yaml
restart:
  sourceDirectory: /path/to/niubot/source
```

When this is set, `/restart` runs that source tree's `restart.sh` and passes it as `NIUBOT_SOURCE_DIR`. If the directory contains `src/`, the restart script uses dev mode: build, package, preflight, switch release, then health check. Without this setting, `/restart` keeps using the currently running package directory.

Create default bot profile:

```bash
mkdir -p ~/.niubot/NiuBot
```

Write `~/.niubot/NiuBot/bot_profile.md`:
```markdown
# Bot Profile

> Only admins may ask the bot to modify this file.

## Persona

### Role
简洁清晰、有温度的技术同事。

### Style
- 先把结论说清楚，再解释必要原因。
- 用平实中文，不说黑话，不写客服腔。
- 语气克制、自然，有一点人情味，但不刻意安抚。

## Instructions

- 技术内容要准确，步骤要具体。
- 不确定时先说明不确定，再用工具或 nbt 恢复上下文。
```

## Step 3: Create Feishu App and Get Credentials (requires user action)

Guide the user through these steps:

1. Open https://open.feishu.cn/app and create a new **Enterprise Self-Built App**
2. On the **Credentials & Basic Info** page, copy the **App ID** and **App Secret**
3. On the **Bot** page, enable the **Bot** capability

**Important**: Do NOT add permissions, create a version, or publish the app yet. The "receive message" event requires an active WebSocket connection, which is only established after the engine starts. Permissions are configured in Step 5, and the version must be created AFTER all permissions are in place (Step 6).

## Step 4: Fill Credentials and Start Engine

After the user provides App ID and App Secret, write them into `~/.niubot/config.yaml`:

```yaml
bots:
  - id: NiuBot
    backend: claude
    appId: "cli_xxxxxxxxxx"        # <- from Step 3
    appSecret: "xxxxxxxxxxxxxxxx"  # <- from Step 3
```

Then start the engine to establish the WebSocket connection:

```bash
niubot start
```

Expected output:
```
Pre-start checks
  ✓ Config valid
  ✓ Bot 'NiuBot' credentials present
  ✓ claude CLI available
  ✓ No existing process running
  ✓ Working directories exist

Starting NiuBot...
  ✓ Process started (PID XXXXX)
  ✓ NiuBot health check passed

NiuBot is running.
  Log: ~/.niubot/logs/niubot-YYYY-MM-DD.log
  API: ~/.niubot/NiuBot/api.sock
```

If pre-start checks fail, fix the reported issues and retry.

## Step 5: Configure Permissions (requires user action)

Now that the engine is running and has established a WebSocket connection with Feishu, guide the user to configure permissions:

### 5.1 Batch-enable non-review permissions

On the **权限管理** page, batch-enable all non-review permissions in these groups (use the exact group names on the website):
- **消息与群组**
- **云文档**
- **应用信息**

No need to add permissions one by one — Feishu supports batch-enabling all non-review permissions within each group.

### 5.2 Add "receive message" event

On the **事件订阅** page, add:
- `im.message.receive_v1`

This event is only available after the bot has established a WebSocket connection (which happened in Step 4).

## Step 6: Publish and Verify

1. **Publish the app**: Create a version → Submit for review → Release
2. **Verify**: Ask the user to send a message to the bot in Feishu. The bot should respond within a few seconds.

If no response, check the log:
```bash
tail -50 ~/.niubot/logs/niubot-$(date +%Y-%m-%d).log
```

## Admin System

Admin is auto-detected — no manual configuration needed:
1. If `application:application:readonly` permission is granted, the Feishu app creator becomes **owner** on startup.
2. Otherwise, the first user to send a private message to the bot becomes **owner**.

Two admin levels:
- **owner**: full control, can manage other admins. Cannot be removed.
- **admin**: has admin commands (/agent, /restart, shell), but cannot manage other admins.

Admin commands (in chat):
- `/admin` — list current admins
- `/admin add @user` — add an admin (owner only)
- `/admin remove @user` — remove an admin (owner only)

## Service Management

```bash
niubot status           # Check if running
niubot stop             # Stop the service
niubot start            # Start the service
niubot start --restart  # Restart (stop + start)
```

## Troubleshooting

### "Bot credentials empty"
Fill in `appId` and `appSecret` in `~/.niubot/config.yaml`.

### "claude CLI not found"
Install the Claude CLI, or switch backend: set `backend: codex` or `backend: traecli` on the bot entry.

### "bot missing 'backend'"
Add `backend: claude` (or `codex` / `traecli`) to the bot entry in config.yaml.

### Health check fails after start
Check the log for errors:
```bash
tail -100 ~/.niubot/logs/niubot-$(date +%Y-%m-%d).log
```
Common causes: invalid Feishu credentials, missing permissions, agent CLI not working.

---

## Adding a Bot

This section is for adding a **new bot** to an existing NiuBot installation. If you haven't installed NiuBot yet, start from [Step 1](#step-1-install-niubot).

There are two ways:
- **CLI** (quick): `niubot add-bot` — interactive prompts, handles config and directory setup
- **Manual** (agent-guided): follow the steps below

### Quick: CLI Command

```bash
niubot add-bot
```

The CLI will walk through: backend selection → Bot ID → model config → Feishu credentials → update config.yaml → create data directory. If the service is running, it offers to restart.

After the CLI finishes, continue to [Post-Setup: Feishu Permissions](#post-setup-feishu-permissions) below.

### Manual: Step-by-Step

#### 1. Choose a Bot ID

Pick a unique ID (e.g. `MyBot`). This determines the data directory (`~/.niubot/<id>/`) and cannot be changed after setup.

Check existing bots to avoid conflicts:
```bash
cat ~/.niubot/config.yaml   # look at the bots array
```

#### 2. Create Bot Directory and Profile

```bash
mkdir -p ~/.niubot/<BotID>
```

Write `~/.niubot/<BotID>/bot_profile.md`:
```markdown
# Bot Profile

> Only admins may ask the bot to modify this file.

## Persona

### Role
简洁清晰、有温度的技术同事。

### Style
- 先把结论说清楚，再解释必要原因。
- 用平实中文，不说黑话，不写客服腔。
- 语气克制、自然，有一点人情味，但不刻意安抚。

## Instructions

- 技术内容要准确，步骤要具体。
- 不确定时先说明不确定，再用工具或 nbt 恢复上下文。
```

#### 3. Append Bot to config.yaml

Read existing `~/.niubot/config.yaml` and append a new entry to the `bots` array. **Do not modify or remove existing bot entries.**

```yaml
bots:
  - id: ExistingBot          # ← keep existing entries untouched
    backend: claude
    appId: "cli_xxx"
    appSecret: "xxx"

  - id: NewBot                # ← append new bot
    backend: claude            # claude / codex / traecli / opencode / cursor / pi
    appId: "cli_yyy"          # from Feishu app (Step 4)
    appSecret: "yyy"
    # model: ""               # optional: main model
    # liteModel: ""           # optional: lite model for background tasks
    # workingDirectory: ~/niubot-workspace/NewBot  # optional
```

Recommended lite models by backend:
| Backend | Suggested liteModel |
|---------|-------------------|
| claude | `haiku` |
| codex | `gpt-5.4-mini` |
| traecli | `Gemini-3-Flash-Preview` |
| opencode | `opencode-go/deepseek-v4-flash` |
| cursor | `composer-2.5-fast` |
| pi | `deepseek-v4-flash` |

#### 4. Create Feishu App (if new)

Each bot needs its own Feishu app. If you already have one, skip to credentials.

1. Open https://open.feishu.cn/app and create a new **Enterprise Self-Built App**
2. **Credentials & Basic Info** → copy App ID + App Secret
3. **Bot** page → enable Bot capability
4. Fill the credentials into config.yaml

**Important**: Do NOT add permissions or publish yet — that requires an active connection (see below).

#### 5. Restart and Load

```bash
niubot start --restart
```

Wait for the health check to pass for the new bot.

### Post-Setup: Feishu Permissions

After the engine is running with the new bot:

1. **权限管理** → batch-enable non-review permissions in: 消息与群组, 云文档, 应用信息
2. **事件订阅** → add `im.message.receive_v1`
3. **Create a version** → publish the app
4. **Verify**: send a message to the bot in Feishu
