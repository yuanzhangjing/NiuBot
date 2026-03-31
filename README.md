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
AgentBackend           ← agent layer (swappable)
    ↓
ClaudeCliBackend       ← claude -p (default, supports system prompt)
 or AcpBackend         ← ACP protocol (for other agents)
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

# Configure (~/.niubot/.env)
mkdir -p ~/.niubot
cat > ~/.niubot/.env << 'EOF'
FEISHU_APP_ID=your-app-id
FEISHU_APP_SECRET=your-app-secret
EOF

# Set agent working directory (~/.niubot/config.yaml)
cat > ~/.niubot/config.yaml << 'EOF'
agent:
  workingDirectory: "~/workspace/your-project"
EOF

# Run
npm run dev
```

Requires Node.js >= 20 and a Feishu app with WebSocket event subscription enabled.

## Configuration

All config lives in `~/.niubot/` (override via `NIUBOT_HOME` env var):

```
~/.niubot/
├── .env            ← secrets (FEISHU_APP_ID, FEISHU_APP_SECRET)
├── config.yaml     ← settings
└── niubot.db       ← database (auto-created)
```

| Key | Env Var | Default | Description |
|-----|---------|---------|-------------|
| `feishu.appId` | `FEISHU_APP_ID` | — | Feishu app ID (**required**) |
| `feishu.appSecret` | `FEISHU_APP_SECRET` | — | Feishu app secret (**required**) |
| `agent.workingDirectory` | `NIUBOT_WORK_DIR` | — | Agent working directory (**required**) |
| `agent.backend` | `NIUBOT_BACKEND` | `claude-code` | `claude-code` or `claude-code-acp` |
| `database.path` | `NIUBOT_DB_PATH` | `~/.niubot/niubot.db` | SQLite database path |
| `queue.bufferMs` | `NIUBOT_BUFFER_MS` | `3000` | Message merge window (ms) |
| `queue.cancelThresholdMs` | `NIUBOT_CANCEL_MS` | `10000` | Cancel+merge threshold (ms) |

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
│   ├── claude-cli/
│   │   └── backend.ts    # Claude Code CLI (-p mode)
│   └── acp/
│       └── backend.ts    # ACP protocol implementation
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
