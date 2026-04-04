# agents.md

Instructions for AI coding agents working on this codebase.

## Project Overview

NiuBot Engine is a TypeScript AI persona runtime that bridges IM platforms (Feishu) with AI coding agents. It uses SQLite for persistence and a per-chat message queue for buffering/merging.

## Tech Stack

- **Language**: TypeScript (ES2022, Node16 module resolution, strict mode)
- **Runtime**: Node.js >= 20
- **IM SDK**: `@larksuiteoapi/node-sdk` (Feishu/Lark)
- **Database**: `better-sqlite3` (SQLite with WAL mode)
- **Build**: `tsc` → `dist/`
- **Test**: `vitest`

## Commands

```bash
npm run dev        # Run with tsx (development)
npm run build      # Compile TypeScript
npm start          # Run compiled output
npm test           # Run tests
npm run test:watch # Watch mode tests
```

## Architecture

The system has three layers connected by interfaces:

1. **IM Layer** (`src/im/`): `PlatformAdapter` interface. Currently only Feishu. Normalizes platform-specific events into `NormalizedMessage`.

2. **Core Layer** (`src/core/`):
   - `Pipeline`: orchestration hub — routes messages, manages sessions, persists to DB
   - `MessageQueue`: per-chat buffering with cancel+merge logic

3. **Agent Layer** (`src/agent/`): `AgentBackend` interface. Currently CLI-based (Claude Code).

4. **Database** (`src/database/`): SQLite with `users`, `chats`, `sessions`, `messages` tables + FTS5.

## Key Patterns

- **ESM with `.js` extensions**: All imports use `.js` extensions (required by Node16 module resolution). Example: `import { foo } from './bar.js'`
- **Interface-driven**: `PlatformAdapter` and `AgentBackend` are swappable. Don't couple core logic to specific implementations.
- **Structured logging**: Use `createLogger('module-name')` from `logger.ts`. Output is JSON lines.
- **ID generation**: Users get `u1, u2, ...`, chats get `c1, c2, ...`, sessions get `s_<timestamp>_<uuid8>`. IDs are generated via SQL MAX+1 in transactions.
- **Graceful shutdown**: `SIGINT`/`SIGTERM` → stop IM → drain queue → cancel active sessions (15s deadline) → stop agent → close DB.

## Code Conventions

- No classes where plain functions suffice, but current code uses classes for stateful components (Pipeline, MessageQueue, CliAgentBackend, FeishuAdapter)
- Error handling: log and continue for non-critical paths (e.g., reaction failures); crash for unrecoverable errors (e.g., agent process exit)
- Config: environment variables override YAML file values
- Database operations use explicit transactions for multi-step writes
