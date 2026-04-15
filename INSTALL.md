# NiuBot Installation Guide

This guide is written for coding agents (Claude, Codex, etc.) to follow when helping a user install and configure NiuBot. Each step includes commands, expected output, and what to do on failure.

## Prerequisites

- Node.js >= 18
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
  ✓ Node.js vXX.X.X (>= 18 required)
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
   - `im:resource` — Resources (image/file upload and download)
   - `im:chat:readonly` — Read group chat info
   - `application:application:readonly` — Read app info (optional, for auto-detecting admin from app creator)
4. On the **Bot** page, enable the **Bot** capability
5. Publish the app: Create a version → Submit for review → Release

## Step 4: Configure Credentials

Edit `~/.niubot/config.yaml` and fill in the Feishu app credentials and model configuration:

```yaml
bots:
  - name: NiuBot
    appId: "cli_xxxxxxxxxx"       # ← App ID from Step 3
    appSecret: "xxxxxxxxxxxxxxxx" # ← App Secret from Step 3
    model: ""                     # ← Main model (e.g. claude-sonnet-4-5-20250514). Omit to use CLI default
    liteModel: ""                 # ← Lite model for archive summaries (e.g. haiku). Omit = same as main
    # workingDirectory: ~/niubot-workspace/NiuBot  # agent working directory (default: ~/niubot-workspace/<name>)
```

- `name`: Internal identifier. Determines data directory (`~/.niubot/<name>/`) and default workspace (`~/niubot-workspace/<name>/`). **Do not change after initial setup** — renaming breaks data paths.
- `model`: The model used for all conversations. If not set, the agent CLI decides (e.g. Claude CLI uses its own default).
- `liteModel`: A cheaper/faster model used only for background tasks like archive summaries. If not set, falls back to the main model.
- `workingDirectory`: Where the agent runs commands, stores task files, and reads/writes project data. Default `~/niubot-workspace/<name>`.

Admin is auto-detected — no manual configuration needed:
1. If `application:application:readonly` permission is granted, the Feishu app creator becomes **owner** on startup.
2. Otherwise, the first user to send a private message to the bot becomes **owner**.

There are two admin levels:
- **owner**: full control, can manage other admins via `/admin add|remove`. Cannot be removed.
- **admin**: has admin commands (/agent, /restart, shell), but cannot manage other admins.

Admin status is persisted in the database and survives restarts. Owner can manage admins in chat:
- `/admin` — list current admins and their roles
- `/admin add @user` — add an admin (owner only)
- `/admin remove @user` — remove an admin (owner only, cannot remove owner)

## Step 5: Configure Persona (optional)

Edit `~/.niubot/NiuBot/persona.md` to customize the bot's personality:

```markdown
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

## Custom Backend Plugin

NiuBot supports custom agent backends via plugins. A plugin is a JS file that extends `CliAgentBackend` and implements 4 required methods. The engine handles process management, cancellation, session resume, and all infrastructure — the plugin only defines how to talk to a specific CLI tool.

### Plugin API

Import from `niubot/plugin`:

```js
import { CliAgentBackend, buildNiubotEnv } from "niubot/plugin";
```

### Required Methods (4)

| Method | Purpose |
|--------|---------|
| `command()` | Returns the CLI executable name (e.g. `"my-agent"`) |
| `buildSession(config)` | Create initial session state from `SessionConfig`. Must return an object extending `BaseCliSession` |
| `buildInput(session, message)` | Build CLI invocation: returns `{ args: string[], stdin?: string }`. `args` = CLI arguments. `stdin` = content to write to the child process stdin (omit to not write; set `stdin: message` to pass user message via stdin). `session.agentSessionId` is set automatically on resume |
| `parseOutput(stdout, session)` | Parse CLI stdout → `{ text, agentSessionId?, contextTokens?, model? }`. Has access to session for advanced use cases (e.g. reading log files) |

### Optional Overrides

| Property/Method | Default | Purpose |
|----------------|---------|---------|
| `supportsSystemPrompt` | `false` | Set to `true` if the CLI can accept a system prompt |
| `checkAvailable()` | `exec(command(), ["--version"])` | Custom availability check (most CLIs support `--version`, so the default works) |
| `agentEnv()` | `{}` | Extra environment variables for the CLI process |

### BaseCliSession Fields

Every session must include these fields (the base class requires them):

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
  agentSessionId?: string,     // session ID for resume (base class stores it automatically)
  contextTokens?: number,      // token count (shown in footer)
  contextWindow?: number,      // model context window size
  model?: string,              // model name (shown in footer)
  compactCount?: number,       // context compaction count
}
```

### Minimal Example

A stateless agent that wraps a CLI tool with simple text I/O (~25 lines):

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
    return { args, stdin: message };  // pass user message via stdin
  }

  parseOutput(stdout, session) {
    return { text: stdout.trim() };
  }
}
```

### Register in Config

```yaml
# ~/.niubot/config.yaml
backends:
  my-agent:
    plugin: "./backends/my-agent.js"    # relative to ~/.niubot/
    options:                            # optional, passed to constructor
      timeout: 30000

default_config:
  backend: my-agent                     # use as default, or switch at runtime via /agent
```

Model configuration for custom backends works the same way — set `model` and `liteModel` on the bot entry. The values are passed to `buildSession()` via `config.model` and `config.liteModel`.

### Verify

After adding the plugin, use the `/agent` command in chat to see it in the list. No engine restart required — the plugin is discovered dynamically from config.yaml.

To switch: `/agent my-agent`

If the plugin file has errors (missing methods, import failures), the error message will include the specific issue and file path in the engine log.
