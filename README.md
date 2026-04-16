# NiuBot

NiuBot 把 coding agent 接进飞书，让它不只是一次性的聊天窗口，而是一个能长期工作的 bot。

它能在 IM 里收消息、回消息、记住上下文、维护任务、跑定时任务，也能按人格配置说话。你可以把 Claude Code、Codex，或者你自己的 CLI agent 挂进去，让它在群聊或私聊里持续工作。

核心能力：

- 把 agent 接到飞书，变成可对话的 bot
- 保存用户记忆、会话摘要和消息记录
- 支持多 bot、多 backend、自定义插件
- 提供任务、联系人、消息、定时任务等内置 CLI
- 允许管理员通过人格文件持续调整 bot 风格

## Prompt for Your Agent

把下面这段话直接发给你的 coding agent：

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

## More

- Agent installation and setup guide: [INSTALL.md](./INSTALL.md)
- Custom backend plugin API: [INSTALL.md](./INSTALL.md#plugin-api-reference)

## Release

For maintainers, publish with:

```bash
npm run release -- patch
```

You can replace `patch` with `minor` or `major`.

The release script will:

- require a clean git worktree
- run `npm run release:check`
- create the new npm version and matching `vX.Y.Z` git tag
- publish to npm
- push the current branch and tags with `--follow-tags`
- verify the published version on npm

## License

Apache-2.0
