# NiuBot Installation Guide

This guide is written for coding agents (Claude, Codex, etc.) to follow when helping a user install and configure NiuBot. Each step includes commands, expected output, and what to do on failure.

## Prerequisites

- Node.js >= 20
- One of: `claude` CLI or `codex` CLI (the agent backend)
- A Feishu (Lark) enterprise account with permission to create apps

## Step 1: Install NiuBot

```bash
npm install -g niubot
```

Verify:
```bash
niubot version
# Expected: niubot v0.x.x
```

## Step 2: Initialize

```bash
niubot init
```

This will:
1. Check Node.js version
2. Scan available agent backends (claude, codex)
3. Create `~/.niubot/` with config template, env file, and persona file

Expected output:
```
NiuBot Init
───────────

Preflight checks
  ✓ Node.js vXX.X.X (>= 20 required)
  Scanning agent backends...
    ✓ claude vX.X.X
  → Using 'claude' as default backend

Initializing ~/.niubot ...
  ✓ Created ~/.niubot/
  ✓ Created config.yaml (backend: claude)
  ✓ Created .env
  ✓ Created NiuBot/persona.md

Status: ready for configuration
```

If `~/.niubot` already exists, use `niubot init --force` to overwrite.

To check environment without creating files: `niubot init --check`.

## Step 3: Create Feishu App (requires user action)

This is the only step that requires manual action from the user. Guide them through:

1. Open https://open.feishu.cn/app and create a new **Enterprise Self-Built App**
2. On the **Credentials & Basic Info** page, copy the **App ID** and **App Secret**
3. On the **Permissions** page, add these permissions:
   - `im:message` — Read and send messages
   - `im:message.reaction:write` — Message reactions
   - `im:resource` — Message resources (images/files)
   - `im:chat:readonly` — Read group chat info
   - `im:file` — File upload
4. On the **Bot** page, enable the **Bot** capability
5. Publish the app: Create a version → Submit for review → Release

## Step 4: Configure Credentials

Edit `~/.niubot/config.yaml` and fill in the Feishu app credentials:

```yaml
bots:
  - name: NiuBot
    appId: "cli_xxxxxxxxxx"       # ← App ID from Step 3
    appSecret: "xxxxxxxxxxxxxxxx" # ← App Secret from Step 3
```

Optional: configure admin users (Feishu user IDs) for elevated commands:

```yaml
bots:
  - name: NiuBot
    appId: "cli_xxxxxxxxxx"
    appSecret: "xxxxxxxxxxxxxxxx"
    adminUsers:
      - "ou_xxxxxxxxxxxxxx"
```

## Step 5: Configure Persona (optional)

Edit `~/.niubot/NiuBot/persona.md` to customize the bot's personality:

```markdown
> This file defines the bot's behavior style.

## Role
A friendly AI assistant.

## Style
Keep conversations natural and helpful.
```

## Step 6: Start and Verify

```bash
niubot start
```

Expected output:
```
Pre-start checks
  ✓ Config valid
  ✓ Bot 'NiuBot' credentials present
  ✓ claude CLI available
  ✓ Working directory exists
  ✓ No existing process running

Starting NiuBot...
  ✓ Process started (PID XXXXX)
  ✓ Health check passed

NiuBot is running.
  Log: ~/.niubot/logs/niubot-YYYY-MM-DD.log
  API: ~/.niubot/NiuBot/api.sock
```

If pre-start checks fail, fix the reported issues and retry.

## Service Management

```bash
niubot status    # Check if running
niubot stop      # Stop the service
niubot start     # Start the service
niubot start --restart  # Restart (stop + start)
```

## Troubleshooting

### Check fails: "Bot credentials empty"
Fill in `appId` and `appSecret` in `~/.niubot/config.yaml`.

### Check fails: "claude CLI not found"
Install the Claude CLI, or switch to codex by setting `backend: codex` in config.

### Health check fails after start
Check the log file at `~/.niubot/logs/niubot-YYYY-MM-DD.log` for errors. Common causes:
- Invalid Feishu credentials
- Missing Feishu permissions
- Agent backend CLI not working

### Custom backend plugin
To use a custom agent backend, create a plugin file and declare it in config:

```yaml
backends:
  my-agent:
    plugin: "./backends/my-agent.js"
    liteModel: "my-lite-model"

default_config:
  backend: my-agent
```

See the plugin API docs for implementation details (`niubot/plugin` export).
