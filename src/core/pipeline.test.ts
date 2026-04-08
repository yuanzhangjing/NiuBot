import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { AgentBackend, AgentResponse, AgentSession, SessionConfig } from "../agent/types.js";
import { initDatabase, loadPersistedBotBackend, setBotRuntimeBackend } from "../database/schema.js";
import type { PlatformAdapter } from "../im/types.js";
import { Pipeline, type BotIdentity } from "./pipeline.js";

class RecordingAgent implements AgentBackend {
  supportsSystemPrompt = true;
  readonly createSessionCalls: SessionConfig[] = [];

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async createSession(config: SessionConfig): Promise<AgentSession> {
    this.createSessionCalls.push(config);
    return { id: `agent_${this.createSessionCalls.length}` };
  }

  async sendMessage(): Promise<AgentResponse> {
    return { text: "" };
  }

  async cancelSession(): Promise<void> {}
  async closeSession(): Promise<void> {}
}

function createImStub(): PlatformAdapter {
  return {
    onMessage() {},
    async start() {},
    async stop() {},
    async sendText() { return "pmid"; },
    async sendReply() { return "pmid"; },
    async sendMarkdownCard() { return "pmid"; },
    async sendCard() { return "pmid"; },
    async replyCard() { return "pmid"; },
    async editMessage() {},
    async addReaction() {},
    async removeReaction() {},
    async sendFile() { return "pmid"; },
    async getBotOpenId() { return "bot-open-id"; },
    async getBotName() { return "NiuBot"; },
    async getChatName() { return "Admin"; },
    async getMessageContent() { return undefined; },
    async getAppCreatorId() { return undefined; },
  };
}

function createBotIdentity(): BotIdentity {
  return {
    name: "NiuBot",
    platform: "feishu",
    platformBotId: "bot-open-id",
  };
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Pipeline.recover", () => {
  test("does not recover active sessions when the stored backend is missing", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    db.prepare(`
      INSERT INTO users (id, name, platform, platform_id)
      VALUES ('u2', 'admin', 'feishu', 'user-open-id')
    `).run();
    db.prepare(`
      INSERT INTO chats (id, type, platform, platform_id, user_id)
      VALUES ('c1', 'p2p', 'feishu', 'chat-open-id', 'user-open-id')
    `).run();
    db.prepare(`
      INSERT INTO sessions (id, chat_id, user_id, status, agent_session_id, backend_type, last_active_at)
      VALUES ('s1', 'c1', 'u2', 'active', 'legacy-session-id', NULL, datetime('now'))
    `).run();

    const agent = new RecordingAgent();
    const pipeline = new Pipeline(
      db,
      createImStub(),
      agent,
      createBotIdentity(),
      dir,
      path.join(dir, "niubot.db"),
      0,
      0,
      "claude",
    );

    await pipeline.recover();

    const row = db.prepare(
      "SELECT status, agent_session_id, backend_type FROM sessions WHERE id = 's1'",
    ).get() as { status: string; agent_session_id: string | null; backend_type: string | null };

    expect(agent.createSessionCalls).toHaveLength(0);
    expect(row).toEqual({
      status: "archived",
      agent_session_id: null,
      backend_type: null,
    });
  });

  test("does not recover active sessions from a different backend", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    db.prepare(`
      INSERT INTO users (id, name, platform, platform_id)
      VALUES ('u2', 'admin', 'feishu', 'user-open-id')
    `).run();
    db.prepare(`
      INSERT INTO chats (id, type, platform, platform_id, user_id)
      VALUES ('c1', 'p2p', 'feishu', 'chat-open-id', 'user-open-id')
    `).run();
    db.prepare(`
      INSERT INTO sessions (id, chat_id, user_id, status, agent_session_id, backend_type, last_active_at)
      VALUES ('s1', 'c1', 'u2', 'active', 'codex-thread-id', 'codex', datetime('now'))
    `).run();

    const agent = new RecordingAgent();
    const pipeline = new Pipeline(
      db,
      createImStub(),
      agent,
      createBotIdentity(),
      dir,
      path.join(dir, "niubot.db"),
      0,
      0,
      "claude",
    );

    await pipeline.recover();

    const row = db.prepare(
      "SELECT status, agent_session_id, backend_type FROM sessions WHERE id = 's1'",
    ).get() as { status: string; agent_session_id: string | null; backend_type: string | null };

    expect(agent.createSessionCalls).toHaveLength(0);
    expect(row).toEqual({
      status: "archived",
      agent_session_id: null,
      backend_type: "codex",
    });
  });

  test("reuses agent session ids when the stored backend matches", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    db.prepare(`
      INSERT INTO users (id, name, platform, platform_id)
      VALUES ('u2', 'admin', 'feishu', 'user-open-id')
    `).run();
    db.prepare(`
      INSERT INTO chats (id, type, platform, platform_id, user_id)
      VALUES ('c1', 'p2p', 'feishu', 'chat-open-id', 'user-open-id')
    `).run();
    db.prepare(`
      INSERT INTO sessions (id, chat_id, user_id, status, agent_session_id, backend_type, last_active_at)
      VALUES ('s1', 'c1', 'u2', 'active', 'claude-session-id', 'claude', datetime('now'))
    `).run();

    const agent = new RecordingAgent();
    const pipeline = new Pipeline(
      db,
      createImStub(),
      agent,
      createBotIdentity(),
      dir,
      path.join(dir, "niubot.db"),
      0,
      0,
      "claude",
    );

    await pipeline.recover();

    expect(agent.createSessionCalls).toHaveLength(1);
    expect(agent.createSessionCalls[0]?.agentSessionId).toBe("claude-session-id");
  });

  test("persists the current backend after a successful switch", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const pipeline = new Pipeline(
      db,
      createImStub(),
      new RecordingAgent(),
      createBotIdentity(),
      dir,
      path.join(dir, "niubot.db"),
      0,
      0,
      "claude",
      async () => new RecordingAgent(),
    );

    (pipeline as any).handleAgentCommand(["codex"], "c1", "chat-open-id");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const row = db.prepare(
      "SELECT backend_type FROM bot_runtime_state WHERE bot_name = ?",
    ).get("NiuBot") as { backend_type: string } | undefined;

    expect(row?.backend_type).toBe("codex");
  });

  test("loads the persisted backend for startup recovery", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const dbPath = path.join(dir, "niubot.db");
    const db = initDatabase(dbPath);
    setBotRuntimeBackend(db, "NiuBot", "codex");
    db.close();

    expect(loadPersistedBotBackend(dbPath, "NiuBot")).toBe("codex");
  });

  test("persists claude when switching to the claude backend", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const pipeline = new Pipeline(
      db,
      createImStub(),
      new RecordingAgent(),
      createBotIdentity(),
      dir,
      path.join(dir, "niubot.db"),
      0,
      0,
      "codex",
      async () => new RecordingAgent(),
    );

    (pipeline as any).handleAgentCommand(["claude"], "c1", "chat-open-id");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const row = db.prepare(
      "SELECT backend_type FROM bot_runtime_state WHERE bot_name = ?",
    ).get("NiuBot") as { backend_type: string } | undefined;

    expect(row?.backend_type).toBe("claude");
  });
});
