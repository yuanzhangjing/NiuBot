# NiuBot

NiuBot connects coding agents to Feishu so they can work as persistent bots instead of one-off chat sessions.

It can receive and send messages in IM, keep context, manage tasks, run scheduled jobs, and follow a configurable persona. You can plug in Claude Code, Codex, or your own CLI agent and let it keep working in private chats or group chats.

Core capabilities:

- connect an agent to Feishu as a chat bot
- store user memory, session summaries, and message history
- support multiple bots, multiple backends, and custom plugins
- expose built-in CLI tools for tasks, contacts, messages, and cron jobs
- let admins continuously adjust the bot persona through files

## Prompt for Your Agent

Send the following prompt to your coding agent:

```text
Install and configure NiuBot for me.

Install @yuanzhangjing/niubot if it is not installed yet.
Then read the INSTALL.md inside the package and follow it end to end.

Requirements:
- complete installation, configuration, initialization, startup, and verification
- ask me only when user action is strictly required, especially Feishu app creation, permissions, App ID, and App Secret
- prefer built-in backends if available; otherwise explain what is missing
- after setup, verify the bot can start cleanly and tell me what was configured

Do not give me a summary of the docs first. Just perform the setup.
```

## License

Apache-2.0
