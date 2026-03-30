# NiuBot

AI Persona Runtime — an autonomous digital coworker with memory and personality.

NiuBot bridges IM platforms with AI coding agents via [ACP (Agent Client Protocol)](https://agentclientprotocol.org/). It's not a chatbot framework — it's a **persona runtime** where an AI agent lives as an independent team member: receiving messages, thinking, writing code, and replying, all autonomously.

## Architecture

```
Feishu (WebSocket)
    ↓
FeishuAdapter          ← IM layer (swappable)
    ↓
Pipeline               ← orchestration: session mgmt, DB persistence
    ↓
MessageQueue           ← buffer, merge, cancel+requeue
    ↓
AcpBackend             ← agent layer (swappable)
    ↓
ACP subprocess         ← claude-code-acp or compatible
    ↓
SQLite                 ← users, chats, sessions, messages (FTS)
```

**Key design decisions:**
- **Interface-driven**: IM adapter and agent backend are swappable via interfaces
- **Per-chat message queue**: buffers rapid messages, cancels+merges when agent is busy briefly, queues when agent is in a long task
- **Session persistence**: SQLite tracks users, chats, sessions, and all messages with FTS search
- **Crash recovery**: on startup, marks stale `active` sessions as `aborted`

## Quick Start

```bash
# Install dependencies
npm install

# Configure (pick one)
export FEISHU_APP_ID="your-app-id"
export FEISHU_APP_SECRET="your-app-secret"
# or edit config/default.yaml

# Run
npm run dev
```

Requires Node.js >= 20 and a Feishu app with WebSocket event subscription enabled.

## Configuration

Config is loaded from `config/default.yaml` with environment variable overrides:

| Key | Env Var | Default | Description |
|-----|---------|---------|-------------|
| `feishu.appId` | `FEISHU_APP_ID` | — | Feishu app ID (required) |
| `feishu.appSecret` | `FEISHU_APP_SECRET` | — | Feishu app secret (required) |
| `agent.command` | — | `npx -y @zed-industries/claude-agent-acp` | ACP server command |
| `agent.workingDirectory` | — | `.` | Agent working directory |
| `agent.permissionMode` | — | `autoApprove` | `autoApprove` (ACP generic) or `bypass` (Claude Code) |
| `database.path` | — | `./niubot.db` | SQLite database path |
| `queue.bufferMs` | — | `3000` | Message merge window (ms) |
| `queue.cancelThresholdMs` | — | `10000` | Cancel+merge threshold (ms) |

## Project Structure

```
src/
├── index.ts              # Entry point, lifecycle management
├── config.ts             # Config loading (yaml + env)
├── logger.ts             # Structured JSON logger
├── core/
│   ├── pipeline.ts       # Central orchestration hub
│   └── queue.ts          # Per-chat message buffering
├── agent/
│   ├── types.ts          # AgentBackend interface
│   └── acp/
│       └── backend.ts    # ACP implementation
├── im/
│   ├── types.ts          # PlatformAdapter interface
│   └── feishu/
│       └── adapter.ts    # Feishu (Lark) adapter
└── database/
    └── schema.ts         # SQLite schema + helpers
```

## Roadmap

- **M1**: Scaffold + E2E (Feishu ↔ ACP ↔ Claude Code) ← current
- **M2**: Memory system (user_memory + chat_memory)
- **M3**: Context autonomy engine (core differentiator)
- **M4**: Persona + polish → open source

## License

Apache-2.0
