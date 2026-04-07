# NiuBot Engine

AI Persona Runtime — powering autonomous digital coworkers with memory and personality.

NiuBot Engine bridges IM platforms with AI coding agents. It's not a chatbot framework — it's a **persona runtime** where an AI agent lives as an independent team member: receiving messages, thinking, writing code, and replying, all autonomously.

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
ClaudeCliBackend       ← claude -p --input-format stream-json (default)
 or AcpBackend         ← ACP protocol (for other agents)
    ↓
SQLite                 ← users, chats, sessions, messages (FTS)
```

**Key design decisions:**
- **Interface-driven**: IM adapter and agent backend are swappable via interfaces
- **Per-chat message queue**: buffers rapid messages, cancels+merges when agent is busy briefly, queues when agent is in a long task
- **Session persistence**: SQLite tracks users, chats, sessions, and all messages with FTS search
- **Session recovery**: on startup, restores active sessions from DB and recreates backend sessions

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
| `agent.backend` | `NIUBOT_BACKEND` | `claude-code` | Agent backend type |
| `database.path` | `NIUBOT_DB_PATH` | `~/.niubot/niubot.db` | SQLite database path |
| `queue.bufferMs` | `NIUBOT_BUFFER_MS` | `3000` | Message merge window (ms) |
| `queue.cancelThresholdMs` | `NIUBOT_CANCEL_MS` | `10000` | Cancel+merge threshold (ms) |

## Project Structure

```
src/
├── index.ts              # Entry point, lifecycle management
├── config.ts             # Config loading (yaml + env)
├── persona.ts            # Persona file loading
├── logger.ts             # Structured JSON logger
├── core/
│   ├── pipeline.ts       # Central orchestration hub
│   ├── queue.ts          # Per-chat message buffering
│   ├── routing.ts        # Session routing decisions
│   ├── prompts.ts        # System prompt templates
│   └── cron.ts           # Scheduled task execution
├── agent/
│   ├── types.ts          # AgentBackend interface
│   ├── cli-base.ts       # Base class for CLI-based backends
│   └── claude-cli/
│       └── backend.ts    # Claude Code CLI (stream-json mode)
├── im/
│   ├── types.ts          # PlatformAdapter interface
│   ├── render.ts         # YAML message rendering
│   └── feishu/
│       └── adapter.ts    # Feishu (Lark) adapter
├── memory/
│   ├── inject.ts         # Context injection (static + important + normal)
│   ├── chat-summary.ts   # Chat summary CRUD
│   └── user-memory.ts    # User memory CRUD
├── database/
│   └── schema.ts         # SQLite schema + migrations
├── cli/                  # niubot CLI tools (messages, contacts, task, cron, send)
└── summarizer/
    └── index.ts          # Auto chat summary generation
```

## Roadmap

- **M1**: Scaffold + E2E (Feishu ↔ Claude Code) ✅
- **M2**: Memory system (user_memory + chat_memory) ✅
- **M3**: Context autonomy engine (routing, archive, recall) ✅
- **M4**: Persona + polish + capability alignment ✅
- **Next**: Multi-bot support, session-less cursor model

## License

Apache-2.0
