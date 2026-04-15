# NiuBot

AI Persona Runtime — let AI agents live in your IM with memory, personality, and full autonomy.

NiuBot connects coding agents (Claude Code, Codex, or your own) to Feishu (Lark), turning them into persistent team members that remember conversations, manage tasks, and develop their own style.

## Install

### Let your coding agent handle it

First install:

```bash
npm install -g niubot
```

Then copy this prompt to your coding agent (Claude Code, Cursor, etc.):

```
Help me install and configure NiuBot.
Read the INSTALL.md in the niubot package for step-by-step instructions.
```

The agent reads INSTALL.md, follows the steps, and only asks you when it needs input (Feishu credentials, backend choice, etc.).

### Or do it yourself

```bash
npm install -g niubot
niubot init
```

The interactive wizard walks you through everything: backend detection, Feishu app setup, credential input, and startup. No docs needed.

### From GitHub Release

```bash
npm install -g https://github.com/yuanzhangjing/NiuBot/releases/download/v0.1.0/niubot-0.1.0.tgz
```

## What it does

- **Multi-backend** — Claude Code, Codex, or any CLI tool via a ~25-line plugin
- **Memory** — per-user memories, session summaries, searchable message history
- **Persona** — personality file that admins (and the bot itself) can edit
- **Tasks** — built-in task management with per-user visibility
- **Multi-bot** — run multiple bots from one config, each with its own identity
- **Scheduled tasks** — cron-based recurring or one-time automation

## Service management

```bash
niubot start            # Start
niubot stop             # Stop
niubot status           # Check status
niubot start --restart  # Restart
```

## Prerequisites

- Node.js >= 18
- Feishu enterprise app with Bot capability
- Agent backend: `claude` CLI, `codex` CLI, or custom plugin

## Custom backend plugin

NiuBot can wrap any CLI-based coding agent. See [INSTALL.md](./INSTALL.md#plugin-api-reference) for the plugin API.

## License

Apache-2.0
