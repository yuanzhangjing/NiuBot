# NiuBot Installation Guide

This guide is for **coding agents** (Claude Code, Codex, etc.) to follow when helping a user install NiuBot. Each step has concrete commands, expected output, and decision branches.

Human users: run `niubot init` and follow the prompts. You don't need to read this.

---

## Prerequisites

- Node.js >= 18
- A Feishu (Lark) enterprise account with permission to create apps

## Step 1: Install NiuBot

```bash
npm install -g @yuanzhangjing/niubot
```

The installed command is still `niubot`.

Verify:
```bash
niubot version
# Expected: niubot v0.x.x
```

## Step 2: Select Agent Backend

NiuBot needs an agent backend to power conversations. There are two options:
- **Built-in**: `claude` (Claude Code CLI), `codex` (OpenAI Codex CLI), or `traecli` (Trae CLI)
- **Custom plugin**: any CLI tool, integrated via a JS plugin file

**Ask the user**: "Do you want to use a built-in backend (claude / codex / traecli), or do you have a custom agent CLI to integrate?"

### Option A: Built-in Backend

Check which CLIs are available:

```bash
claude --version   # Check Claude CLI
codex --version    # Check Codex CLI
traecli --version  # Check Trae CLI
```

If at least one is available, note which one the user wants to use (e.g. `claude`). Before writing config, also ask whether they want to set a separate `liteModel` for cheaper background tasks. Proceed to [Step 2.1](#step-21-generate-config).

If neither is available, tell the user to install one first:
- Claude CLI: https://docs.anthropic.com/en/docs/claude-code
- Codex CLI: https://github.com/openai/codex

### Option B: Custom Backend Plugin

If the user has their own coding agent CLI, help them create a plugin.

#### 1. Create the plugin file

Create `~/.niubot/backends/<name>.js`. The plugin extends `CliAgentBackend` and implements 4 methods:

```js
// ~/.niubot/backends/my-agent.js
import { CliAgentBackend, buildNiubotEnv } from "niubot/plugin";

export default class MyAgentBackend extends CliAgentBackend {
  constructor(options = {}) {
    super("my-agent");
  }

  command() { return "my-agent-cli"; }

  buildSession(config) {
    return {
      workingDirectory: config.workingDirectory ?? process.cwd(),
      model: config.modelTier === "lite" ? (config.liteModel ?? config.model) : config.model,
      importantContext: config.importantContext,
      extraEnv: buildNiubotEnv(config),
      cumulativeBytes: 0,
      compactCount: 0,
      jsonlOffset: 0,
    };
  }

  buildInput(session, message) {
    const args = ["run", "--print"];
    if (session.model) args.push("--model", session.model);
    if (session.agentSessionId) args.push("--resume", session.agentSessionId);
    if (session.importantContext) args.push("--system", session.importantContext);
    return { args, stdin: message };
  }

  parseOutput(stdout, session) {
    return { text: stdout.trim() };
  }
}
```

Adapt `command()`, `buildInput()`, and `parseOutput()` to match the user's CLI tool. See [Plugin API Reference](#plugin-api-reference) for details.

#### 2. Verify the CLI is accessible

```bash
my-agent-cli --version   # Replace with actual command name
```

Then proceed to [Step 2.1](#step-21-generate-config) with backend name = the custom plugin name (e.g. `my-agent`).

### Step 2.1: Generate Config

Create the config directory and files:

```bash
mkdir -p ~/.niubot
```

Write `~/.niubot/config.yaml`:

Before filling the config, ask the user:
- **Bot ID**: default is `NiuBot`. This is immutable after setup — it determines the data directory (`~/.niubot/<id>/`) and default workspace (`~/niubot-workspace/<id>/`). If the user wants a different name, set it now.
- **Working directory**: where the agent runs. Default is `~/niubot-workspace/<id>`. Ask if they want a different path.
- **Model**: whether they want to pin a main `model` now, or keep the CLI default
- **Lite model**: whether they want to set a separate `liteModel` for cheaper background tasks

For built-in backends, if the user wants a `liteModel` but has no preference, suggest:
- `claude`: `haiku`
- `codex`: `gpt-5.4-mini`
- `traecli`: `Gemini-3-Flash-Preview`

**For built-in backend** (e.g. `claude`):
```yaml
bots:
  - id: NiuBot
    backend: claude
    appId: ""
    appSecret: ""
    # model: ""
    # liteModel: ""
    # workingDirectory: ~/niubot-workspace/NiuBot
```

**For custom backend** (e.g. `my-agent`):
```yaml
backends:
  my-agent:
    plugin: "./backends/my-agent.js"

bots:
  - id: NiuBot
    backend: my-agent
    appId: ""
    appSecret: ""
    # model: ""
    # liteModel: ""
    # workingDirectory: ~/niubot-workspace/NiuBot
```

Config fields:
- `id`: Unique bot identifier (immutable). Determines data directory (`~/.niubot/<id>/`) and default workspace (`~/niubot-workspace/<id>/`). **Do not change after setup.**
- `backend`: Agent backend to use (required). Built-in: `claude`, `codex`, or `traecli`. Custom: the name registered under `backends:`.
- `model`: Main model for conversations. Omit to use the CLI's default.
- `liteModel`: Cheaper model for background tasks (archive summaries). Omit = same as main model.
  Recommended examples for built-in backends:
  - `claude`: `haiku`
  - `codex`: `gpt-5.4-mini`
  - `traecli`: `Gemini-3-Flash-Preview`
- `workingDirectory`: Where the agent runs. Default: `~/niubot-workspace/<id>`.

Create default persona file:

```bash
mkdir -p ~/.niubot/NiuBot
```

Write `~/.niubot/NiuBot/persona.md`:
```markdown
> This file defines the bot's personality. Admins can ask the bot to modify it.

## Role
None

## Style
Keep conversations natural and friendly.
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

## Plugin API Reference

NiuBot supports custom agent backends via plugins. A plugin is a JS file that extends `CliAgentBackend` and implements 4 required methods. The engine handles process management, cancellation, session resume, and all infrastructure — the plugin only defines how to talk to a specific CLI tool.

### Import

```js
import { CliAgentBackend, buildNiubotEnv } from "niubot/plugin";
```

### Required Methods

| Method | Purpose |
|--------|---------|
| `command()` | Returns the CLI executable name (e.g. `"my-agent"`) |
| `buildSession(config)` | Create initial session state from `SessionConfig`. Must return an object extending `BaseCliSession` |
| `buildInput(session, message)` | Build CLI invocation: returns `{ args: string[], stdin?: string }`. `args` = CLI arguments. `stdin` = content to write to child process stdin (omit to not write). `session.agentSessionId` is set automatically on resume |
| `parseOutput(stdout, session)` | Parse CLI stdout -> `{ text, agentSessionId?, contextTokens?, model? }`. Has access to session for advanced use cases (e.g. reading log files) |

### Optional Overrides

| Property/Method | Default | Purpose |
|----------------|---------|---------|
| `supportsSystemPrompt` | `false` | Set to `true` if the CLI can accept a system prompt |
| `checkAvailable()` | `exec(command(), ["--version"])` | Custom availability check |
| `agentEnv()` | `{}` | Extra environment variables for the CLI process |

### BaseCliSession Fields

Every session returned by `buildSession()` must include:

```js
{
  workingDirectory: string,    // from config.workingDirectory
  model: string | undefined,   // resolved model ID
  importantContext: string,    // system prompt content
  agentSessionId: string,     // auto-managed by base class (for resume)
  extraEnv: Record<string, string>,  // use buildNiubotEnv(config)
  cumulativeBytes: 0,
  compactCount: 0,
  jsonlOffset: 0,
}
```

### ParsedOutput Fields

`parseOutput()` must return at minimum `{ text }`. Optional fields:

```js
{
  text: string,                // required: the agent's response text
  agentSessionId?: string,     // session ID for resume (auto-stored by base class)
  contextTokens?: number,      // token count (shown in footer)
  contextWindow?: number,      // model context window size
  model?: string,              // model name (shown in footer)
  compactCount?: number,       // context compaction count
}
```

### Config Registration

```yaml
# ~/.niubot/config.yaml
backends:
  my-agent:
    plugin: "./backends/my-agent.js"    # relative to ~/.niubot/
    options:                            # optional, passed to constructor
      timeout: 30000

bots:
  - id: NiuBot
    backend: my-agent
```

Model configuration for custom backends works the same way — set `model` and `liteModel` on the bot entry. The values are passed to `buildSession()` via `config.model` and `config.liteModel`. These recommendation values are documentation only, not runtime defaults.

After adding the plugin, use `/agent` in chat to verify it appears in the list. To switch: `/agent my-agent`. No engine restart required.
